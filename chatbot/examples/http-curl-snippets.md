# HTTP API — curl snippets

Copy-paste examples for every endpoint. Run against the local dev server
(`npm run serve` → `http://localhost:3000`) or your deployed instance —
just substitute the host.

In dev mode the `CHATBOT_API_KEY` env var is typically unset, so
`Authorization` headers are not required. In production set the variable
and bind via an Azure Key Vault reference (see
[`deploy/main.bicep`](../deploy/main.bicep)).

---

## Health + readiness probes

```bash
# Liveness — 200 when the process + LLM client resolve
curl -s http://localhost:3000/health | jq

# Readiness — 200 only when RAG index loaded AND backend configured
curl -s http://localhost:3000/ready | jq
```

## Discover the API

```bash
# Swagger UI in a browser
open http://localhost:3000/docs

# Raw OpenAPI 3.1 spec — feed to Postman, oapi-codegen, etc.
curl -s http://localhost:3000/docs/json | jq '.info, .paths | keys'
```

## Single-turn chat

```bash
curl -s -X POST http://localhost:3000/chat \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer ${CHATBOT_API_KEY:-dev-mode}" \
  -d '{
    "message": "Kolik stojí prémiový inzerát?",
    "conversationId": "demo-session-001"
  }' | jq
```

Expected shape:

```jsonc
{
  "conversationId": "demo-session-001",
  "response": "Prémiový inzerát stojí 490 Kč ...",
  "intent": "faq",
  "meta": {
    "guard":     { "verdict": "safe", "reasons": [], "block": false },
    "router":    { "intent": "faq", "confidence": 0.95 },
    "retrieval": [ { "source": "01-pricing.md", "heading": "Prémiový inzerát", "score": 0.68 } ],
    "tokens":    { "prompt": 1923, "completion": 187 },
    "costUsd":   0.000485,
    "latencyMs": 1420,
    "backend":   "github-models",
    "model":     "gpt-4o-mini"
  }
}
```

## Multi-turn (memory at work)

Same `conversationId` across multiple requests — the server keeps a
`ConversationMemory` instance per ID. Sliding-window verbatim history is
kept up to N pairs; older content rolls into a summary that prepends to
the next system prompt.

```bash
# Turn 1
curl -s -X POST http://localhost:3000/chat \
  -H "Content-Type: application/json" \
  -d '{"message":"Kolik stojí standardní inzerát?","conversationId":"multi-turn-demo"}' | jq .response

# Turn 2 — pronominal reference; the context-aware router picks up the topic
curl -s -X POST http://localhost:3000/chat \
  -H "Content-Type: application/json" \
  -d '{"message":"A co prémiový?","conversationId":"multi-turn-demo"}' | jq .response
```

## Streaming chat (SSE)

```bash
curl -N -X POST http://localhost:3000/chat/stream \
  -H "Content-Type: application/json" \
  -H "Accept: text/event-stream" \
  -d '{"message":"Jak funguje prohlídka bytu na úlovdomove?","conversationId":"sse-demo"}'
```

You'll see an interleaved sequence of `event: guard`, `event: router`,
`event: rag`, many `event: token`, and a final `event: done`. The token
events stream incrementally — same model output, perceived faster.

Event names + payload shapes are documented under `POST /chat/stream` in
[`/docs`](http://localhost:3000/docs).

## Aggregate metrics

```bash
curl -s http://localhost:3000/metrics | jq
```

Aggregates over the JSONL conversation log: intent distribution, p50 / p95
latency, total tokens, total + per-turn cost.

## Rate limiting

The rate limits are documented in the OpenAPI spec, but they're easy to
trip from the shell:

```bash
# 20 requests in under a minute — the 21st hits 429 with a JSON body
for i in $(seq 1 25); do
  curl -s -o /dev/null -w "%{http_code}\n" -X POST http://localhost:3000/chat \
    -H "Content-Type: application/json" \
    -d '{"message":"test","conversationId":"rate-test"}'
done
```

Rate limit keys on `conversationId` (when present) before falling back to
client IP, so users on a shared NAT don't get lumped into one bucket.

## W3C trace context propagation

If you call the chatbot from a service that already participates in OTel
tracing, forward the `traceparent` header — the chatbot's OTel span will
inherit your trace ID, making upstream + downstream spans link together in
Azure Application Insights / Jaeger / Tempo.

```bash
curl -s -X POST http://localhost:3000/chat \
  -H "Content-Type: application/json" \
  -H "traceparent: 00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01" \
  -d '{"message":"ping","conversationId":"trace-test"}' | jq .meta
```

Look at the span emitter's `traceId` in the logs (`TRACE_TO_STDOUT=1`) —
it'll match the inbound trace ID.
