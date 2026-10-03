import Database from "better-sqlite3";
import axios from "axios";

const CLAUDE_API_URL = "https://api.anthropic.com/v1/messages";
const CLAUDE_API_KEY = process.env.CLAUDE_API_KEY;

/**
 * MEMORY ENGINE - Hindsight pattern for Pulpo
 * Three core operations: Retain (ingest) → Recall (retrieve) → Reflect (synthesize)
 */

export interface MemoryBank {
  id: number;
  office_id: number;
  tax_rules_model: string | null;
  transaction_patterns_model: string | null;
  reconciliation_history_model: string | null;
  recent_transactions: string;
  entities: string;
  last_updated: string;
  transaction_count: number;
}

export interface MemoryContext {
  office_id: number;
  relevant_tax_rules: string;
  relevant_patterns: string;
  recent_similar_transactions: any[];
  known_entities: string[];
}

// ============================================================================
// RETAIN: Ingest new facts from agent responses
// ============================================================================

export async function retain(
  db: Database.Database,
  officeId: number,
  taskId: number,
  agentType: string,
  agentResponse: string
): Promise<void> {
  /**
   * After an agent executes, extract new facts and store them.
   * Claude does the extraction, we just store what it finds.
   */

  // Get or create memory bank for this office
  let bankId = db
    .prepare("SELECT id FROM memory_banks WHERE office_id = ?")
    .get(officeId) as { id: number } | undefined;

  if (!bankId) {
    db.prepare("INSERT INTO memory_banks (office_id) VALUES (?)").run(officeId);
    bankId = db
      .prepare("SELECT id FROM memory_banks WHERE office_id = ?")
      .get(officeId) as { id: number };
  }

  // Use Claude to extract facts from the agent response
  const extractionPrompt = `
    You are a fact extractor for accounting office memory.

    Agent Type: ${agentType}
    Agent Response: "${agentResponse}"

    Extract ONLY facts that should be remembered for future tasks in this office.
    Respond with ONLY valid JSON, no markdown, no explanation:

    {
      "tax_rules": ["string of extracted tax rules"],
      "patterns": ["string of extracted transaction patterns"],
      "entities": {"entity_name": "entity_description"},
      "transactions": [{"date": "YYYY-MM-DD", "amount": 0, "account": "", "description": ""}]
    }
  `;

  try {
    const response = await axios.post(
      CLAUDE_API_URL,
      {
        model: "claude-haiku-4-5-20251001",
        max_tokens: 500,
        messages: [{ role: "user", content: extractionPrompt }],
      },
      { headers: { "x-api-key": CLAUDE_API_KEY, "anthropic-version": "2023-06-01" } }
    );

    const extractedText = response.data.content[0].text.trim();
    const extracted = JSON.parse(extractedText);

    // Store each fact type
    if (extracted.tax_rules?.length) {
      extracted.tax_rules.forEach((rule: string) => {
        db.prepare(`
          INSERT INTO memory_units (memory_bank_id, fact_type, content, model_category, extracted_from_task_id)
          VALUES (?, 'tax_rule', ?, 'tax_rules', ?)
        `).run(bankId!.id, rule, taskId);
      });
    }

    if (extracted.patterns?.length) {
      extracted.patterns.forEach((pattern: string) => {
        db.prepare(`
          INSERT INTO memory_units (memory_bank_id, fact_type, content, model_category, extracted_from_task_id)
          VALUES (?, 'pattern', ?, 'patterns', ?)
        `).run(bankId!.id, pattern, taskId);
      });
    }

    if (extracted.entities) {
      const existing = db
        .prepare("SELECT entities FROM memory_banks WHERE id = ?")
        .get(bankId!.id) as { entities: string } | undefined;

      const merged = { ...JSON.parse(existing?.entities || "{}"), ...extracted.entities };
      db.prepare("UPDATE memory_banks SET entities = ? WHERE id = ?").run(
        JSON.stringify(merged),
        bankId!.id
      );
    }

    // Keep only last 50 transactions
    if (extracted.transactions?.length) {
      const existing = db
        .prepare("SELECT recent_transactions FROM memory_banks WHERE id = ?")
        .get(bankId!.id) as { recent_transactions: string } | undefined;

      let all = [...JSON.parse(existing?.recent_transactions || "[]"), ...extracted.transactions];
      all = all.slice(-50); // Keep only last 50

      db.prepare("UPDATE memory_banks SET recent_transactions = ? WHERE id = ?").run(
        JSON.stringify(all),
        bankId!.id
      );
    }

    console.log(`✓ Retained facts for office ${officeId}`);
  } catch (error) {
    console.error("❌ Retention failed:", error);
    // Don't throw — memory failure shouldn't break task execution
  }
}

// ============================================================================
// RECALL: Retrieve relevant context before executing agent
// ============================================================================

export async function recall(
  db: Database.Database,
  officeId: number,
  currentTask: string
): Promise<MemoryContext> {
  /**
   * Before agent executes, fetch relevant facts from memory bank.
   * Use Claude to decide what's relevant (semantic matching).
   */

  const bank = db
    .prepare("SELECT * FROM memory_banks WHERE office_id = ?")
    .get(officeId) as MemoryBank | undefined;

  if (!bank) {
    return {
      office_id: officeId,
      relevant_tax_rules: "",
      relevant_patterns: "",
      recent_similar_transactions: [],
      known_entities: [],
    };
  }

  // Get all facts for relevance matching
  const allFacts = db
    .prepare(
      "SELECT model_category, content FROM memory_units WHERE memory_bank_id = ? ORDER BY created_at DESC LIMIT 100"
    )
    .all(bank.id) as { model_category: string; content: string }[];

  if (allFacts.length === 0) {
    return {
      office_id: officeId,
      relevant_tax_rules: bank.tax_rules_model || "",
      relevant_patterns: bank.transaction_patterns_model || "",
      recent_similar_transactions: JSON.parse(bank.recent_transactions || "[]"),
      known_entities: Object.keys(JSON.parse(bank.entities || "{}")),
    };
  }

  // Use Claude to rank relevance
  const relevancePrompt = `
    Current task: "${currentTask}"

    Available facts:
    ${allFacts.map((f) => `[${f.model_category}] ${f.content}`).join("\n")}

    Return ONLY a JSON array of the 5 most relevant fact contents (or fewer if not applicable):
    ["fact1", "fact2", ...]
  `;

  try {
    const response = await axios.post(
      CLAUDE_API_URL,
      {
        model: "claude-haiku-4-5-20251001",
        max_tokens: 300,
        messages: [{ role: "user", content: relevancePrompt }],
      },
      { headers: { "x-api-key": CLAUDE_API_KEY, "anthropic-version": "2023-06-01" } }
    );

    const relevantText = response.data.content[0].text.trim();
    const relevant = JSON.parse(relevantText);

    return {
      office_id: officeId,
      relevant_tax_rules: relevant
        .filter((f: string) => allFacts.some((a) => a.model_category === "tax_rules" && a.content === f))
        .join("\n"),
      relevant_patterns: relevant
        .filter((f: string) => allFacts.some((a) => a.model_category === "patterns" && a.content === f))
        .join("\n"),
      recent_similar_transactions: JSON.parse(bank.recent_transactions || "[]").slice(-10),
      known_entities: Object.keys(JSON.parse(bank.entities || "{}")),
    };
  } catch (error) {
    console.error("❌ Recall failed:", error);
    // Fallback: return everything
    return {
      office_id: officeId,
      relevant_tax_rules: bank.tax_rules_model || "",
      relevant_patterns: bank.transaction_patterns_model || "",
      recent_similar_transactions: JSON.parse(bank.recent_transactions || "[]"),
      known_entities: Object.keys(JSON.parse(bank.entities || "{}")),
    };
  }
}

// ============================================================================
// REFLECT: Update mental models (synthesize knowledge)
// ============================================================================

export async function reflect(
  db: Database.Database,
  officeId: number
): Promise<void> {
  /**
   * Periodically (or on-demand), Claude synthesizes all recent facts into mental models.
   * This keeps the memory bank's high-level knowledge fresh without storing every fact.
   */

  const bank = db
    .prepare("SELECT id FROM memory_banks WHERE office_id = ?")
    .get(officeId) as { id: number } | undefined;

  if (!bank) return;

  // Get last 50 facts per category
  const taxRuleFacts = db
    .prepare(
      "SELECT content FROM memory_units WHERE memory_bank_id = ? AND model_category = 'tax_rules' ORDER BY created_at DESC LIMIT 50"
    )
    .all(bank.id) as { content: string }[];

  const patternFacts = db
    .prepare(
      "SELECT content FROM memory_units WHERE memory_bank_id = ? AND model_category = 'patterns' ORDER BY created_at DESC LIMIT 50"
    )
    .all(bank.id) as { content: string }[];

  // Use Claude to synthesize each category
  const synthesizePrompt = `
    You are synthesizing knowledge for an accounting office memory system.

    Individual facts (tax rules):
    ${taxRuleFacts.map((f) => `- ${f.content}`).join("\n") || "No facts yet"}

    Synthesize these into ONE sentence that captures the office's tax setup:
  `;

  try {
    const response = await axios.post(
      CLAUDE_API_URL,
      {
        model: "claude-haiku-4-5-20251001",
        max_tokens: 200,
        messages: [{ role: "user", content: synthesizePrompt }],
      },
      { headers: { "x-api-key": CLAUDE_API_KEY, "anthropic-version": "2023-06-01" } }
    );

    const synth = response.data.content[0].text.trim();

    db.prepare(
      "UPDATE memory_banks SET tax_rules_model = ?, last_updated = CURRENT_TIMESTAMP WHERE id = ?"
    ).run(synth, bank.id);

    console.log(`✓ Reflected memory for office ${officeId}`);
  } catch (error) {
    console.error("❌ Reflection failed:", error);
  }
}

// ============================================================================
// Utility: Get human-readable summary of office memory
// ============================================================================

export function summarizeMemoryBank(db: Database.Database, officeId: number): string {
  const bank = db
    .prepare("SELECT * FROM memory_banks WHERE office_id = ?")
    .get(officeId) as MemoryBank | undefined;

  if (!bank) return "No memory yet";

  const lines = [
    `Office Memory Bank (Office #${officeId})`,
    `---`,
    bank.tax_rules_model ? `Tax Rules: ${bank.tax_rules_model}` : "Tax Rules: No synthesis yet",
    bank.transaction_patterns_model ? `Patterns: ${bank.transaction_patterns_model}` : "Patterns: No synthesis yet",
    `Entities: ${Object.keys(JSON.parse(bank.entities || "{}")).length} known`,
    `Recent Txns: ${JSON.parse(bank.recent_transactions || "[]").length} tracked`,
    `Last Updated: ${bank.last_updated}`,
  ];

  return lines.join("\n");
}
