import Database from "better-sqlite3";
import { SYSTEM_PROMPTS } from "./prompts";

// Directivas: el texto que gobierna el comportamiento de cada agente.
// Viven en la tabla `directives` (persistente en el volumen de SQLite),
// no en el código, para poder ajustarlas sin necesidad de un redeploy.
// SYSTEM_PROMPTS en prompts.ts queda como el valor de fábrica usado para
// sembrar la tabla la primera vez y como respaldo si la tabla está vacía.

export function seedDirectives(db: Database.Database) {
  const insert = db.prepare(
    "INSERT OR IGNORE INTO directives (agent_type, content) VALUES (?, ?)"
  );
  for (const [agentType, content] of Object.entries(SYSTEM_PROMPTS)) {
    insert.run(agentType, content);
  }
}

export function getDirective(db: Database.Database, agentType: string): string {
  const row = db
    .prepare("SELECT content FROM directives WHERE agent_type = ?")
    .get(agentType) as { content: string } | undefined;

  if (row) return row.content;

  return (
    SYSTEM_PROMPTS[agentType as keyof typeof SYSTEM_PROMPTS] ||
    SYSTEM_PROMPTS.administrativo
  );
}

export function listDirectives(db: Database.Database) {
  return db
    .prepare("SELECT agent_type, content, updated_at FROM directives ORDER BY agent_type")
    .all();
}

export function setDirective(db: Database.Database, agentType: string, content: string) {
  db.prepare(
    `INSERT INTO directives (agent_type, content, updated_at)
     VALUES (?, ?, CURRENT_TIMESTAMP)
     ON CONFLICT(agent_type) DO UPDATE SET
       content = excluded.content,
       updated_at = CURRENT_TIMESTAMP`
  ).run(agentType, content);
}
