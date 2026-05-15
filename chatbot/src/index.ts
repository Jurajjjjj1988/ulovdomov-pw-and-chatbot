/**
 * Orchestrator entry point.
 *
 * Wires the agents together:
 *   1. Router classifies user message
 *   2. Branch by intent to the right specialised agent
 *   3. Agent produces response (with RAG / tool calls as needed)
 *   4. Logger records the turn
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

  // 1. Route
  const router = await routeIntent(input.userMessage);

  // 2. Branch — only the FAQ branch invokes RAG retrieval, others bypass it.
  let response = "";
  let retrievedForLog: ConversationTurn["retrieval"] = [];
  let toolCalls: ConversationTurn["toolCalls"] = [];

  switch (router.intent) {
    case "faq": {
      const retrieved = await retrieve(input.userMessage, RAG_TOP_K);
      retrievedForLog = retrieved.map((r) => ({
        source: r.source,
        heading: r.heading,
        score: r.score,
      }));
      const answer = await answerFaq(input.userMessage, retrieved, history);
      response = answer.text;
      break;
    }
    case "complaint": {
      const result = await handleEscalation(input.userMessage, history);
      response = result.text;
      if (result.ticketId) {
        toolCalls = [
          {
            name: "create_support_ticket",
            args: { ticket_id: result.ticketId },
          },
        ];
      }
      break;
    }
    case "property_search": {
      const result = await handlePropertySearch(input.userMessage, history);
      response = result.text;
      if (result.searchCalls > 0) {
        toolCalls = [
          {
            name: "search_listings",
            args: { invocation_count: result.searchCalls },
          },
        ];
      }
      break;
    }
    case "chitchat": {
      response = await handleSmalltalk(input.userMessage, history);
      break;
    }
    case "viewing_request": {
      // TODO(v0.2): dedicated viewing agent with calendar integration.
      // For v0.1 we use the FAQ agent + RAG retrieval — knowledge-base/
      // 02-viewing-process.md already covers the procedure questions.
      const retrieved = await retrieve(input.userMessage, RAG_TOP_K);
      retrievedForLog = retrieved.map((r) => ({
        source: r.source,
        heading: r.heading,
        score: r.score,
      }));
      const answer = await answerFaq(input.userMessage, retrieved, history);
      response = answer.text;
      break;
    }
  }

  // 3. Log
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
    tokensUsed: { prompt: 0, completion: 0 }, // TODO(v0.2): plumb usage through
  };
  logTurn(record);

  return { response, intent: router.intent, record };
}
