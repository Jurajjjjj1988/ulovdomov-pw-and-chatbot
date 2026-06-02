/**
 * Property Search Agent.
 *
 * Extracts search criteria from a free-text user message, calls the
 * `search_listings` tool, and renders the top-K matches as a human-readable
 * summary.
 *
 * v0.2 status — wired up but the `search_listings` tool returns mock data.
 * Production would proxy to úlovdomov.cz's internal listings search API
 * (or to a public read-only export endpoint if available).
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { getChatClient, getChatModel, getTemperature } from "../llm-client.js";
import { searchListingsTool } from "../tools/search-listings.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

const SYSTEM_PROMPT = readFileSync(
  join(__dirname, "..", "prompts", "property-search-agent.system.md"),
  "utf8",
);

export interface PropertySearchResult {
  text: string;
  /** Number of search_listings tool invocations the agent made. */
  searchCalls: number;
  usage: { prompt: number; completion: number };
}

export async function handlePropertySearch(
  userMessage: string,
  conversationHistory: Array<{ role: "user" | "assistant" | "system"; content: string }> = [],
): Promise<PropertySearchResult> {
  const client = getChatClient();
  const completion = await client.chat.completions.create({
    model: getChatModel(),
    temperature: getTemperature(),
    tools: [searchListingsTool],
    tool_choice: "auto",
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      ...conversationHistory,
      { role: "user", content: userMessage },
    ],
  });

  const choice = completion.choices[0];
  const message = choice?.message;
  const toolCallCount = message?.tool_calls?.length ?? 0;

  return {
    text: message?.content ?? "",
    searchCalls: toolCallCount,
    usage: {
      prompt: completion.usage?.prompt_tokens ?? 0,
      completion: completion.usage?.completion_tokens ?? 0,
    },
  };
}
