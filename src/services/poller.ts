import Database from "better-sqlite3";
import { classifyEmail, executeAgent } from "../agents/executor";
import { getDirective } from "../agents/directives";
import { listLearnings, formatLearningsForPrompt } from "../agents/learnings";
import { listConnectedOffices, fetchNewMessages, markProcessed, touchLastPolled } from "./gmail";
import { getDriveContextForOffice } from "./drive";

const POLL_INTERVAL_MS = 5 * 60 * 1000; // cada 5 minutos, como pidiÃ³ Diego

// Corre exactamente el mismo camino que ya usa /classify + /tasks/:id/execute
// (mismo dedup, mismo guard clause, misma persistencia de fallos) para que
// un correo entrante se comporte igual que una tarea creada por API.
async function processOfficeInbox(db: Database.Database, officeId: number) {
  const conn = listConnectedOffices(db).find((c) => c.office_id === officeId);
  if (!conn) return;

  let emails;
  try {
    emails = await fetchNewMessages(db, conn);
  } catch (error) {
    console.error(`â Gmail poll fallÃ³ para office ${officeId}:`, String(error));
    return;
  }

  for (const email of emails) {
    const emailContent = `De: ${email.from}\nAsunto: ${email.subject}\n\n${email.body}`;

    try {
      const existing = db
        .prepare(
          "SELECT id, agent_type FROM tasks WHERE office_id = ? AND content = ? AND status = 'completed' ORDER BY id DESC LIMIT 1"
        )
        .get(officeId, emailContent) as { id: number; agent_type: string } | undefined;

      if (existing) {
        markProcessed(db, officeId, email.gmailMessageId, existing.id);
        console.log(`âº Reusado (office ${officeId}): "${email.subject}" â tarea ${existing.id}`);
        continue;
      }

      const directive = getDirective(db, "pulpo");
      const classification = await classifyEmail(emailContent, directive);

      const info = db
        .prepare(
          "INSERT INTO tasks (office_id, agent_type, content, status, needs_drive_context) VALUES (?, ?, ?, 'pending', ?)"
        )
        .run(officeId, classification.agent, emailContent, classification.needsDriveContext ? 1 : 0);
      const taskId = Number(info.lastInsertRowid);

      const agentDirective = getDirective(db, classification.agent);
      const learnings = listLearnings(db, classification.agent, officeId) as { content: string }[];
      let systemPrompt = agentDirective + formatLearningsForPrompt(learnings);

      // Bloque 2: solo se consulta Drive cuando el propio clasificador
      // determinÃ³ que el correo lo amerita.
      if (classification.needsDriveContext) {
        const office = db.prepare("SELECT name FROM offices WHERE id = ?").get(officeId) as
          | { name: string }
          | undefined;
        if (office) {
          const driveContext = await getDriveContextForOffice(db, officeId, office.name);
          if (driveContext) {
            systemPrompt += `\n\n--- Contexto de Drive (oficina: ${office.name}) ---\n${driveContext}`;
            db.prepare("UPDATE tasks SET drive_context = ? WHERE id = ?").run(driveContext, taskId);
            console.log(`ð Drive: contexto inyectado para tarea ${taskId} (office ${officeId})`);
          }
        }
      }

      try {
        const response = await executeAgent(officeId, classification.agent, emailContent, systemPrompt);
        db.prepare("UPDATE tasks SET status = 'completed', response = ? WHERE id = ?").run(response, taskId);
        console.log(`â Procesado (office ${officeId}): "${email.subject}" â ${classification.agent} (tarea ${taskId})`);
      } catch (execError) {
        db.prepare("UPDATE tasks SET status = 'failed', response = ? WHERE id = ?").run(String(execError), taskId);
        console.error(`â EjecuciÃ³n fallÃ³ (office ${officeId}, tarea ${taskId}):`, String(execError));
      }

      markProcessed(db, officeId, email.gmailMessageId, taskId);
    } catch (error) {
      // Si algo revienta antes de crear la tarea, igual marcamos el correo
      // como procesado para no reintentarlo en loop cada 5 minutos; queda
      // en el log para revisiÃ³n manual.
      markProcessed(db, officeId, email.gmailMessageId);
      console.error(`â Error procesando correo (office ${officeId}, msg ${email.gmailMessageId}):`, String(error));
    }
  }

  touchLastPolled(db, officeId);
}

export function startGmailPoller(db: Database.Database) {
  const tick = async () => {
    const offices = listConnectedOffices(db);
    for (const conn of offices) {
      await processOfficeInbox(db, conn.office_id);
    }
  };

  console.log(`â Gmail poller activo (cada ${POLL_INTERVAL_MS / 60000} min)`);
  // Primer ciclo casi inmediato (10s de margen para que el server termine de levantar),
  // y luego cada POLL_INTERVAL_MS.
  setTimeout(tick, 10_000);
  setInterval(tick, POLL_INTERVAL_MS);
}
