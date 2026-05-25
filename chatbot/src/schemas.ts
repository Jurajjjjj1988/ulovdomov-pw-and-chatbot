/**
 * TypeBox schemas — single source of truth for runtime validation,
 * OpenAPI documentation, and Fastify type provider inference.
 *
 * The same schema objects are imported by:
 *   - src/server.ts route definitions  →  Ajv validates request / response
 *   - src/server.ts swagger config     →  emitted as OpenAPI 3.1 components
 *
 * Per the 2026 fastify-swagger + TypeBox pattern, keep schemas declarative
 * and side-effect free here; never reach for `Type.Object({...}, {
 * additionalProperties: true })` — drift is the most common contract bug.
 */

import { Type, type Static } from "@sinclair/typebox";

// ─── /chat ──────────────────────────────────────────────────────────────────

export const ChatRequestSchema = Type.Object(
  {
    message: Type.String({
      minLength: 1,
      maxLength: 4000,
      description: "User message in any language — chatbot replies in kind.",
    }),
    conversationId: Type.Optional(
      Type.String({
        minLength: 1,
        maxLength: 128,
        description:
          "Stable conversation ID. When set, per-session ConversationMemory " +
          "kicks in (sliding window + rolling summary). Generate fresh per " +
          "session; do not reuse across users.",
      }),
    ),
    turn: Type.Optional(
      Type.Integer({
        minimum: 1,
        description: "Optional caller-provided turn number. Server derives if omitted.",
      }),
    ),
  },
  {
    $id: "ChatRequest",
    additionalProperties: false,
  },
);
export type ChatRequest = Static<typeof ChatRequestSchema>;

const RouterMetaSchema = Type.Object({
  intent: Type.Union([
    Type.Literal("faq"),
    Type.Literal("property_search"),
    Type.Literal("viewing_request"),
    Type.Literal("complaint"),
    Type.Literal("chitchat"),
  ]),
  confidence: Type.Number({ minimum: 0, maximum: 1 }),
});

const GuardMetaSchema = Type.Object({
  verdict: Type.Union([
    Type.Literal("safe"),
    Type.Literal("suspicious"),
    Type.Literal("malicious"),
  ]),
  block: Type.Boolean(),
  reasons: Type.Array(Type.String()),
});

const RetrievalChunkSchema = Type.Object({
  source: Type.String(),
  heading: Type.String(),
  score: Type.Number(),
});

const TokensSchema = Type.Object({
  prompt: Type.Integer(),
  completion: Type.Integer(),
});

export const ChatResponseSchema = Type.Object(
  {
    conversationId: Type.String(),
    response: Type.String({ description: "Assistant reply text." }),
    intent: Type.String(),
    meta: Type.Object({
      guard: GuardMetaSchema,
      router: RouterMetaSchema,
      retrieval: Type.Array(RetrievalChunkSchema),
      tokens: TokensSchema,
      costUsd: Type.Number(),
      latencyMs: Type.Integer(),
      backend: Type.Union([
        Type.Literal("openai"),
        Type.Literal("azure"),
        Type.Literal("github-models"),
      ]),
      model: Type.String(),
    }),
  },
  { $id: "ChatResponse", additionalProperties: false },
);
export type ChatResponse = Static<typeof ChatResponseSchema>;

// ─── /health ─────────────────────────────────────────────────────────────────

export const HealthResponseSchema = Type.Object(
  {
    status: Type.Literal("ok"),
    backend: Type.String(),
    model: Type.String(),
  },
  { $id: "HealthResponse", additionalProperties: false },
);
export type HealthResponse = Static<typeof HealthResponseSchema>;

// ─── /ready ──────────────────────────────────────────────────────────────────

export const ReadyResponseSchema = Type.Object(
  {
    ready: Type.Boolean(),
    checks: Type.Object({
      ragIndex: Type.Boolean(),
      llmBackend: Type.Boolean(),
    }),
  },
  { $id: "ReadyResponse", additionalProperties: false },
);
export type ReadyResponse = Static<typeof ReadyResponseSchema>;

// ─── /metrics ────────────────────────────────────────────────────────────────

export const MetricsResponseSchema = Type.Object(
  {
    turns: Type.Integer(),
    intents: Type.Optional(Type.Record(Type.String(), Type.Integer())),
    latency: Type.Optional(
      Type.Object({
        p50: Type.Integer(),
        p95: Type.Integer(),
      }),
    ),
    tokens: Type.Optional(
      Type.Object({
        prompt: Type.Integer(),
        completion: Type.Integer(),
      }),
    ),
    cost: Type.Optional(
      Type.Object({
        total: Type.Number(),
        avgPerTurn: Type.Number(),
        totalFormatted: Type.String(),
      }),
    ),
    message: Type.Optional(Type.String()),
  },
  { $id: "MetricsResponse", additionalProperties: false },
);
export type MetricsResponse = Static<typeof MetricsResponseSchema>;

// ─── Errors ──────────────────────────────────────────────────────────────────

export const ErrorResponseSchema = Type.Object(
  {
    error: Type.String({ description: "Stable machine-readable error code." }),
    message: Type.Optional(Type.String({ description: "Human-readable detail." })),
    statusCode: Type.Optional(Type.Integer()),
  },
  { $id: "ErrorResponse", additionalProperties: false },
);
export type ErrorResponse = Static<typeof ErrorResponseSchema>;
