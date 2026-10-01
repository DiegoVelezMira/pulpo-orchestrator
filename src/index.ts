import express from "express";
import path from "path";
import dotenv from "dotenv";
import Database from "better-sqlite3";
import { classifyEmail, executeAgent } from "./agents/executor";
import { initializeDatabase } from "./database/schema";
import {
  seedDirectives,
  getDirective,
  listDirectives,
  setDirective,
} from "./agents/directives";
import { addLearning, listLearnings, formatLearningsForPrompt } from "./agents/learnings";
import { getAuthUrl, handleOAuthCallback, getConnection } from "./services/gmail";
import { getDriveContextForOffice } from "./services/drive";
import { startGmailPoller } from "./services/poller";
import {
  listClients,
  getOrCreateClient,
  insertFinancialRecords,
  generateIncomeExpenseReport,
  seedDemoFinancialData,
} from "./services/reporting";
import {
  getLegalConfig,
  setLegalConfig,
  upsertComplianceFacts,
  getComplianceFacts,
  runComplianceChecks,
  runComplianceChecksForOffice,
  listComplianceFlags,
} from "./services/legal";
import { getSiigoConfig, setSiigoConfig, runDianComplianceChecks, listDianInvoiceFlags } from "./services/siigo";

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

// Persistent SQLite storage
const DB_PATH = process.env.DATABASE_PATH || "./pulpo.db";
const db = new Database(DB_PATH);
initializeDatabase(db);
seedDirectives(db);
console.log(`✓ Database ready at ${DB_PATH}`);

// Middleware
app.use(express.json());

// Interfaz web mínima (archivos estáticos en /public)
app.use(express.static(path.join(__dirname, "..", "public")));

// Health check
app.get("/health", (req, res) => {
  res.json({ status: "✓ Pulpo running", timestamp: new Date().toISOString() });
});

// List offices
app.get("/offices", (req, res) => {
  const rows = db.prepare("SELECT * FROM offices ORDER BY id DESC").all();
  res.json(rows);
});

// Create office
app.post("/offices", (req, res) => {
  const { name } = req.body;
  const info = db.prepare("INSERT INTO offices (name) VALUES (?)").run(name);
  res.json({ id: info.lastInsertRowid, name });
});

// List tasks for an office
app.get("/offices/:officeId/tasks", (req, res) => {
  const { officeId } = req.params;
  const rows = db
    .prepare("SELECT * FROM tasks WHERE office_id = ? ORDER BY id DESC")
    .all(officeId);
  res.json(rows);
});

// --- Directivas: el texto que gobierna a cada agente, editable sin redeploy ---

// List all directives
app.get("/directives", (req, res) => {
  res.json(listDirectives(db));
});

// Get one directive
app.get("/directives/:agentType", (req, res) => {
  res.json({ agent_type: req.params.agentType, content: getDirective(db, req.params.agentType) });
});

// Update (or create) a directive
app.put("/directives/:agentType", (req, res) => {
  const { content } = req.body;
  if (!content || !content.trim()) {
    return res.status(400).json({ error: "content requerido" });
  }
  setDirective(db, req.params.agentType, content);
  res.json({ agent_type: req.params.agentType, content });
});

// --- Aprendizajes: memoria persistente que se inyecta en futuras ejecuciones ---

// Add a learning
app.post("/learnings", (req, res) => {
  const { agentType, content, officeId } = req.body;
  if (!agentType || !content || !content.trim()) {
    return res.status(400).json({ error: "agentType y content son requeridos" });
  }
  addLearning(db, agentType, content, officeId);
  res.json({ ok: true });
});

// List learnings for an agent type (optionally scoped to an office)
app.get("/learnings/:agentType", (req, res) => {
  const officeId = req.query.officeId ? Number(req.query.officeId) : undefined;
  res.json(listLearnings(db, req.params.agentType, officeId));
});

// Classify email and create task
app.post("/classify", async (req, res) => {
  const { officeId, emailContent } = req.body;

  if (!emailContent || !emailContent.trim()) {
    return res.status(400).json({ error: "emailContent vacío" });
  }

  // Reutilizar antes que recrear: si ya existe una tarea idéntica completada
  // en la misma oficina, no vale la pena gastar otra llamada al LLM.
  const existing = db
    .prepare(
      "SELECT * FROM tasks WHERE office_id = ? AND content = ? AND status = 'completed' ORDER BY id DESC LIMIT 1"
    )
    .get(officeId, emailContent) as { id: number; agent_type: string; response: string } | undefined;

  if (existing) {
    return res.json({
      taskId: existing.id,
      agent: existing.agent_type,
      confidence: 1,
      reused: true,
    });
  }

  try {
    const directive = getDirective(db, "pulpo");
    const classification = await classifyEmail(emailContent, directive);

    const info = db
      .prepare(
        "INSERT INTO tasks (office_id, agent_type, content, status, needs_drive_context, needs_approval, ticket_type, urgency) VALUES (?, ?, ?, 'pending', ?, ?, ?, ?)"
      )
      .run(
        officeId,
        classification.agent,
        emailContent,
        classification.needsDriveContext ? 1 : 0,
        classification.needsApproval ? 1 : 0,
        classification.ticketType,
        classification.urgency
      );

    res.json({
      taskId: info.lastInsertRowid,
      agent: classification.agent,
      confidence: classification.confidence,
      needsDriveContext: classification.needsDriveContext,
      needsApproval: classification.needsApproval,
      ticketType: classification.ticketType,
      urgency: classification.urgency,
    });
  } catch (error) {
    res.status(500).json({ error: String(error) });
  }
});

// Execute task with agent
app.post("/tasks/:taskId/execute", async (req, res) => {
  const { taskId } = req.params;
  const id = parseInt(taskId);

  try {
    const task = db.prepare("SELECT * FROM tasks WHERE id = ?").get(id) as
      | {
          id: number;
          office_id: number;
          agent_type: string;
          content: string;
          needs_drive_context: number;
          needs_approval: number;
        }
      | undefined;

    if (!task) {
      return res.status(404).json({ error: "Task not found" });
    }

    const directive = getDirective(db, task.agent_type);
    const learnings = listLearnings(db, task.agent_type, task.office_id) as { content: string }[];
    let systemPrompt = directive + formatLearningsForPrompt(learnings);

    // Bloque 2: solo se consulta Drive cuando el clasificador lo marcó.
    if (task.needs_drive_context) {
      const office = db.prepare("SELECT name FROM offices WHERE id = ?").get(task.office_id) as
        | { name: string }
        | undefined;
      if (office) {
        const driveContext = await getDriveContextForOffice(db, task.office_id, office.name);
        if (driveContext) {
          systemPrompt += `\n\n--- Contexto de Drive (oficina: ${office.name}) ---\n${driveContext}`;
          db.prepare("UPDATE tasks SET drive_context = ? WHERE id = ?").run(driveContext, id);
        }
      }
    }

    const response = await executeAgent(task.office_id, task.agent_type, task.content, systemPrompt);

    // Bloque 4: una tarea completada no siempre queda cerrada. Si el
    // clasificador marcó needs_approval, queda 'completed' pero con
    // approval_status='pending' — visible en el panel de aprobaciones hasta
    // que alguien la apruebe o la rechace. Si no, approval_status queda NULL:
    // se auto-resuelve, como hasta ahora.
    const approvalStatus = task.needs_approval ? "pending" : null;
    db.prepare("UPDATE tasks SET status = 'completed', response = ?, approval_status = ? WHERE id = ?").run(
      response,
      approvalStatus,
      id
    );

    res.json({ taskId: id, response, needsApproval: Boolean(task.needs_approval) });
  } catch (error) {
    // Empujar el fallo a un estado determinista y consultable, en vez de
    // perderlo en un 500 transitorio: la tarea queda visible como 'failed'
    // con el motivo, lista para reintentar o revisar.
    db.prepare("UPDATE tasks SET status = 'failed', response = ? WHERE id = ?").run(String(error), id);
    res.status(500).json({ taskId: id, status: "failed", error: String(error) });
  }
});

// --- Gmail: cada oficina conecta su propia cuenta (Bloque 1 del plan de oficina autónoma) ---

// Paso 1: el navegador de quien administra la oficina entra aquí y lo mandamos a Google
app.get("/offices/:officeId/gmail/connect", (req, res) => {
  const officeId = parseInt(req.params.officeId);
  try {
    const url = getAuthUrl(officeId);
    res.redirect(url);
  } catch (error) {
    res.status(500).json({ error: String(error) });
  }
});

// Paso 2: Google redirige de vuelta aquí con el código de autorización
app.get("/gmail/oauth/callback", async (req, res) => {
  const { code, state, error: oauthError } = req.query;

  if (oauthError) {
    return res.status(400).send(`Autorización cancelada o rechazada: ${oauthError}`);
  }
  if (!code || typeof code !== "string" || !state || typeof state !== "string") {
    return res.status(400).send("Falta el código de autorización o el office id (state).");
  }

  const officeId = parseInt(state);

  try {
    const { email } = await handleOAuthCallback(db, code, officeId);
    res.send(
      `✓ Gmail conectado: ${email} quedó vinculado a la oficina ${officeId}. Pulpo empezará a leer esta bandeja en el próximo ciclo de polling (cada 5 min). Puedes cerrar esta ventana.`
    );
  } catch (error) {
    res.status(500).send(`Error conectando Gmail: ${String(error)}`);
  }
});

// Estado de la conexión de una oficina
app.get("/offices/:officeId/gmail/status", (req, res) => {
  const officeId = parseInt(req.params.officeId);
  const conn = getConnection(db, officeId);
  res.json(
    conn
      ? { connected: true, email: conn.email_address }
      : { connected: false }
  );
});

// Get conversation history
app.get("/offices/:officeId/conversations/:agentType", (req, res) => {
  const { officeId, agentType } = req.params;

  const row = db
    .prepare("SELECT messages FROM conversations WHERE office_id = ? AND agent_type = ? ORDER BY id DESC LIMIT 1")
    .get(officeId, agentType) as { messages: string } | undefined;

  res.json(row ? JSON.parse(row.messages) : []);
});

// --- Bloque 4: Aprobaciones ---
// Patrón de aprobación selectiva: una tarea completada queda auto-resuelta
// (approval_status NULL) o pendiente de revisión humana (approval_status
// 'pending'), según lo que decidió el clasificador al crearla (needs_approval,
// ver executor.ts). Solo lo segundo necesita que alguien mire el panel.

// Aprobaciones pendientes de una oficina
app.get("/offices/:officeId/approvals", (req, res) => {
  const { officeId } = req.params;
  const rows = db
    .prepare(
      "SELECT * FROM tasks WHERE office_id = ? AND approval_status = 'pending' ORDER BY id DESC"
    )
    .all(officeId);
  res.json(rows);
});

// Aprobar una tarea: su respuesta queda validada
app.post("/tasks/:taskId/approve", (req, res) => {
  const id = parseInt(req.params.taskId);
  const task = db.prepare("SELECT id FROM tasks WHERE id = ?").get(id);
  if (!task) return res.status(404).json({ error: "Task not found" });

  db.prepare(
    "UPDATE tasks SET approval_status = 'approved', approved_at = CURRENT_TIMESTAMP WHERE id = ?"
  ).run(id);
  res.json({ taskId: id, approval_status: "approved" });
});

// Rechazar una tarea: queda marcada para retrabajo, con nota opcional de por qué
app.post("/tasks/:taskId/reject", (req, res) => {
  const id = parseInt(req.params.taskId);
  const { note } = req.body;
  const task = db.prepare("SELECT id FROM tasks WHERE id = ?").get(id);
  if (!task) return res.status(404).json({ error: "Task not found" });

  db.prepare(
    "UPDATE tasks SET approval_status = 'rejected', approval_note = ?, approved_at = CURRENT_TIMESTAMP WHERE id = ?"
  ).run(note || null, id);
  res.json({ taskId: id, approval_status: "rejected" });
});

// --- Administrativo extendido: bandeja de tickets con auto-triage ---
// Mismo mecanismo que needsDriveContext/needsApproval: el clasificador
// decide ticket_type y urgency en la misma llamada (ver executor.ts), y
// esta bandeja los expone ordenados por urgencia para que la oficina
// priorice sin tener que leer tarea por tarea. Solo tiene sentido real
// para tareas agent_type='administrativo', pero no se filtra por eso a
// nivel de endpoint — el query param type ya permite acotar si hace falta.

// Bandeja de tickets de una oficina, ordenada por urgencia (5→1) y luego
// por antigüedad. Filtros opcionales: ?type=reclamo&status=pending
app.get("/offices/:officeId/tickets", (req, res) => {
  const officeId = parseInt(req.params.officeId);
  const { type, status } = req.query;

  let query = "SELECT * FROM tasks WHERE office_id = ? AND agent_type = 'administrativo'";
  const params: any[] = [officeId];

  if (typeof type === "string" && type.trim()) {
    query += " AND ticket_type = ?";
    params.push(type.trim());
  }
  if (typeof status === "string" && status.trim()) {
    query += " AND status = ?";
    params.push(status.trim());
  }

  query += " ORDER BY urgency DESC, id ASC";

  const rows = db.prepare(query).all(...params);
  res.json(rows);
});

// Vincular un ticket a un cliente existente de la oficina (match manual
// por ahora — no hay matching automático por remitente todavía).
app.post("/tasks/:taskId/link-client", (req, res) => {
  const id = parseInt(req.params.taskId);
  const { clientId } = req.body;
  const task = db.prepare("SELECT id FROM tasks WHERE id = ?").get(id);
  if (!task) return res.status(404).json({ error: "Task not found" });

  db.prepare("UPDATE tasks SET client_id = ? WHERE id = ?").run(clientId || null, id);
  res.json({ taskId: id, clientId: clientId || null });
});

// --- Bloque 3: Reportería ---
// Plantilla Ingresos/Gastos, genérica por diseño (ver reporting.ts):
// agrupa por código PUC, nunca por texto libre ni por nombre de cliente
// hardcodeado, así que el mismo código sirve para Diana o para cualquier
// oficina que se conecte después.

// Clientes de una oficina
app.get("/offices/:officeId/clients", (req, res) => {
  const officeId = parseInt(req.params.officeId);
  res.json(listClients(db, officeId));
});

app.post("/offices/:officeId/clients", (req, res) => {
  const officeId = parseInt(req.params.officeId);
  const { name } = req.body;
  if (!name || !name.trim()) {
    return res.status(400).json({ error: "name requerido" });
  }
  res.json(getOrCreateClient(db, officeId, name.trim()));
});

// Carga de movimientos contables (ingesta real futura: Drive, CSV, DIAN...
// todas convergen aquí, ya mapeadas a account_code del PUC).
app.post("/offices/:officeId/clients/:clientId/financial-records", (req, res) => {
  const officeId = parseInt(req.params.officeId);
  const clientId = parseInt(req.params.clientId);
  const { records } = req.body;

  if (!Array.isArray(records) || records.length === 0) {
    return res.status(400).json({ error: "records debe ser un array no vacío" });
  }

  try {
    const inserted = insertFinancialRecords(db, officeId, clientId, records);
    res.json({ inserted });
  } catch (error) {
    res.status(500).json({ error: String(error) });
  }
});

// Mientras Diana no tenga histórico cargado, esto genera 7 meses de datos
// plausibles (marcados source='demo') para poder construir y validar la
// plantilla sin esperar. Se puede volver a llamar para regenerar.
app.post("/offices/:officeId/demo-data/seed", (req, res) => {
  const officeId = parseInt(req.params.officeId);
  const { clientName } = req.body;
  try {
    const result = seedDemoFinancialData(db, officeId, clientName);
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: String(error) });
  }
});

// Reporte Ingresos/Gastos para un cliente en un rango de fechas
// (?from=YYYY-MM-DD&to=YYYY-MM-DD). Si no se pasan, usa el mes en curso.
app.get("/offices/:officeId/clients/:clientId/reports/ingresos-gastos", (req, res) => {
  const officeId = parseInt(req.params.officeId);
  const clientId = parseInt(req.params.clientId);

  const now = new Date();
  const defaultFrom = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-01`;
  const defaultTo = now.toISOString().slice(0, 10);

  const from = typeof req.query.from === "string" ? req.query.from : defaultFrom;
  const to = typeof req.query.to === "string" ? req.query.to : defaultTo;

  try {
    const report = generateIncomeExpenseReport(db, officeId, clientId, from, to);
    if (!report) {
      return res.status(404).json({ error: "Cliente no encontrado en esta oficina" });
    }
    res.json(report);
  } catch (error) {
    res.status(500).json({ error: String(error) });
  }
});

// --- Legal: compliance checks mecánicos (primer incremento) ---
// Determinísticos, no pasan por Claude — ver legal.ts. Deliberadamente sin
// nada que dependa de la DIAN todavía; eso queda para una vez se defina
// el acceso a esas APIs.

// Config legal de la oficina (SMLV y umbrales). Tiene defaults razonables
// (SMLV 2026), no hace falta llamarlo si no se quiere personalizar.
app.get("/offices/:officeId/legal/config", (req, res) => {
  const officeId = parseInt(req.params.officeId);
  res.json(getLegalConfig(db, officeId));
});

app.put("/offices/:officeId/legal/config", (req, res) => {
  const officeId = parseInt(req.params.officeId);
  const { smlv, rutUpdateThresholdDays, aportesGraceDays } = req.body;
  const updated = setLegalConfig(db, officeId, {
    ...(smlv !== undefined ? { smlv: Number(smlv) } : {}),
    ...(rutUpdateThresholdDays !== undefined ? { rut_update_threshold_days: Number(rutUpdateThresholdDays) } : {}),
    ...(aportesGraceDays !== undefined ? { aportes_grace_days: Number(aportesGraceDays) } : {}),
  });
  res.json(updated);
});

// Hechos de compliance de un cliente — lo que la oficina ya sabe o
// registra manualmente, base para correr los chequeos mecánicos.
app.get("/offices/:officeId/clients/:clientId/compliance-facts", (req, res) => {
  const officeId = parseInt(req.params.officeId);
  const clientId = parseInt(req.params.clientId);
  res.json(getComplianceFacts(db, officeId, clientId) || null);
});

app.post("/offices/:officeId/clients/:clientId/compliance-facts", (req, res) => {
  const officeId = parseInt(req.params.officeId);
  const clientId = parseInt(req.params.clientId);
  const { rutFechaActualizacion, aportesFechaUltimoPago, salarioMinimoEmpleado } = req.body;
  const facts = upsertComplianceFacts(db, officeId, clientId, {
    ...(rutFechaActualizacion !== undefined ? { rut_fecha_actualizacion: rutFechaActualizacion } : {}),
    ...(aportesFechaUltimoPago !== undefined ? { aportes_fecha_ultimo_pago: aportesFechaUltimoPago } : {}),
    ...(salarioMinimoEmpleado !== undefined ? { salario_minimo_empleado: Number(salarioMinimoEmpleado) } : {}),
  });
  res.json(facts);
});

// Corre los chequeos: de un cliente puntual (clientId en el body), o de
// toda la oficina si no se pasa. Reemplaza las flags anteriores con el
// estado actual — no se acumulan.
app.post("/offices/:officeId/legal/run-checks", (req, res) => {
  const officeId = parseInt(req.params.officeId);
  const { clientId } = req.body;
  try {
    const flags = clientId
      ? runComplianceChecks(db, officeId, parseInt(clientId))
      : runComplianceChecksForOffice(db, officeId);
    res.json({ flagsDetected: flags.length, flags });
  } catch (error) {
    res.status(500).json({ error: String(error) });
  }
});

// Flags de compliance activas de toda la oficina, ordenadas por severidad.
app.get("/offices/:officeId/legal/flags", (req, res) => {
  const officeId = parseInt(req.params.officeId);
  res.json(listComplianceFlags(db, officeId));
});

// --- Legal: integración DIAN vía Siigo (segundo incremento) ---
// GET nunca devuelve access_key, mismo criterio que /gmail/status con los
// tokens OAuth.
app.get("/offices/:officeId/siigo/config", (req, res) => {
  const officeId = parseInt(req.params.officeId);
  const config = getSiigoConfig(db, officeId);
  res.json({
    office_id: config.office_id,
    connected: Boolean(config.username && config.access_key),
    username: config.username,
    partner_id: config.partner_id,
    invoice_lookback_days: config.invoice_lookback_days,
    rejected_status_values: config.rejected_status_values,
  });
});

app.put("/offices/:officeId/siigo/config", (req, res) => {
  const officeId = parseInt(req.params.officeId);
  const { username, accessKey, partnerId, invoiceLookbackDays, rejectedStatusValues } = req.body;
  const updated = setSiigoConfig(db, officeId, {
    ...(username !== undefined ? { username } : {}),
    ...(accessKey !== undefined ? { access_key: accessKey } : {}),
    ...(partnerId !== undefined ? { partner_id: partnerId } : {}),
    ...(invoiceLookbackDays !== undefined ? { invoice_lookback_days: Number(invoiceLookbackDays) } : {}),
    ...(rejectedStatusValues !== undefined ? { rejected_status_values: rejectedStatusValues } : {}),
  });
  res.json({
    office_id: updated.office_id,
    connected: Boolean(updated.username && updated.access_key),
    username: updated.username,
    partner_id: updated.partner_id,
    invoice_lookback_days: updated.invoice_lookback_days,
    rejected_status_values: updated.rejected_status_values,
  });
});

app.post("/offices/:officeId/siigo/run-checks", async (req, res) => {
  const officeId = parseInt(req.params.officeId);
  try {
    const flags = await runDianComplianceChecks(db, officeId);
    res.json({ flagsDetected: flags.length, flags });
  } catch (error) {
    res.status(500).json({ error: String(error) });
  }
});

app.get("/offices/:officeId/siigo/flags", (req, res) => {
  const officeId = parseInt(req.params.officeId);
  res.json(listDianInvoiceFlags(db, officeId));
});

// Start server
app.listen(PORT, () => {
  console.log(`✓ Pulpo server running on http://localhost:${PORT}`);
  startGmailPoller(db);
});
