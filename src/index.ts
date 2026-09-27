import express from "express";
import dotenv from "dotenv";
import { classifyEmail, executeAgent } from "./agents/executor";

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

// In-memory storage
const offices: { [key: number]: { id: number; name: string } } = {};
const tasks: { [key: number]: { id: number; office_id: number; agent_type: string; content: string; response?: string; status: string } } = {};
const conversations: { [key: string]: any[] } = {};

let officeIdCounter = 1;
let taskIdCounter = 1;

// Middleware
app.use(express.json());

// Health check
app.get("/health", (req, res) => {
  res.json({ status: "✓ Pulpo running", timestamp: new Date().toISOString() });
});

// Create office
app.post("/offices", (req, res) => {
  const { name } = req.body;
  const id = officeIdCounter++;
  offices[id] = { id, name };
  res.json({ id, name });
});

// Classify email and create task
app.post("/classify", async (req, res) => {
  const { officeId, emailContent } = req.body;

  try {
    const classification = await classifyEmail(emailContent);
    const taskId = taskIdCounter++;
    
    tasks[taskId] = {
      id: taskId,
      office_id: officeId,
      agent_type: classification.agent,
      content: emailContent,
      status: "pending"
    };

    res.json({
      taskId,
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
    const task = tasks[id];

    if (!task) {
      return res.status(404).json({ error: "Task not found" });
    }

    const response = await executeAgent(
      task.office_id,
      task.agent_type,
      task.content
    );

    tasks[id].status = "completed";
    tasks[id].response = response;

    res.json({ taskId: id, response });
  } catch (error) {
    res.status(500).json({ error: String(error) });
  }
});

// Get conversation history
app.get("/offices/:officeId/conversations/:agentType", (req, res) => {
  const { officeId, agentType } = req.params;
  const key = `${officeId}_${agentType}`;
  res.json(conversations[key] || []);
});

// Start server
app.listen(PORT, () => {
  console.log(`✓ Pulpo server running on http://localhost:${PORT}`);
});
