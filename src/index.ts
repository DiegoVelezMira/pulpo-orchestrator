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
      .prepare("INSERT INTO tasks (office_id, agent_type, content, status) VALUES (?, ?, ?, 'pending')")
      .run(officeId, classification.agent, emailContent);

    res.json({
      taskId: info.lastInsertRowid,
      agent: classification.agent,
      confidence: classification.confidence,
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
      | { id: number; office_id: number; agent_type: string; content: string }
      | undefined;

    if (!task) {
      return res.status(404).json({ error: "Task not found" });
    }

    const directive = getDirective(db, task.agent_type);
    const learnings = listLearnings(db, task.agent_type, task.office_id) as { content: string }[];
    const systemPrompt = directive + formatLearningsForPrompt(learnings);

    const response = await executeAgent(task.office_id, task.agent_type, task.content, systemPrompt);

    db.prepare("UPDATE tasks SET status = 'completed', response = ? WHERE id = ?").run(response, id);

    res.json({ taskId: id, response });
  } catch (error) {
    // Empujar el fallo a un estado determinista y consultable, en vez de
    // perderlo en un 500 transitorio: la tarea queda visible como 'failed'
    // con el motivo, lista para reintentar o revisar.
    db.prepare("UPDATE tasks SET status = 'failed', response = ? WHERE id = ?").run(String(error), id);
    res.status(500).json({ taskId: id, status: "failed", error: String(error) });
  }
});

// Get conversation history
app.get("/offices/:officeId/conversations/:agentType", (req, res) => {
  const { officeId, agentType } = req.params;

  const row = db
    .prepare("SELECT messages FROM conversations WHERE office_id = ? AND agent_type = ? ORDER BY id DESC LIMIT 1")
    .get(officeId, agentType) as { messages: string } | undefined;

  res.json(row ? JSON.parse(row.messages) : []);
});

// Start server
app.listen(PORT, () => {
  console.log(`✓ Pulpo server running on http://localhost:${PORT}`);
});
