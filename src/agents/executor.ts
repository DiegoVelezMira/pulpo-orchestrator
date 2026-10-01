import dotenv from "dotenv";
dotenv.config();
import axios from "axios";

const CLAUDE_API_KEY = process.env.CLAUDE_API_KEY;
console.log("API Key loaded:", CLAUDE_API_KEY ? "✓ Yes" : "✗ NO");
const CLAUDE_API_URL = "https://api.anthropic.com/v1/messages";

// Nota: los system prompts (directivas) ya NO viven hardcodeados aquí.
// Se leen de la tabla `directives` en SQLite (ver agents/directives.ts) y
// se reciben como parámetro, para poder ajustarlos sin redeploy y para
// poder inyectarles aprendizajes acumulados (ver agents/learnings.ts).

export async function classifyEmail(
  emailContent: string,
  systemPrompt: string
): Promise<{
  agent: string;
  confidence: number;
  // Bloque 2 (Drive): el propio clasificador decide si vale la pena ir a
  // buscar contexto en Drive para este correo — no se consulta Drive en
  // cada ejecución, solo "cuando el contenido del correo lo amerite"
  // (ej. menciona un documento, un cliente, una cuenta, pide un anexo).
  needsDriveContext: boolean;
  // Bloque 4 (Aprobaciones): mismo principio — el clasificador decide si
  // el resultado de esta tarea debe quedar pendiente de revisión humana
  // antes de darse por bueno, en vez de auto-resolverse en silencio.
  needsApproval: boolean;
  // Administrativo extendido: mismo principio otra vez — el clasificador
  // hace el triage de una vez, en la misma llamada, en vez de una segunda
  // pasada solo para tickets. Solo tiene significado real cuando
  // agent="administrativo"; para los demás agentes el clasificador igual
  // debe devolver algo (usa "otro"/2 por defecto) pero no se usa.
  ticketType: "factura" | "rut" | "datos" | "consulta" | "reclamo" | "otro";
  urgency: number; // 1 (baja) a 5 (urgente)
}> {
  // Atajo determinista: si no hay contenido real, no vale la pena gastar
  // una llamada al LLM — el resultado sería ruido de todas formas.
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
    // Remove markdown code blocks if present
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
    // Ante un fallo de clasificación, mejor pecar de cauteloso: se marca
    // pendiente de aprobación en vez de auto-resolverse sin haber podido
    // evaluar el riesgo real.
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
  officeId: number,
  agentType: string,
  taskContent: string,
  systemPrompt: string
): Promise<string> {
  if (!taskContent || !taskContent.trim()) {
    throw new Error("Tarea sin contenido: nada que ejecutar.");
  }

  try {
    const payload = {
      model: "claude-haiku-4-5-20251001",
      max_tokens: 1000,
      system: systemPrompt,
      messages: [
        {
          role: "user",
          content: taskContent,
        },
      ],
    };

    console.log("=== EXECUTING AGENT ===");
    console.log("Agent Type:", agentType);
    console.log("Office ID:", officeId);
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

    console.log("✓ Success - Response received");
    return response.data.content[0].text;
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
