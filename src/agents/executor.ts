import dotenv from "dotenv";
dotenv.config();
import axios from "axios";
import Database from "better-sqlite3";
import { retain, recall, reflect, summarizeMemoryBank } from "../utils/memory-engine";

const CLAUDE_API_KEY = process.env.CLAUDE_API_KEY;
console.log("API Key loaded:", CLAUDE_API_KEY ? "✓ Yes" : "✗ NO");
const CLAUDE_API_URL = "https://api.anthropic.com/v1/messages";

/**
 * UPDATED EXECUTOR with Memory Bank integration
 * 
 * - Full classifyEmail with Drive/Approval/Urgency classification
 * - executeAgent with Recall/Retain/Reflect memory integration
 * - Maintains backward compatibility with systemPrompt injection for directives/learnings
 */

export async function classifyEmail(
  emailContent: string,
  systemPrompt: string
): Promise<{
  agent: string;
  confidence: number;
  needsDriveContext: boolean;
  needsApproval: boolean;
  ticketType: "factura" | "rut" | "datos" | "consulta" | "reclamo" | "otro";
  urgency: number;
}> {
  if (!emailContent || !emailContent.trim()) {
    console.log("⚠ Empty content, skipping LLM call");
    return {
      agent: "administrativo",
      confidence: 0,
      needsDriveContext: false,
      needsApproval: false,
      ticketType: "otro",
      urgency: 1,
    };
  }

  try {
    const response = await axios.post(
      CLAUDE_API_URL,
      {
        model: "claude-haiku-4-5-20251001",
        max_tokens: 200,
        system: systemPrompt,
        messages: [
          {
            role: "user",
            content: `Clasifica este email y responde SOLO con JSON válido, sin markdown ni explicaciones. El JSON debe tener exactamente estos campos: "agent" (string), "confidence" (número entre 0 y 1), "needsDriveContext" (booleano: true SOLO si resolver este correo probablemente requiere consultar documentos, contratos, estados financieros u otra información almacenada en el Drive de la oficina; false si el correo se puede resolver solo con su propio contenido), "needsApproval" (booleano: true SOLO si la respuesta que genere el agente tendrá una consecuencia real que amerita que un humano la revise antes de darla por buena — por ejemplo, algo que saldrá de la oficina hacia un tercero, compromete dinero, tiene implicación legal o tributaria, o la confianza de la clasificación es baja; false si es una consulta puramente interna, informativa o de bajo riesgo que se puede dar por resuelta automáticamente), "ticketType" (string, uno de "factura"|"rut"|"datos"|"consulta"|"reclamo"|"otro" — SOLO tiene sentido real cuando agent="administrativo": factura=solicitud o problema de facturación, rut=trámite o corrección de RUT, datos=actualización de datos del cliente, consulta=pregunta informativa, reclamo=queja o problema que requiere atención prioritaria; si agent no es "administrativo" usa "otro"), y "urgency" (número entero de 1 a 5, donde 5 es más urgente — considera plazos vencidos o por vencer, cliente visiblemente molesto, o dinero/cumplimiento en juego como señales de urgencia alta; si agent no es "administrativo" usa 2).\n\nEmail:\n${emailContent}`,
          },
        ],
      },
      {
        headers: {
          "x-api-key": CLAUDE_API_KEY,
          "anthropic-version": "2023-06-01",
          "content-type": "application/json",
        },
      }
    );

    let text = response.data.content[0].text.trim();
    if (text.startsWith("```")) {
      text = text.replace(/```json?\n?/g, "").replace(/```/g, "").trim();
    }

    const parsed = JSON.parse(text);
    parsed.needsDriveContext = Boolean(parsed.needsDriveContext);
    parsed.needsApproval = Boolean(parsed.needsApproval);
    const validTicketTypes = ["factura", "rut", "datos", "consulta", "reclamo", "otro"];
    parsed.ticketType = validTicketTypes.includes(parsed.ticketType) ? parsed.ticketType : "otro";
    const urgency = Number(parsed.urgency);
    parsed.urgency = Number.isFinite(urgency) ? Math.min(5, Math.max(1, Math.round(urgency))) : 2;
    console.log("✓ Classification successful:", parsed);
    return parsed;
  } catch (error: any) {
    console.error("Classification error:", error.response?.status, error.response?.data || error.message);
    console.error("Raw text that failed to parse:", error.message);
    return {
      agent: "administrativo",
      confidence: 0.5,
      needsDriveContext: false,
      needsApproval: true,
      ticketType: "otro",
      urgency: 3,
    };
  }
}

export async function executeAgent(
  db: Database.Database,
  officeId: number,
  taskId: number,
  agentType: string,
  taskContent: string,
  systemPrompt: string
): Promise<string> {
  if (!taskContent || !taskContent.trim()) {
    throw new Error("Tarea sin contenido: nada que ejecutar.");
  }

  try {
    // ===== STEP 1: RECALL =====
    // Get relevant context from this office's memory bank
    console.log(`\n📚 [RECALL] Fetching memory for office ${officeId}...`);
    const memoryContext = await recall(db, officeId, taskContent);

    // ===== STEP 2: EXECUTE =====
    // Build augmented system prompt with memory context + injected directives/learnings
    const memoryAugmentation = `
=== OFFICE MEMORY CONTEXT ===
${
  memoryContext.relevant_tax_rules
    ? `Tax Rules for this office:\n${memoryContext.relevant_tax_rules}\n`
    : ""
}
${
  memoryContext.relevant_patterns
    ? `Transaction Patterns for this office:\n${memoryContext.relevant_patterns}\n`
    : ""
}
${
  memoryContext.known_entities.length > 0
    ? `Known entities in this office:\n${memoryContext.known_entities.join(", ")}\n`
    : ""
}
${
  memoryContext.recent_similar_transactions.length > 0
    ? `Recent similar transactions:\n${JSON.stringify(memoryContext.recent_similar_transactions.slice(0, 3), null, 2)}\n`
    : ""
}

Use this context to make better decisions. If relevant, reference these facts.
=== END MEMORY CONTEXT ===
`;

    const augmentedSystemPrompt = `${systemPrompt}\n\n${memoryAugmentation}`;

    console.log(`🤖 [EXECUTE] Running ${agentType} agent with memory-augmented prompt...`);

    const payload = {
      model: "claude-haiku-4-5-20251001",
      max_tokens: 1000,
      system: augmentedSystemPrompt,
      messages: [
        {
          role: "user",
          content: taskContent,
        },
      ],
    };

    console.log("=== EXECUTING AGENT WITH MEMORY ===");
    console.log("Agent Type:", agentType);
    console.log("Office ID:", officeId);
    console.log("Task ID:", taskId);
    console.log("Task Content:", taskContent.substring(0, 100) + "...");
    console.log("API URL:", CLAUDE_API_URL);
    console.log("API Key present:", CLAUDE_API_KEY ? "✓ Yes" : "✗ NO");

    const response = await axios.post(CLAUDE_API_URL, payload, {
      headers: {
        "x-api-key": CLAUDE_API_KEY,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
    });

    const agentResponse = response.data.content[0].text;
    console.log(`✓ [EXECUTE] Agent completed successfully`);

    // ===== STEP 3: RETAIN =====
    // Extract facts from agent response and store in memory bank
    console.log(`💾 [RETAIN] Storing new facts in memory bank...`);
    await retain(db, officeId, taskId, agentType, agentResponse);

    // ===== STEP 4: REFLECT (Optional) =====
    // Periodically (every N tasks), synthesize facts into mental models
    const taskCount = (db
      .prepare("SELECT COUNT(*) as count FROM memory_units WHERE memory_bank_id = (SELECT id FROM memory_banks WHERE office_id = ?)")
      .get(officeId) as { count: number }).count;

    if (taskCount % 10 === 0) {
      console.log(`🧠 [REFLECT] Synthesizing knowledge (every 10 tasks)...`);
      await reflect(db, officeId);
    }

    return agentResponse;
  } catch (error: any) {
    console.error("❌ EXECUTION ERROR");
    console.error("Status:", error.response?.status);
    console.error("Status Text:", error.response?.statusText);
    console.error("Response Data:", JSON.stringify(error.response?.data, null, 2));
    console.error("Error Message:", error.message);
    if (error.response?.headers) {
      console.error("Response Headers:", error.response.headers);
    }
    throw error;
  }
}

/**
 * DEBUG: Show what the agent "remembers" about an office
 */
export function debugMemory(db: Database.Database, officeId: number): void {
  console.log("\n=== OFFICE MEMORY DEBUG ===");
  console.log(summarizeMemoryBank(db, officeId));
  console.log("===========================\n");
}
