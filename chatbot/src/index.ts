/**
 * Orchestrator entry point.
 *
 * Wires the agents together:
 *   1. Router classifies user message
 *   2. Branch by intent to the right specialised agent
 *   3. Agent produces response (with RAG / tool calls as needed)
 *   4. Logger records the turn with token usage + estimated cost
 *
 * Public API: `processTurn()` — takes a user message + conversation history,
 * returns the assistant response and the structured turn record. The CLI
 * (`cli.ts`) and any future web UI both call this.
 */

import { randomUUID } from "node:crypto";

import { routeIntent, type Intent } from "./agents/intent-router.js";
import { answerFaq } from "./agents/faq-agent.js";
import { handleEscalation } from "./agents/escalation-handler.js";
import { handlePropertySearch } from "./agents/property-search-agent.js";
import { handleSmalltalk } from "./agents/smalltalk-agent.js";
import { retrieve } from "./rag/retriever.js";
import { logTurn, type ConversationTurn } from "./conversation-log.js";
import { detectBackend, getChatModel } from "./llm-client.js";
import { estimateChatCostUsd, sumUsage, type TokenUsage } from "./cost-tracker.js";
import { runGuard, GUARD_REFUSAL_MESSAGE, type GuardResult } from "./guard.js";
import { emitSpan } from "./observability.js";

export interface ProcessTurnInput {
  userMessage: string;
  conversationId?: string;
  turn?: number;
  history?: Array<{ role: "user" | "assistant"; content: string }>;
}

export interface ProcessTurnOutput {
  response: string;
  intent: Intent;
  record: ConversationTurn;
}

const RAG_TOP_K = Number.parseInt(process.env.RAG_TOP_K ?? "3", 10);

export async function processTurn(input: ProcessTurnInput): Promise<ProcessTurnOutput> {
  const startMs = Date.now();
  const conversationId = input.conversationId ?? randomUUID();
  const turn = input.turn ?? 1;
  const history = input.history ?? [];

  // 0. Guard — pre-router lexical (always) + optional LLM cross-check. On a
  // hard block, short-circuit with a fixed refusal so the malicious input
  // never reaches the FAQ / RAG / tool-calling code paths.
  const guard: GuardResult = await runGuard(input.userMessage);
  if (guard.block) {
    const blockedRecord: ConversationTurn = {
      ts: new Date().toISOString(),
      conversationId,
      turn,
      userMessage: input.userMessage,
      router: {
        intent: "complaint",
        confidence: 1,
        rationale: `Blocked by guard: ${guard.reasons.join(", ")}`,
        usage: { prompt: 0, completion: 0 },
      },
      retrieval: [],
      agentResponse: GUARD_REFUSAL_MESSAGE,
      toolCalls: [],
      latencyMs: Date.now() - startMs,
      tokensUsed: { prompt: 0, completion: 0 },
      costUsd: 0,
      model: getChatModel(),
      backend: detectBackend(),
      guard,
    };
    logTurn(blockedRecord);
    emitSpan(blockedRecord);
    return { response: GUARD_REFUSAL_MESSAGE, intent: "complaint", record: blockedRecord };
  }

  // 1. Route
  const router = await routeIntent(input.userMessage);

  // 2. Branch — only the FAQ branch invokes RAG retrieval, others bypass it.
  let response = "";
  let retrievedForLog: ConversationTurn["retrieval"] = [];
  let toolCalls: ConversationTurn["toolCalls"] = [];
  let agentUsage: TokenUsage;

  // FAQ and viewing-request both route through the RAG-augmented FAQ agent.
  // Once a dedicated viewing agent ships (v0.2), this fall-through splits.
  const isRagAnswer = router.intent === "faq" || router.intent === "viewing_request";

  if (isRagAnswer) {
    const retrieved = await retrieve(input.userMessage, RAG_TOP_K);
    retrievedForLog = retrieved.map((r) => ({
      source: r.source,
      heading: r.heading,
      score: r.score,
    }));
    const answer = await answerFaq(input.userMessage, retrieved, history);
    response = answer.text;
    agentUsage = answer.usage;
  } else if (router.intent === "complaint") {
    const result = await handleEscalation(input.userMessage, history);
    response = result.text;
    agentUsage = result.usage;
    if (result.ticketId) {
      toolCalls = [
        {
          name: "create_support_ticket",
          args: { ticket_id: result.ticketId },
        },
      ];
    }
  } else if (router.intent === "property_search") {
    const result = await handlePropertySearch(input.userMessage, history);
    response = result.text;
    agentUsage = result.usage;
    if (result.searchCalls > 0) {
      toolCalls = [
        {
          name: "search_listings",
          args: { invocation_count: result.searchCalls },
        },
      ];
    }
  } else {
    // chitchat
    const result = await handleSmalltalk(input.userMessage, history);
    response = result.text;
    agentUsage = result.usage;
  }

  // 3. Cost — sum router + downstream agent usage, convert to USD via the
  // hard-coded pricing table. Off by a few percent vs. real billing because
  // Azure's per-region prices drift slightly; acceptable for in-process
  // observability.
  const backend = detectBackend();
  const model = getChatModel();
  const totalUsage = sumUsage([router.usage, agentUsage]);
  const costUsd = estimateChatCostUsd(model, totalUsage, backend);

  // 4. Log
  const record: ConversationTurn = {
    ts: new Date().toISOString(),
    conversationId,
    turn,
    userMessage: input.userMessage,
    router,
    retrieval: retrievedForLog,
    agentResponse: response,
    toolCalls,
    latencyMs: Date.now() - startMs,
    tokensUsed: totalUsage,
    costUsd,
    model,
    backend,
    guard,
  };
  logTurn(record);
  emitSpan(record);

  return { response, intent: router.intent, record };
}
