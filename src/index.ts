import express from "express";
import path from "path";
import dotenv from "dotenv";
import Database from "better-sqlite3";
import { classifyEmail, executeAgent } from "./agents/executor";
import { initializeDatabase } from "./database/schema";

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

// Persistent SQLite storage
const DB_PATH = process.env.DATABASE_PATH || "./pulpo.db";
const db = new Database(DB_PATH);
initializeDatabase(db);
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

// Classify email and create task
app.post("/classify", async (req, res) => {
    const { officeId, emailContent } = req.body;

           try {
                 const classification = await classifyEmail(emailContent);

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

             const response = await executeAgent(task.office_id, task.agent_type, task.content);

             db.prepare("UPDATE tasks SET status = 'completed', response = ? WHERE id = ?").run(response, id);

             res.json({ taskId: id, response });
} catch (error) {
      res.status(500).json({ error: String(error) });
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
