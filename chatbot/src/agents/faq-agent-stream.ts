/**
 * Streaming variant of the FAQ agent — async generator yielding text chunks
 * + a final usage event.
 *
 * The 2026 pattern (verified against the OpenAI streaming-events docs):
 *   - request: `stream: true` AND `stream_options: { include_usage: true }`
 *   - intermediate chunks carry `choices[0].delta.content`
 *   - final chunk arrives with `choices: []` and a populated `usage` object
 *
 * Non-streaming callers can consume this generator and concatenate; both
 * code paths share the same prompt-building + RAG augmentation logic.
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

function buildAugmentedSystemPrompt(chunks: RetrievedChunk[]): string {
  if (chunks.length === 0) {
    return `${SYSTEM_PROMPT}\n\n### Retrieved knowledge\n\n_Žiadny relevantný kontext z knowledge base nebol nájdený._`;
  }
  const ragBlock = chunks
    .map((c, i) => `[${i + 1}] zdroj: ${c.source}\n${c.content.trim()}`)
    .join("\n\n---\n\n");
  return `${SYSTEM_PROMPT}\n\n### Retrieved knowledge\n\n${ragBlock}`;
}

export type FaqStreamEvent =
  | { type: "token"; text: string }
  | { type: "done"; usage: { prompt: number; completion: number }; finishReason: string };

export async function* answerFaqStream(
  userMessage: string,
  retrieved: RetrievedChunk[],
  conversationHistory: Array<{ role: "user" | "assistant"; content: string }> = [],
): AsyncGenerator<FaqStreamEvent, void, void> {
  const client = getChatClient();
  const stream = await client.chat.completions.create({
    model: getChatModel(),
    temperature: getTemperature(),
    stream: true,
    stream_options: { include_usage: true },
    messages: [
      { role: "system", content: buildAugmentedSystemPrompt(retrieved) },
      ...conversationHistory,
      { role: "user", content: userMessage },
    ],
  });

  let usage = { prompt: 0, completion: 0 };
  let finishReason = "stop";

  for await (const chunk of stream) {
    const choice = chunk.choices[0];
    if (choice?.delta?.content) {
      yield { type: "token", text: choice.delta.content };
    }
    if (choice?.finish_reason) {
      finishReason = choice.finish_reason;
    }
    // Final chunk: choices is empty, usage is populated.
    if (chunk.usage) {
      usage = {
        prompt: chunk.usage.prompt_tokens ?? 0,
        completion: chunk.usage.completion_tokens ?? 0,
      };
    }
  }

  yield { type: "done", usage, finishReason };
}
