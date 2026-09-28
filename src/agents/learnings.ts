import Database from "better-sqlite3";

// Memoria de aprendizajes persistente por tipo de agente (y opcionalmente
// por oficina). Cada aprendizaje se inyecta como contexto adicional en el
// prompt del agente la próxima vez que ejecuta una tarea del mismo tipo,
// para que el sistema no repita los mismos errores entre ejecuciones.

export function addLearning(
  db: Database.Database,
  agentType: string,
  content: string,
  officeId?: number
) {
  db.prepare(
    "INSERT INTO learnings (agent_type, office_id, content) VALUES (?, ?, ?)"
  ).run(agentType, officeId ?? null, content);
}

export function listLearnings(
  db: Database.Database,
  agentType: string,
  officeId?: number,
  limit: number = 10
) {
  return db
    .prepare(
      `SELECT id, agent_type, office_id, content, created_at
       FROM learnings
       WHERE agent_type = ? AND (office_id IS NULL OR office_id = ?)
       ORDER BY created_at DESC
       LIMIT ?`
    )
    .all(agentType, officeId ?? null, limit);
}

export function formatLearningsForPrompt(
  learnings: { content: string }[]
): string {
  if (!learnings.length) return "";
  const lines = learnings.map((l) => `- ${l.content}`).join("\n");
  return `\n\nAprendizajes previos relevantes (aplícalos si corresponde):\n${lines}`;
}
