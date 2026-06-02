/**
 * ChatSession — convenience wrapper around `processTurn()` + ConversationMemory.
 *
 * Most callers don't need to manage `history` arrays or call
 * `compactIfNeeded()` by hand. ChatSession owns a `ConversationMemory`
 * instance, feeds it into `processTurn()`, and rolls the summary tier when
 * the conversation grows past threshold.
 *
 * The lower-level `processTurn()` API stays unchanged — it still takes
 * explicit `history`. ChatSession is purely additive; existing callers
 * (server.ts, Module 3 replay, evals) keep working untouched.
 *
 * Typical use:
 *
 * ```ts
 * const session = new ChatSession();
 * const r1 = await session.send("Kolik stojí inzerát?");
 * console.log(r1.response);
 * const r2 = await session.send("A premium?");   // remembers turn 1
 * ```
 */

import { randomUUID } from "node:crypto";

import { processTurn, type ProcessTurnOutput } from "./index.js";
import { ConversationMemory, type MemoryConfig } from "./conversation-memory.js";

export interface ChatSessionConfig extends MemoryConfig {
  /** Stable ID for this conversation — generated if not provided. */
  conversationId?: string;
}

export class ChatSession {
  readonly conversationId: string;
  private readonly memory: ConversationMemory;
  private turnNumber = 0;

  constructor(config: ChatSessionConfig = {}) {
    this.conversationId = config.conversationId ?? randomUUID();
    this.memory = new ConversationMemory(config);
  }

  /**
   * Send a user message and get the assistant's response. Internally:
   *   1. Pull the sliding-window history from memory
   *   2. Run processTurn() with that history
   *   3. Append the new turn to memory
   *   4. Fire-and-forget compactIfNeeded (rolling summary)
   */
  async send(userMessage: string): Promise<ProcessTurnOutput> {
    this.turnNumber += 1;
    const { systemPrefix, recent } = this.memory.forPrompt();

    // When the rolling summary is ready, surface it as a synthetic system
    // message at the head of history. Each agent's first message is its own
    // system prompt; this one rides immediately after, giving agents the
    // compressed context for everything older than the verbatim window.
    const history: Array<{ role: "user" | "assistant" | "system"; content: string }> = systemPrefix
      ? [{ role: "system", content: systemPrefix }, ...recent]
      : recent;

    const result = await processTurn({
      userMessage,
      conversationId: this.conversationId,
      turn: this.turnNumber,
      history,
    });

    this.memory.append(userMessage, result.response);

    // Compaction runs LLM calls; not a blocker for returning the response.
    // Errors are swallowed — the session keeps working on next turn.
    this.memory.compactIfNeeded().catch(() => {
      /* silent; memory will retry on next send */
    });

    return result;
  }

  /** Current verbatim history size (count of user+assistant messages). */
  historySize(): number {
    return this.memory.size();
  }

  /** Rolling summary (null until the conversation crosses the threshold). */
  getSummary(): string | null {
    return this.memory.getSummary();
  }

  /** Number of completed turns. */
  get turn(): number {
    return this.turnNumber;
  }
}
