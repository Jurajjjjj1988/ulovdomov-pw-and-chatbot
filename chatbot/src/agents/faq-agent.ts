/**
 * FAQ Agent.
 *
 * Takes a user message + retrieved RAG context and produces a customer-facing
 * answer. The system prompt is the source of truth for tone and constraints;
 * this module just plumbs together prompt + RAG + LLM call.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { getChatClient, getChatModel, getTemperature } from "../llm-client.js";
import type { RetrievedChunk } from "../rag/retriever.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

const SYSTEM_PROMPT = readFileSync(
  join(__dirname, "..", "prompts", "faq-agent.system.md"),
  "utf8",
);

export interface FaqAnswer {
  text: string;
  citedSources: string[];
}

/** Build the augmented system prompt by appending RAG chunks. */
function buildAugmentedSystemPrompt(chunks: RetrievedChunk[]): string {
  if (chunks.length === 0) {
    return `${SYSTEM_PROMPT}\n\n### Retrieved knowledge\n\n_Žiadny relevantný kontext z knowledge base nebol nájdený._`;
  }

  const ragBlock = chunks
    .map(
      (c, i) =>
        `[${i + 1}] zdroj: ${c.source}\n${c.content.trim()}`,
    )
    .join("\n\n---\n\n");

  return `${SYSTEM_PROMPT}\n\n### Retrieved knowledge\n\n${ragBlock}`;
}

export async function answerFaq(
  userMessage: string,
  retrieved: RetrievedChunk[],
  conversationHistory: Array<{ role: "user" | "assistant"; content: string }> = [],
): Promise<FaqAnswer> {
  const client = getChatClient();
  const completion = await client.chat.completions.create({
    model: getChatModel(),
    temperature: getTemperature(),
    messages: [
      { role: "system", content: buildAugmentedSystemPrompt(retrieved) },
      ...conversationHistory,
      { role: "user", content: userMessage },
    ],
  });

  const text = completion.choices[0]?.message?.content ?? "";

  // Cited sources = every source that actually appears in the answer text.
  // This is a soft check — the model is asked to cite sources verbatim, but
  // we don't fail if it paraphrases.
  const citedSources = retrieved
    .map((c) => c.source)
    .filter((s) => text.toLowerCase().includes(s.toLowerCase().replace(".md", "")));

  return { text, citedSources };
}
