import dotenv from "dotenv";
dotenv.config();
import axios from "axios";
import { SYSTEM_PROMPTS } from "./prompts";

const CLAUDE_API_KEY = process.env.CLAUDE_API_KEY;
console.log("API Key loaded:", CLAUDE_API_KEY ? "✓ Yes" : "✗ NO");
const CLAUDE_API_URL = "https://api.anthropic.com/v1/messages";

export async function classifyEmail(emailContent: string): Promise<{
  agent: string;
  confidence: number;
}> {
  try {
    const response = await axios.post(
      CLAUDE_API_URL,
      {
        model: "claude-haiku-4-5-20251001",
        max_tokens: 200,
        system: SYSTEM_PROMPTS.pulpo,
        messages: [
          {
            role: "user",
            content: `Clasifica este email y responde SOLO con JSON válido, sin markdown ni explicaciones:\n\n${emailContent}`,
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
    console.log("✓ Classification successful:", parsed);
    return parsed;
  } catch (error: any) {
    console.error("Classification error:", error.response?.status, error.response?.data || error.message);
    console.error("Raw text that failed to parse:", error.message);
    return { agent: "administrativo", confidence: 0.5 };
  }
}

export async function executeAgent(
  officeId: number,
  agentType: string,
  taskContent: string
): Promise<string> {
  try {
    const systemPrompt = SYSTEM_PROMPTS[agentType as keyof typeof SYSTEM_PROMPTS] || SYSTEM_PROMPTS.administrativo;

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
    console.log("Payload:", JSON.stringify(payload, null, 2));
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
