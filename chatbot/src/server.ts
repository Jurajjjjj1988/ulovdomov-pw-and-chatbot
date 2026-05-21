#!/usr/bin/env tsx
/**
 * HTTP server wrapper around the chatbot orchestrator.
 *
 * Endpoints:
 *   POST /chat        — single chatbot turn; carries conversation memory per session
 *   GET  /health      — liveness probe (returns 200 once the orchestrator is reachable)
 *   GET  /ready       — readiness probe (checks LLM backend + RAG index)
 *   GET  /metrics     — aggregate metrics from the conversation log (intent
 *                       distribution, p50 / p95 latency, total cost, avg cost / turn)
 *
 * Production deployment target: Azure App Service (Linux container) or Azure
 * Container Apps. The Dockerfile in this folder builds an image that runs
 * `npx tsx src/server.ts` as a non-root user.
 *
 * Conversation memory: per-`conversationId` ConversationMemory instances are
 * held in-process. For multi-instance deploys, swap this Map for a Redis /
 * Cosmos DB backed store. See `src/conversation-memory.ts`.
 */

import { existsSync, readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import Fastify, { type FastifyRequest, type FastifyReply } from "fastify";

import { processTurn } from "./index.js";
import { detectBackend, getChatModel } from "./llm-client.js";
import { ConversationMemory } from "./conversation-memory.js";
import { formatCostUsd } from "./cost-tracker.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CHATBOT_ROOT = resolve(__dirname, "..");
const RAG_INDEX_PATH = resolve(CHATBOT_ROOT, "knowledge-base/.index.json");
const LOG_PATH = process.env.CONVERSATION_LOG_PATH ?? "./logs/conversations.jsonl";

// Per-conversation memory state, keyed by conversationId. Sized in-memory so
// deployments with multiple instances need a shared backing store (Redis,
// Cosmos DB) — interface stays the same.
const memorySessions = new Map<string, ConversationMemory>();

function getOrCreateMemory(conversationId: string): ConversationMemory {
  const existing = memorySessions.get(conversationId);
  if (existing) return existing;
  const created = new ConversationMemory();
  memorySessions.set(conversationId, created);
  return created;
}

interface ChatRequestBody {
  conversationId?: string;
  message: string;
  turn?: number;
}

const app = Fastify({
  logger: {
    level: process.env.LOG_LEVEL ?? "info",
  },
  trustProxy: true, // Azure App Service / Container Apps front-end TLS
});

// ─── POST /chat ─────────────────────────────────────────────────────────────
app.post("/chat", async (request: FastifyRequest, reply: FastifyReply) => {
  const body = request.body as ChatRequestBody | undefined;
  if (!body || typeof body.message !== "string" || body.message.trim().length === 0) {
    return reply.code(400).send({ error: "missing or empty 'message' field" });
  }

  const conversationId = body.conversationId ?? request.id;
  const memory = getOrCreateMemory(conversationId);
  const { recent } = memory.forPrompt();

  try {
    const { response, intent, record } = await processTurn({
      userMessage: body.message,
      conversationId,
      turn: body.turn ?? memory.size() / 2 + 1,
      history: recent,
    });

    memory.append(body.message, response);
    // Best-effort summary compaction; failures here don't break the turn.
    memory.compactIfNeeded().catch((err: unknown) => {
      request.log.warn({ err }, "memory.compactIfNeeded failed");
    });

    return reply.send({
      conversationId,
      response,
      intent,
      meta: {
        guard: record.guard,
        router: { intent: record.router.intent, confidence: record.router.confidence },
        retrieval: record.retrieval,
        tokens: record.tokensUsed,
        costUsd: record.costUsd,
        latencyMs: record.latencyMs,
        backend: record.backend,
        model: record.model,
      },
    });
  } catch (err) {
    request.log.error({ err }, "processTurn failed");
    return reply.code(500).send({
      error: "internal_error",
      message: err instanceof Error ? err.message : "unknown error",
    });
  }
});

// ─── GET /health ────────────────────────────────────────────────────────────
app.get("/health", async (_req, reply) => {
  return reply.send({ status: "ok", backend: detectBackend(), model: getChatModel() });
});

// ─── GET /ready ─────────────────────────────────────────────────────────────
app.get("/ready", async (_req, reply) => {
  const ragReady = existsSync(RAG_INDEX_PATH);
  const backendConfigured =
    Boolean(process.env.GITHUB_MODELS_TOKEN) ||
    (Boolean(process.env.AZURE_OPENAI_ENDPOINT) && Boolean(process.env.AZURE_OPENAI_API_KEY)) ||
    Boolean(process.env.OPENAI_API_KEY);

  const ready = ragReady && backendConfigured;
  return reply.code(ready ? 200 : 503).send({
    ready,
    checks: {
      ragIndex: ragReady,
      llmBackend: backendConfigured,
    },
  });
});

// ─── GET /metrics ───────────────────────────────────────────────────────────
app.get("/metrics", async (_req, reply) => {
  const path = resolve(CHATBOT_ROOT, LOG_PATH);
  if (!existsSync(path)) {
    return reply.send({ turns: 0, message: "no conversation log yet" });
  }

  const lines = readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => line.trim().length > 0);

  const turns = lines.length;
  if (turns === 0) {
    return reply.send({ turns: 0 });
  }

  const intentCounts = new Map<string, number>();
  const latencies: number[] = [];
  let totalCost = 0;
  let totalPromptTokens = 0;
  let totalCompletionTokens = 0;

  for (const line of lines) {
    try {
      const row = JSON.parse(line) as {
        router?: { intent?: string };
        latencyMs?: number;
        costUsd?: number;
        tokensUsed?: { prompt: number; completion: number };
      };
      const intent = row.router?.intent ?? "unknown";
      intentCounts.set(intent, (intentCounts.get(intent) ?? 0) + 1);
      if (typeof row.latencyMs === "number") latencies.push(row.latencyMs);
      if (typeof row.costUsd === "number") totalCost += row.costUsd;
      if (row.tokensUsed) {
        totalPromptTokens += row.tokensUsed.prompt;
        totalCompletionTokens += row.tokensUsed.completion;
      }
    } catch {
      // Skip malformed rows — production data tends to have a few.
    }
  }

  latencies.sort((a, b) => a - b);
  const p50 = latencies[Math.floor(latencies.length * 0.5)] ?? 0;
  const p95 = latencies[Math.floor(latencies.length * 0.95)] ?? 0;

  return reply.send({
    turns,
    intents: Object.fromEntries(intentCounts),
    latency: { p50, p95 },
    tokens: { prompt: totalPromptTokens, completion: totalCompletionTokens },
    cost: {
      total: Number(totalCost.toFixed(6)),
      avgPerTurn: Number((totalCost / turns).toFixed(6)),
      totalFormatted: formatCostUsd(totalCost),
    },
  });
});

// ─── boot ───────────────────────────────────────────────────────────────────
async function main(): Promise<void> {
  const port = Number(process.env.PORT ?? 3000);
  const host = process.env.HOST ?? "0.0.0.0";

  try {
    await app.listen({ port, host });
    app.log.info(`chatbot listening on http://${host}:${port}`);
    app.log.info(`backend: ${detectBackend()} · model: ${getChatModel()}`);
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
}

// Graceful shutdown — flush logs, close in-flight connections before exit.
for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    app.log.info(`received ${sig}, shutting down`);
    void app.close().then(() => process.exit(0));
  });
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
