/**
 * Streaming smalltalk agent — async generator twin of `handleSmalltalk`.
 *
 * Same system prompt, same `max_tokens: 120` cap. Smalltalk has no RAG, no
 * tool calls, so the streaming shape is the simplest of the agents — just
 * text tokens + a usage event.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { getChatClient, getChatModel, getTemperature } from "../llm-client.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

const SYSTEM_PROMPT = readFileSync(
  join(__dirname, "..", "prompts", "smalltalk-agent.system.md"),
  "utf8",
);

export type SmalltalkStreamEvent =
  | { type: "token"; text: string }
  | { type: "done"; usage: { prompt: number; completion: number } };

export async function* handleSmalltalkStream(
  userMessage: string,
  conversationHistory: Array<{ role: "user" | "assistant" | "system"; content: string }> = [],
): AsyncGenerator<SmalltalkStreamEvent, void, void> {
  const client = getChatClient();
  const stream = await client.chat.completions.create({
    model: getChatModel(),
    temperature: getTemperature(),
    max_tokens: 120,
    stream: true,
    stream_options: { include_usage: true },
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      ...conversationHistory,
      { role: "user", content: userMessage },
    ],
  });

  let usage = { prompt: 0, completion: 0 };

  for await (const chunk of stream) {
    const choice = chunk.choices[0];
    if (choice?.delta?.content) {
      yield { type: "token", text: choice.delta.content };
    }
    if (chunk.usage) {
      usage = {
        prompt: chunk.usage.prompt_tokens ?? 0,
        completion: chunk.usage.completion_tokens ?? 0,
      };
    }
  }

  yield { type: "done", usage };
}
