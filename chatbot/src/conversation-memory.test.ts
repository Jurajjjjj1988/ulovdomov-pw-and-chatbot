/**
 * Conversation memory unit tests.
 *
 * Exercises the sliding-window logic (deterministic) but skips the LLM-based
 * compactIfNeeded() path here — that's covered by the manual evaluation
 * scripts where an OpenAI key is available.
 */

import { describe, it, expect } from "vitest";
import { ConversationMemory } from "./conversation-memory.js";

describe("ConversationMemory — sliding window", () => {
  it("returns no system prefix and empty recent on a fresh memory", () => {
    const m = new ConversationMemory();
    const { systemPrefix, recent } = m.forPrompt();
    expect(systemPrefix).toBeNull();
    expect(recent).toEqual([]);
  });

  it("keeps only the last N pairs in the window", () => {
    const m = new ConversationMemory({ windowTurns: 2 });
    for (let i = 0; i < 5; i++) {
      m.append(`user ${i}`, `assistant ${i}`);
    }
    const { recent } = m.forPrompt();
    // 2 pairs = 4 messages
    expect(recent.length).toBe(4);
    // Should be the last two pairs
    expect(recent[0]?.content).toBe("user 3");
    expect(recent[3]?.content).toBe("assistant 4");
  });

  it("doesn't compact below threshold (no LLM call)", async () => {
    const m = new ConversationMemory({ windowTurns: 2, summaryThreshold: 8 });
    for (let i = 0; i < 3; i++) {
      m.append(`u${i}`, `a${i}`);
    }
    // Below threshold — should be a no-op even without LLM credentials.
    await expect(m.compactIfNeeded()).resolves.toBeUndefined();
    expect(m.getSummary()).toBeNull();
  });

  it("tracks size", () => {
    const m = new ConversationMemory();
    expect(m.size()).toBe(0);
    m.append("hi", "hello");
    expect(m.size()).toBe(2);
  });
});
