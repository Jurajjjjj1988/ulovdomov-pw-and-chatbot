/**
 * Escalation Handler.
 *
 * Activates when:
 *   - Intent router classified `complaint`
 *   - FAQ agent failed to answer 2 turns in a row
 *   - User explicitly asked for a human operator
 *
 * Hardcodes the 4-step flow from the system prompt:
 *   1. Acknowledge — name the problem, no apology theatre
 *   2. Clarify — collect ticket metadata if missing
 *   3. Tool call — `create_support_ticket` with priority + category
 *   4. Confirm — surface ticket ID + realistic SLA
 *
 * Step 3 (tool call) is mandatory. The orchestrator logs a warning if a
 * response is emitted without a tool call.
 *
 * v0.2 will add streaming for steps 1 + 4 (faster TTFB perception).
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { getChatClient, getChatModel, getTemperature } from "../llm-client.js";
import { createSupportTicketTool } from "../tools/create-support-ticket.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

const SYSTEM_PROMPT = readFileSync(
  join(__dirname, "..", "prompts", "escalation-handler.system.md"),
  "utf8",
);

export interface EscalationResult {
  text: string;
  ticketId: string | null;
  step: "acknowledge" | "clarify" | "confirm";
  usage: { prompt: number; completion: number };
}

export async function handleEscalation(
  userMessage: string,
  conversationHistory: Array<{ role: "user" | "assistant" | "system"; content: string }> = [],
): Promise<EscalationResult> {
  const client = getChatClient();
  const completion = await client.chat.completions.create({
    model: getChatModel(),
    temperature: getTemperature(),
    tools: [createSupportTicketTool],
    tool_choice: "auto",
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      ...conversationHistory,
      { role: "user", content: userMessage },
    ],
  });

  const choice = completion.choices[0];
  const message = choice?.message;

  // TODO(v0.2): actually invoke the tool and feed the result back into a
  // follow-up completion for step 4 (confirm). For the v0.1 demo we just
  // surface the tool call shape so reviewers can see the flow.
  const toolCall = message?.tool_calls?.[0];
  const ticketId = toolCall ? `TICK-${Date.now().toString(36).toUpperCase()}` : null;

  return {
    text: message?.content ?? "",
    ticketId,
    step: ticketId ? "confirm" : "acknowledge",
    usage: {
      prompt: completion.usage?.prompt_tokens ?? 0,
      completion: completion.usage?.completion_tokens ?? 0,
    },
  };
}
