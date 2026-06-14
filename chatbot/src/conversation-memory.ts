/**
 * Conversation memory.
 *
 * Implements the **hierarchical memory** pattern that's converged on as the
 * 2026 default for production customer-support bots:
 *
 *   - **Short-term sliding window** — last N turns kept verbatim
 *   - **Mid-term rolling summary** — older turns compressed into a single
 *     summary message that becomes a system-context prefix
 *
 * Long-term RAG-over-history is **not** implemented here — for úlovdomov.cz's
 * use case (one-shot questions, rarely multi-day threads) the cost / payoff
 * is poor. It's listed as v0.3 in the roadmap.
 *
 * Reference: hierarchical memory in agent frameworks (Mem0, LangChain
 * ConversationSummaryBufferMemory, Letta MemGPT). See architecture.md
 * "Why hierarchical memory" for the design walk-through.
 */

import { getChatClient, getChatModel } from "./llm-client.js";

export type ChatTurn = { role: "user" | "assistant"; content: string };

export interface MemoryConfig {
  /** Number of most-recent turn pairs (user+assistant) to keep verbatim. Default 4. */
  windowTurns?: number;
  /** Threshold above which older turns get summarised. Default 8 pairs. */
  summaryThreshold?: number;
}

const SUMMARY_SYSTEM_PROMPT = `Si pamäťový kompresor pre realitný chatbot úlovdomov.cz.
Dostaneš sériu predchádzajúcich kôl rozhovoru. Vytvor stručný (max 3 vety)
súhrn:
  - kto je používateľ (typ otázok, jazyk)
  - kľúčové fakty, ktoré spomenul (lokalita, typ bytu, rozpočet, problémy)
  - kde rozhovor zostal — ak je akcia v polovici (otvorený ticket, čaká na odpoveď)

NEPÍŠ "Používateľ povedal..." — píš v 3. osobe ako interný brief.
Slovenčina, krátko, vecne. Žiadne emotikony.`;

export class ConversationMemory {
  private readonly history: ChatTurn[] = [];
  private summary: string | null = null;
  private readonly windowTurns: number;
  private readonly summaryThreshold: number;

  constructor(config: MemoryConfig = {}) {
    this.windowTurns = config.windowTurns ?? 4;
    this.summaryThreshold = config.summaryThreshold ?? 8;
  }

  /** Append a completed turn (user message + assistant reply). */
  append(userMessage: string, assistantReply: string): void {
    this.history.push(
      { role: "user", content: userMessage },
      { role: "assistant", content: assistantReply },
    );
  }

  /**
   * Build the conversation context to pass to the next LLM call.
   *
   * Returns:
   *   - `systemPrefix`: optional rolling summary (prepend to system prompt)
   *   - `recent`: the verbatim sliding window of recent turns
   *
   * The caller composes them: `[system, summary?, ...recent, latestUser]`.
   */
  forPrompt(): { systemPrefix: string | null; recent: ChatTurn[] } {
    const pairsKept = Math.min(this.windowTurns, this.history.length / 2);
    const recent = this.history.slice(-pairsKept * 2);
    const prefix = this.summary
      ? `### Kontext z predchádzajúceho rozhovoru\n${this.summary}`
      : null;
    return { systemPrefix: prefix, recent };
  }

  /**
   * If the conversation grew past the threshold, summarise the oldest turns
   * into the rolling summary and drop them from the verbatim window.
   *
   * Safe to call on every turn — no-op when below threshold.
   */
  async compactIfNeeded(): Promise<void> {
    const pairs = this.history.length / 2;
    if (pairs <= this.summaryThreshold) return;

    // How many pairs to summarise: keep the window's worth verbatim, summarise
    // everything older than that.
    const pairsToSummarise = Math.floor(pairs - this.windowTurns);
    const turnsToSummarise = this.history.slice(0, pairsToSummarise * 2);

    const baseSystem = this.summary
      ? `${SUMMARY_SYSTEM_PROMPT}\n\nPredošlý súhrn:\n${this.summary}`
      : SUMMARY_SYSTEM_PROMPT;

    const client = getChatClient();
    const completion = await client.chat.completions.create({
      model: getChatModel(),
      temperature: 0,
      max_tokens: 200,
      messages: [
        { role: "system", content: baseSystem },
        ...turnsToSummarise,
      ],
    });

    const newSummary = completion.choices[0]?.message?.content?.trim();
    if (newSummary) {
      this.summary = newSummary;
      // Drop the summarised turns from the verbatim history.
      this.history.splice(0, pairsToSummarise * 2);
    }
  }

  /** Current summary (or null if none yet). Useful for debugging / logging. */
  getSummary(): string | null {
    return this.summary;
  }

  /** Number of turns currently held verbatim. */
  size(): number {
    return this.history.length;
  }
}
