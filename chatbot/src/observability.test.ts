/**
 * Observability span builder tests.
 *
 * Pure-function test — no LLM calls, no network. Verifies the OTel GenAI
 * attribute mapping for a representative turn record.
 */

import { describe, it, expect } from "vitest";
import { buildSpan } from "./observability.js";
import type { ConversationTurn } from "./conversation-log.js";

const TURN: ConversationTurn = {
  ts: "2026-06-15T10:23:45Z",
  conversationId: "conv-abc",
  turn: 3,
  userMessage: "Kolik stojí inzerát?",
  router: {
    intent: "faq",
    confidence: 0.93,
    rationale: "FAQ-style pricing question.",
    usage: { prompt: 280, completion: 24 },
  },
  retrieval: [
    { source: "01-pricing.md", heading: "Prémiový inzerát", score: 0.87 },
    { source: "01-pricing.md", heading: "Štandardný inzerát", score: 0.51 },
  ],
  agentResponse: "...",
  toolCalls: [],
  latencyMs: 1420,
  tokensUsed: { prompt: 2010, completion: 187 },
  costUsd: 0.000414,
  model: "gpt-4o-mini",
  backend: "openai",
  guard: { verdict: "safe", reasons: [], block: false },
};

describe("buildSpan — OTel GenAI semantic conventions", () => {
  const span = buildSpan(TURN);

  it("maps gen_ai.* attributes correctly", () => {
    expect(span.attributes["gen_ai.system"]).toBe("openai");
    expect(span.attributes["gen_ai.request.model"]).toBe("gpt-4o-mini");
    expect(span.attributes["gen_ai.usage.input_tokens"]).toBe(2010);
    expect(span.attributes["gen_ai.usage.output_tokens"]).toBe(187);
    expect(span.attributes["gen_ai.response.cost_usd"]).toBeCloseTo(0.000414, 6);
  });

  it("uses 'azure_openai' for Azure backend", () => {
    const azureSpan = buildSpan({ ...TURN, backend: "azure" });
    expect(azureSpan.attributes["gen_ai.system"]).toBe("azure_openai");
  });

  it("emits ulovdomov.* custom namespace", () => {
    expect(span.attributes["ulovdomov.router.intent"]).toBe("faq");
    expect(span.attributes["ulovdomov.router.confidence"]).toBe(0.93);
    expect(span.attributes["ulovdomov.guard.verdict"]).toBe("safe");
    expect(span.attributes["ulovdomov.retrieval.sources"]).toContain("01-pricing.md");
  });

  it("sets status=ERROR when guard blocks", () => {
    const blocked = buildSpan({
      ...TURN,
      guard: { verdict: "malicious", reasons: ["jailbreak"], block: true },
    });
    expect(blocked.status).toBe("ERROR");
  });

  it("mints a 32-hex-char trace_id (W3C-compatible) and stores conversationId as an attribute", () => {
    // GenAI semconv 2026: conversation is an attribute, not the trace_id.
    expect(span.traceId).toHaveLength(32);
    expect(span.attributes["gen_ai.conversation.id"]).toBe("conv-abc");
    expect(span.spanId).toBe("conv-abc-3");
  });
});
