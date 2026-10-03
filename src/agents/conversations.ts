import Database from "better-sqlite3";

// Historial de conversación por (office_id, agent_type): una sola fila que
// se reemplaza completa en cada turno de executeAgent, igual al patrón
// "retain" de Hindsight (document_id = sesión → upsert reemplaza la versión
// anterior, nunca se acumulan duplicados). A diferencia de `learnings`
// (notas sueltas que un humano agrega a mano y se acumulan), esto es el
// historial crudo de mensajes que ya se intercambiaron con el agente para
// esa oficina — se escribe solo, nunca por un endpoint manual.

export type ConversationMessage = {
  role: "user" | "assistant";
  content: string;
  created_at: string;
};

export function getConversationMessages(
  db: Database.Database,
  officeId: number,
  agentType: string
): ConversationMessage[] {
  const row = db
    .prepare("SELECT messages FROM conversations WHERE office_id = ? AND agent_type = ?")
    .get(officeId, agentType) as { messages: string } | undefined;

  if (!row) return [];
  try {
    return JSON.parse(row.messages);
  } catch {
    // Fila corrupta o de un formato anterior: mejor arrancar de cero que
    // reventar la ejecución del agente por un historial ilegible.
    return [];
  }
}

// Agrega un turno (tarea + respuesta del agente) al historial existente y
// reemplaza la fila completa — no inserta una fila nueva por turno. Esto es
// lo que mantiene "una sola fila por (office_id, agent_type)" en vez de
// dejar crecer la tabla indefinidamente con una fila por ejecución.
export function appendConversationTurn(
  db: Database.Database,
  officeId: number,
  agentType: string,
  userContent: string,
  assistantContent: string
): ConversationMessage[] {
  const existing = getConversationMessages(db, officeId, agentType);
  const now = new Date().toISOString();
  const updated: ConversationMessage[] = [
    ...existing,
    { role: "user", content: userContent, created_at: now },
    { role: "assistant", content: assistantContent, created_at: now },
  ];

  db.prepare(
    `INSERT INTO conversations (office_id, agent_type, messages, updated_at)
     VALUES (?, ?, ?, CURRENT_TIMESTAMP)
     ON CONFLICT(office_id, agent_type) DO UPDATE SET
       messages = excluded.messages,
       updated_at = CURRENT_TIMESTAMP`
  ).run(officeId, agentType, JSON.stringify(updated));

  return updated;
}
