/**
 * Smalltalk Agent.
 *
 * Handles greetings, off-topic chatter, and questions that don't fit any
 * other intent. Bounded scope — always redirects to úlovdomov's domain
 * after a brief acknowledgement. No RAG, no tools.
 *
 * Why a dedicated agent (not "FAQ with chitchat fallback"): the FAQ agent's
 * system prompt is RAG-augmented and produces 200+ word responses by
 * design. Routing chitchat through it produced overly verbose smalltalk —
 * the bot answered "Ahoj" with three paragraphs. This dedicated agent
 * keeps smalltalk short.
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

export interface SmalltalkResult {
  text: string;
  usage: { prompt: number; completion: number };
}

export async function handleSmalltalk(
  userMessage: string,
  conversationHistory: Array<{ role: "user" | "assistant"; content: string }> = [],
): Promise<SmalltalkResult> {
  const client = getChatClient();
  const completion = await client.chat.completions.create({
    model: getChatModel(),
    temperature: getTemperature(),
    // Cap to keep responses short — smalltalk should never exceed ~80 tokens.
    max_tokens: 120,
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      ...conversationHistory,
      { role: "user", content: userMessage },
    ],
  });

  return {
    text: completion.choices[0]?.message?.content ?? "",
    usage: {
      prompt: completion.usage?.prompt_tokens ?? 0,
      completion: completion.usage?.completion_tokens ?? 0,
    },
  };
}
