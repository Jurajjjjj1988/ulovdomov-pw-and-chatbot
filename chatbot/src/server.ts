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
import rateLimit from "@fastify/rate-limit";
import fastifySwagger from "@fastify/swagger";
import fastifySwaggerUi from "@fastify/swagger-ui";

import { processTurn } from "./index.js";
import { detectBackend, getChatModel } from "./llm-client.js";
import { ConversationMemory } from "./conversation-memory.js";
import { formatCostUsd, estimateChatCostUsd, sumUsage } from "./cost-tracker.js";
import {
  ChatRequestSchema,
  ChatResponseSchema,
  HealthResponseSchema,
  ReadyResponseSchema,
  MetricsResponseSchema,
  ErrorResponseSchema,
  type ChatRequest,
} from "./schemas.js";
import { runGuard, GUARD_REFUSAL_MESSAGE } from "./guard.js";
import { routeIntent } from "./agents/intent-router.js";
import { retrieve } from "./rag/retriever.js";
import { answerFaqStream } from "./agents/faq-agent-stream.js";
import { handleSmalltalkStream } from "./agents/smalltalk-agent-stream.js";
import { requestContext, parseTraceparent } from "./request-context.js";

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

// ─── OpenAPI 3.1 + Swagger UI ──────────────────────────────────────────────
// Schema-first per 2026 fastify-swagger pattern. Same TypeBox schemas drive
// runtime validation (Ajv) AND the generated /openapi.json. Swagger UI is
// mounted at /docs. In production, gate behind basic auth or a feature flag
// if the public surface should stay opaque.
await app.register(fastifySwagger, {
  openapi: {
    openapi: "3.1.0",
    info: {
      title: "úlovdomov chatbot HTTP API",
      version: "0.2.0",
      description:
        "Multi-agent customer-support chatbot for úlovdomov.cz — Czech / Slovak " +
        "language, multi-backend LLM (Azure OpenAI / OpenAI / GitHub Models), " +
        "RAG-grounded answers, guard-layer prompt-injection defense.",
    },
    servers: [
      { url: "http://localhost:3000", description: "Local dev" },
      { url: "https://chatbot.example.azurewebsites.net", description: "Production (placeholder)" },
    ],
    tags: [
      { name: "chat", description: "Conversational endpoints" },
      { name: "health", description: "Liveness / readiness probes" },
      { name: "metrics", description: "Aggregate observability" },
    ],
  },
});

await app.register(fastifySwaggerUi, {
  routePrefix: "/docs",
  uiConfig: {
    docExpansion: "list",
    deepLinking: true,
    tryItOutEnabled: true,
  },
});

// ─── Request context ───────────────────────────────────────────────────────
// Hook that runs FIRST. Wraps the rest of the request in an
// AsyncLocalStorage so request_id + conversation_id + inbound traceparent
// flow through orchestrator → router → agents without param plumbing.
//
// Reads the W3C traceparent header (Azure Application Insights emits +
// consumes it natively) so an upstream service's trace_id correlates with
// the chatbot's spans automatically. If the header is absent, OTel mints
// a fresh trace_id on the first span — standard behavior.
app.addHook("onRequest", (request, _reply, done) => {
  const traceparent = request.headers["traceparent"];
  const body = request.body as { conversationId?: string } | undefined;
  const conversationId = body?.conversationId ?? request.id;
  requestContext.run(
    {
      requestId: request.id,
      conversationId,
      traceparent: typeof traceparent === "string" ? traceparent : undefined,
    },
    () => done(),
  );
});

// ─── API key auth ──────────────────────────────────────────────────────────
// Bearer-token auth gating the chat endpoints. Set `CHATBOT_API_KEY` to enable.
// When unset, the auth hook is a no-op — useful for local development.
//
// In production (Azure App Service / Container Apps), bind CHATBOT_API_KEY
// via a Key Vault reference, NOT as a plaintext config value. See
// docs/azure-deployment.md § "Secrets management."
//
// Probes (/health, /ready) and docs (/docs, /docs/*, /docs/json) stay open
// — they need to be reachable by k8s/Container Apps health checks and by
// the engineer browsing the spec.
const REQUIRED_API_KEY = process.env.CHATBOT_API_KEY;
const AUTH_OPEN_PATHS = new Set(["/health", "/ready", "/docs/json"]);

if (REQUIRED_API_KEY) {
  app.addHook("onRequest", async (request, reply) => {
    if (AUTH_OPEN_PATHS.has(request.url) || request.url.startsWith("/docs")) {
      return;
    }
    const header = request.headers["authorization"];
    if (typeof header !== "string" || !header.startsWith("Bearer ")) {
      return reply.code(401).send({
        error: "unauthorized",
        message: "Missing Bearer token. Send 'Authorization: Bearer <api-key>'.",
        statusCode: 401,
      });
    }
    const presented = header.slice("Bearer ".length).trim();
    if (presented !== REQUIRED_API_KEY) {
      return reply.code(401).send({
        error: "unauthorized",
        message: "Invalid API key.",
        statusCode: 401,
      });
    }
  });
  app.log.info("API key authentication enabled");
} else {
  app.log.warn("CHATBOT_API_KEY not set — /chat endpoints are open (dev mode)");
}

// ─── Rate limiting ─────────────────────────────────────────────────────────
// Global default: 30 req/min per IP. /chat tightened to abuse-friendly limits
// keyed on conversationId (if provided) — falls back to IP. Health checks
// stay unlimited so Container Apps probes never trip.
//
// For multi-instance deploys, set `RATE_LIMIT_REDIS_URL` to back the store on
// Redis (see @fastify/rate-limit docs); without it the limits are per-pod.
await app.register(rateLimit, {
  global: false, // opt-in per route — keeps /health unlimited
  max: 30,
  timeWindow: "1 minute",
  keyGenerator: (request) => request.ip,
  errorResponseBuilder: (_req, context) => ({
    error: "rate_limited",
    message: `Too many requests. Retry in ${Math.ceil(context.ttl / 1000)}s.`,
    statusCode: 429,
  }),
});

// ─── POST /chat ─────────────────────────────────────────────────────────────
app.post(
  "/chat",
  {
    schema: {
      tags: ["chat"],
      summary: "Run one conversational turn",
      description:
        "Pre-router guard → router → branch (FAQ / escalation / property search / " +
        "smalltalk) → RAG when applicable → log + OTel span. Memory keyed on " +
        "conversationId persists between turns within one server process.",
      body: ChatRequestSchema,
      response: {
        200: ChatResponseSchema,
        400: ErrorResponseSchema,
        429: ErrorResponseSchema,
        500: ErrorResponseSchema,
      },
    },
    config: {
      rateLimit: {
        max: 20,
        timeWindow: "1 minute",
        keyGenerator: (request) => {
          const body = request.body as { conversationId?: string } | undefined;
          return body?.conversationId ?? request.ip;
        },
      },
    },
  },
  async (request: FastifyRequest<{ Body: ChatRequest }>, reply: FastifyReply) => {
    const body = request.body;
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
  },
);

// ─── GET /health ────────────────────────────────────────────────────────────
app.get(
  "/health",
  {
    schema: {
      tags: ["health"],
      summary: "Liveness probe",
      description: "Returns 200 once the orchestrator + LLM client resolve.",
      response: { 200: HealthResponseSchema },
    },
  },
  async (_req, reply) => {
    return reply.send({ status: "ok", backend: detectBackend(), model: getChatModel() });
  },
);

// ─── GET /ready ─────────────────────────────────────────────────────────────
app.get("/ready", {
  schema: {
    tags: ["health"],
    summary: "Readiness probe",
    description: "Returns 200 only when RAG index exists AND an LLM backend is configured; 503 otherwise.",
    response: { 200: ReadyResponseSchema, 503: ReadyResponseSchema },
  },
}, async (_req, reply) => {
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
app.get("/metrics", {
  schema: {
    tags: ["metrics"],
    summary: "Aggregate observability over the conversation log",
    response: { 200: MetricsResponseSchema },
  },
}, async (_req, reply) => {
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

// ─── POST /chat/stream ──────────────────────────────────────────────────────
//
// Server-Sent Events streaming endpoint. Runs the full chatbot pipeline:
//   1. guard (lexical pre-check)              → SSE event: "guard"
//   2. router classify intent                 → SSE event: "router"
//   3. RAG retrieval (when intent === faq)    → SSE event: "rag"
//   4. FAQ agent token-by-token (when faq)    → SSE event: "token" * N
//   5. usage + cost summary                   → SSE event: "done"
//
// For non-FAQ intents (escalation / property search / smalltalk) the route
// still emits guard/router events, then a single "fallback" event noting
// that streaming is only wired into the FAQ path in v0.2. The remaining
// agents stream in v0.3 — the async-generator pattern in
// `src/agents/faq-agent-stream.ts` is the template.
//
// Heartbeat: a `: ping` SSE comment every 15s — keeps Azure App Service
// (240s idle timeout) and intermediate proxies from closing the socket.
app.post(
  "/chat/stream",
  {
    schema: {
      tags: ["chat"],
      summary: "Streaming turn (Server-Sent Events)",
      description:
        "Same pipeline as POST /chat but the FAQ agent's response streams " +
        "token-by-token. Event types: guard, router, rag, token, done, error. " +
        "Non-FAQ intents emit a 'fallback' event and the response is included " +
        "in the 'done' event instead of token chunks (v0.2 scope).",
      body: ChatRequestSchema,
      // SSE response is text/event-stream — OpenAPI 3.1 docs it as a
      // free-form text payload with a description listing event names.
      response: {
        200: {
          description:
            "Server-Sent Events stream. Event names: guard, router, rag, token, done, error, fallback.",
          content: {
            "text/event-stream": {
              schema: { type: "string" },
            },
          },
        },
        400: ErrorResponseSchema,
        429: ErrorResponseSchema,
      },
    },
    config: {
      rateLimit: {
        max: 10, // streaming holds a socket open — be tighter
        timeWindow: "1 minute",
        keyGenerator: (request) => {
          const body = request.body as { conversationId?: string } | undefined;
          return body?.conversationId ?? request.ip;
        },
      },
    },
  },
  async (request: FastifyRequest<{ Body: ChatRequest }>, reply: FastifyReply) => {
    const body = request.body;
    const conversationId = body.conversationId ?? request.id;
    const memory = getOrCreateMemory(conversationId);
    const { recent } = memory.forPrompt();
    const start = Date.now();

    // Take ownership of the raw socket — Fastify lifecycle no longer applies.
    reply.hijack();
    const raw = reply.raw;
    raw.setHeader("Content-Type", "text/event-stream");
    raw.setHeader("Cache-Control", "no-cache, no-transform");
    raw.setHeader("Connection", "keep-alive");
    raw.setHeader("X-Accel-Buffering", "no"); // nginx + Azure Front Door
    raw.flushHeaders?.();
    raw.socket?.setNoDelay(true);

    function send(event: string, data: unknown): void {
      raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    }

    const heartbeat = setInterval(() => raw.write(`: ping\n\n`), 15_000);

    let assembledResponse = "";
    let totalUsage = { prompt: 0, completion: 0 };

    try {
      // 1. Guard
      const guard = await runGuard(body.message);
      send("guard", guard);
      if (guard.block) {
        send("token", { text: GUARD_REFUSAL_MESSAGE });
        send("done", {
          conversationId,
          tokens: { prompt: 0, completion: 0 },
          costUsd: 0,
          latencyMs: Date.now() - start,
          intent: "complaint",
        });
        clearInterval(heartbeat);
        raw.end();
        return;
      }

      // 2. Router — pass history so pronominal follow-ups route correctly.
      const router = await routeIntent(body.message, recent);
      send("router", { intent: router.intent, confidence: router.confidence });
      totalUsage = sumUsage([totalUsage, router.usage]);

      // 3. RAG (FAQ + viewing_request fall-through paths)
      const isRag = router.intent === "faq" || router.intent === "viewing_request";
      if (isRag) {
        const retrieved = await retrieve(body.message, 3);
        send(
          "rag",
          retrieved.map((r) => ({
            source: r.source,
            heading: r.heading,
            score: r.score,
          })),
        );

        // 4. Stream FAQ tokens
        for await (const evt of answerFaqStream(body.message, retrieved, recent)) {
          if (evt.type === "token") {
            assembledResponse += evt.text;
            send("token", { text: evt.text });
          } else if (evt.type === "done") {
            totalUsage = sumUsage([totalUsage, evt.usage]);
          }
        }
      } else if (router.intent === "chitchat") {
        // 4b. Smalltalk streams natively — no RAG, no tools.
        for await (const evt of handleSmalltalkStream(body.message, recent)) {
          if (evt.type === "token") {
            assembledResponse += evt.text;
            send("token", { text: evt.text });
          } else if (evt.type === "done") {
            totalUsage = sumUsage([totalUsage, evt.usage]);
          }
        }
      } else {
        // 4c. Tool-call intents (escalation, property_search) — streaming
        // tool args reliably is a larger refactor (v0.3). For now fall back
        // to non-streaming processTurn so /chat/stream still works for them.
        send("fallback", {
          reason: `intent=${router.intent} uses tool calling; streamed in v0.3. Falling back to single-event delivery for this turn.`,
        });
        const result = await processTurn({
          userMessage: body.message,
          conversationId,
          turn: body.turn ?? memory.size() / 2 + 1,
          history: recent,
        });
        assembledResponse = result.response;
        send("token", { text: result.response });
        totalUsage = result.record.tokensUsed;
      }

      // 6. Persist memory + cost
      memory.append(body.message, assembledResponse);
      memory.compactIfNeeded().catch(() => {
        /* silent — next turn retries */
      });
      const costUsd = estimateChatCostUsd(getChatModel(), totalUsage, detectBackend());

      send("done", {
        conversationId,
        tokens: totalUsage,
        costUsd,
        latencyMs: Date.now() - start,
        intent: router.intent,
      });
    } catch (err) {
      request.log.error({ err }, "stream failed");
      send("error", {
        message: err instanceof Error ? err.message : "unknown error",
      });
    } finally {
      clearInterval(heartbeat);
      raw.end();
    }
  },
);

// ─── boot ───────────────────────────────────────────────────────────────────
// Graceful shutdown — flush logs, close in-flight connections before exit.
for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    app.log.info(`received ${sig}, shutting down`);
    void app.close().then(() => process.exit(0));
  });
}

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
