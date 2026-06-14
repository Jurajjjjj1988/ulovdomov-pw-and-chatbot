/**
 * Intent Router agent.
 *
 * Classifies user message into one of 5 intent categories. Always returns a
 * structured JSON response (model is forced to `response_format: json_object`),
 * so downstream orchestration is mechanical.
 *
 * Why a separate agent: keeping classification out of the FAQ agent prevents
 * the FAQ agent's verbose system prompt from biasing classification — it also
 * lets us run a cheaper / faster model for routing if cost becomes an issue
 * (gpt-4o-mini is already cheap; on Azure you can deploy a smaller model
 * specifically for this).
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { getChatClient, getChatModel } from "../llm-client.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

export type Intent =
  | "faq"
  | "property_search"
  | "viewing_request"
  | "complaint"
  | "chitchat";

export interface IntentResult {
  intent: Intent;
  confidence: number;
  rationale: string;
  usage: { prompt: number; completion: number };
}

const SYSTEM_PROMPT = readFileSync(
  join(__dirname, "..", "prompts", "intent-router.system.md"),
  "utf8",
);

const VALID_INTENTS = new Set<Intent>([
  "faq",
  "property_search",
  "viewing_request",
  "complaint",
  "chitchat",
]);

export async function routeIntent(userMessage: string): Promise<IntentResult> {
  const client = getChatClient();
  const completion = await client.chat.completions.create({
    model: getChatModel(),
    temperature: 0,
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: userMessage },
    ],
  });

  const raw = completion.choices[0]?.message?.content ?? "{}";
  const parsed = JSON.parse(raw) as Partial<IntentResult>;

  const usage = {
    prompt: completion.usage?.prompt_tokens ?? 0,
    completion: completion.usage?.completion_tokens ?? 0,
  };

  // Defensive validation — the model is instructed to return one of 5 valid
  // intents, but with structured output we still validate so a hallucinated
  // intent name doesn't crash the orchestrator.
  if (
    typeof parsed.intent !== "string" ||
    !VALID_INTENTS.has(parsed.intent as Intent)
  ) {
    return {
      intent: "faq",
      confidence: 0,
      rationale: `Invalid intent '${String(parsed.intent)}' returned by router — falling back to faq.`,
      usage,
    };
  }

  const confidence =
    typeof parsed.confidence === "number" &&
    parsed.confidence >= 0 &&
    parsed.confidence <= 1
      ? parsed.confidence
      : 0.5;

  return {
    intent: parsed.intent as Intent,
    confidence,
    rationale:
      typeof parsed.rationale === "string"
        ? parsed.rationale
        : "(no rationale provided)",
    usage,
  };
}
