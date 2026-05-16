/**
 * Conversation log.
 *
 * Append-only JSONL writer. Every chatbot turn produces one row. The format
 * is intentionally flat and grep-friendly — no nested objects beyond one
 * level, no escape sequences in summary fields.
 *
 * Consumed by:
 *   - `src/conversation-log-analyzer.ts` for post-hoc quality metrics
 *   - Manual inspection during prompt iteration (`jq` / `duckdb -c "..."`)
 *
 * Schema (one JSON object per line):
 * {
 *   "ts": "2026-06-15T10:23:45Z",
 *   "conversationId": "uuid",
 *   "turn": 3,
 *   "userMessage": "...",
 *   "router": { "intent": "faq", "confidence": 0.92, "rationale": "..." },
 *   "retrieval": [ { "source": "01-pricing.md", "heading": "...", "score": 0.81 } ],
 *   "agentResponse": "...",
 *   "toolCalls": [ { "name": "create_support_ticket", "args": {...} } ],
 *   "latencyMs": 1240,
 *   "tokensUsed": { "prompt": 1820, "completion": 145 }
 * }
 */

import { appendFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

import type { IntentResult } from "./agents/intent-router.js";
import type { RetrievedChunk } from "./rag/retriever.js";
import type { GuardResult } from "./guard.js";
import type { Backend } from "./llm-client.js";

export interface ConversationTurn {
  ts: string;
  conversationId: string;
  turn: number;
  userMessage: string;
  router: IntentResult;
  retrieval: Array<Pick<RetrievedChunk, "source" | "heading" | "score">>;
  agentResponse: string;
  toolCalls: Array<{ name: string; args: Record<string, unknown> }>;
  latencyMs: number;
  tokensUsed: { prompt: number; completion: number };
  /** Estimated USD cost (router + downstream agent). See cost-tracker.ts. */
  costUsd: number;
  /** Model identifier (deployment name on Azure, model name on OpenAI direct). */
  model: string;
  /** "openai", "azure", or "github-models" — captured for billing reconciliation. */
  backend: Backend;
  /** Guard verdict + reasons. See guard.ts. */
  guard: GuardResult;
}

const DEFAULT_LOG_PATH = "./logs/conversations.jsonl";

export function logTurn(turn: ConversationTurn): void {
  const path = process.env.CONVERSATION_LOG_PATH ?? DEFAULT_LOG_PATH;
  if (!existsSync(dirname(path))) {
    mkdirSync(dirname(path), { recursive: true });
  }
  appendFileSync(path, `${JSON.stringify(turn)}\n`, "utf8");
}
