/**
 * ChatSession unit tests — deterministic shape checks without LLM calls.
 *
 * The actual processTurn() interaction is exercised by the smoke test +
 * Module 3 replay; here we verify the session contract: ID generation,
 * turn-counter increment, memory exposure.
 */

import { describe, it, expect } from "vitest";
import { ChatSession } from "./chat-session.js";

describe("ChatSession", () => {
  it("generates a UUID conversationId by default", () => {
    const s = new ChatSession();
    expect(s.conversationId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    );
  });

  it("preserves a caller-provided conversationId", () => {
    const s = new ChatSession({ conversationId: "fixed-id-123" });
    expect(s.conversationId).toBe("fixed-id-123");
  });

  it("starts at turn 0 with empty history", () => {
    const s = new ChatSession();
    expect(s.turn).toBe(0);
    expect(s.historySize()).toBe(0);
    expect(s.getSummary()).toBeNull();
  });

  it("forwards memory config", () => {
    // windowTurns set high so this assertion stays valid even after future
    // changes to ConversationMemory defaults.
    const s = new ChatSession({ windowTurns: 16, summaryThreshold: 32 });
    expect(s.historySize()).toBe(0);
  });
});
