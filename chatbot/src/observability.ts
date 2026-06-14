/**
 * Observability — OpenTelemetry GenAI semantic conventions, span emitter.
 *
 * Builds a structured trace span per chatbot turn, mapping our internal
 * `ConversationTurn` shape onto the **OpenTelemetry GenAI Semantic Conventions**
 * (stabilising through 2026). This is the lock-in-safe attribute schema that
 * Langfuse, LangSmith, Helicone, Laminar, and OTLP collectors all converge on.
 *
 * **Why bother with this layer when we already write JSONL?**
 *   - JSONL is for local dev and `jq` inspection
 *   - The OTel-shaped span is what production observability backends expect
 *   - When we ship to Azure App Service, swapping `emitSpan` from console-JSONL
 *     to an OTLP exporter is the only change needed
 *
 * Reference:
 *   - OTel GenAI Semantic Conventions
 *     https://opentelemetry.io/docs/specs/semconv/gen-ai/
 *   - Langfuse / OTel integration
 *     https://langfuse.com/integrations/native/opentelemetry
 *
 * Attributes we currently emit (`gen_ai.*` namespace + custom `ulovdomov.*`):
 *
 *   gen_ai.system            "openai" | "azure_openai"
 *   gen_ai.request.model     deployment / model name
 *   gen_ai.usage.input_tokens   prompt tokens
 *   gen_ai.usage.output_tokens  completion tokens
 *   gen_ai.response.cost_usd    estimated USD cost
 *
 *   ulovdomov.router.intent     classified intent
 *   ulovdomov.router.confidence router confidence
 *   ulovdomov.guard.verdict     guard verdict
 *   ulovdomov.retrieval.sources comma-separated RAG source filenames
 *   ulovdomov.tools.invoked     comma-separated tool names (if any)
 *
 * Custom attributes use the `ulovdomov.*` namespace to stay out of the
 * reserved `gen_ai.*` space — OTel reserves that for the spec.
 */

import type { ConversationTurn } from "./conversation-log.js";

export interface Span {
  name: string;
  traceId: string;
  spanId: string;
  startTimeUnixNano: number;
  endTimeUnixNano: number;
  attributes: Record<string, string | number | boolean>;
  status: "OK" | "ERROR";
}

/** Build an OTel-shaped span from a completed turn. Pure function — no I/O. */
export function buildSpan(turn: ConversationTurn): Span {
  const endNs = Date.now() * 1_000_000;
  const startNs = endNs - turn.latencyMs * 1_000_000;

  const attributes: Record<string, string | number | boolean> = {
    "gen_ai.system": turn.backend === "azure" ? "azure_openai" : "openai",
    "gen_ai.request.model": turn.model,
    "gen_ai.usage.input_tokens": turn.tokensUsed.prompt,
    "gen_ai.usage.output_tokens": turn.tokensUsed.completion,
    "gen_ai.response.cost_usd": Number(turn.costUsd.toFixed(6)),

    "ulovdomov.router.intent": turn.router.intent,
    "ulovdomov.router.confidence": Number(turn.router.confidence.toFixed(3)),
    "ulovdomov.guard.verdict": turn.guard.verdict,
    "ulovdomov.guard.blocked": turn.guard.block,
    "ulovdomov.turn.number": turn.turn,
  };

  if (turn.retrieval.length > 0) {
    attributes["ulovdomov.retrieval.sources"] = turn.retrieval
      .map((r) => r.source)
      .join(",");
    attributes["ulovdomov.retrieval.top_score"] = Number(
      Math.max(...turn.retrieval.map((r) => r.score)).toFixed(3),
    );
  }
  if (turn.toolCalls.length > 0) {
    attributes["ulovdomov.tools.invoked"] = turn.toolCalls
      .map((t) => t.name)
      .join(",");
  }

  return {
    name: `chatbot.turn.${turn.router.intent}`,
    traceId: turn.conversationId,
    spanId: `${turn.conversationId}-${turn.turn}`,
    startTimeUnixNano: startNs,
    endTimeUnixNano: endNs,
    attributes,
    status: turn.guard.block ? "ERROR" : "OK",
  };
}

/**
 * Default span emitter — writes the OTel-shaped span as one JSON line to
 * stdout when `TRACE_TO_STDOUT=1`, otherwise no-op.
 *
 * Production replacement: swap this with an OTLP exporter or a Langfuse
 * client; the `Span` shape is already correct.
 */
export function emitSpan(turn: ConversationTurn): void {
  if (process.env.TRACE_TO_STDOUT !== "1") return;
  const span = buildSpan(turn);
  process.stdout.write(`${JSON.stringify({ "@trace": span })}\n`);
}
