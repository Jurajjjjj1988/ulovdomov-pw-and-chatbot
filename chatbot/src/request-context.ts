/**
 * Request-scoped context via Node's AsyncLocalStorage.
 *
 * Pattern recommended by the 2026 OpenTelemetry GenAI docs and used by
 * @fastify/request-context: a single async store carries the request ID,
 * conversation ID, and inbound W3C traceparent through the entire async
 * call chain — orchestrator → router → agents → llm-client — without
 * adding parameters to every function signature.
 *
 * Wired in src/server.ts: an onRequest hook constructs the context object
 * from headers + body and runs the handler inside `requestContext.run()`.
 * Read elsewhere via `requestContext.getStore()`.
 *
 * **trace_id vs conversation_id (corrected per the 2026 GenAI semconv):**
 *
 *   - A trace_id identifies a SINGLE HTTP request (may span microservices).
 *     OTel mints it per request; W3C `traceparent` header lets upstream
 *     services link their trace to ours.
 *   - A conversation_id identifies a USER session that spans many requests.
 *     Lifetime is minutes-to-days. Lives as a span ATTRIBUTE
 *     (`gen_ai.conversation.id`), not as the trace_id.
 *
 * Earlier code used conversationId AS the trace_id. That's wrong by 2026
 * convention — APM backends would show one trace lasting hours, sampling
 * decisions break, retention costs explode. Fix: keep them separate.
 */

import { AsyncLocalStorage } from "node:async_hooks";

export interface RequestContext {
  /** Fastify-assigned request ID (`req-1`, `req-2`, ...) — short, log-friendly. */
  requestId: string;
  /** Per-conversation session ID — same across multiple requests in one chat. */
  conversationId: string;
  /** Inbound W3C Trace Context header, if present. Format: 00-<trace_id>-<span_id>-<flags>. */
  traceparent?: string;
}

export const requestContext = new AsyncLocalStorage<RequestContext>();

/** Convenience: read the current request ID, or "<no-context>" if not in a request. */
export function currentRequestId(): string {
  return requestContext.getStore()?.requestId ?? "<no-context>";
}

/** Extract the OTel trace_id portion of a W3C traceparent header. */
export function parseTraceparent(header: string): { traceId: string; spanId: string } | null {
  // Format: <version>-<trace-id (32 hex)>-<parent-span-id (16 hex)>-<flags (2 hex)>
  const parts = header.trim().split("-");
  if (parts.length !== 4) return null;
  if (parts[1]?.length !== 32 || parts[2]?.length !== 16) return null;
  return { traceId: parts[1], spanId: parts[2] };
}
