/**
 * Markdown chunker.
 *
 * Splits at H2 (`## `) and H3 (`### `) headings. Each chunk carries:
 *   - source: filename
 *   - heading: the H2/H3 text
 *   - content: everything between this heading and the next (or EOF)
 *
 * Why heading-aware (vs naive fixed-size): markdown H2/H3 are typically
 * semantic units. Naive chunking splits mid-sentence and breaks retrieval
 * precision. v0.2 will add overlap (last 50 tokens of chunk N prepended to
 * chunk N+1) — standard RAG improvement when chunks are long.
 */

export interface MarkdownChunk {
  source: string;
  heading: string;
  content: string;
}

export function chunkMarkdown(text: string, sourceName: string): MarkdownChunk[] {
  const lines = text.split("\n");
  const chunks: MarkdownChunk[] = [];
  let currentHeading = "(intro)";
  let currentBuf: string[] = [];

  const flush = (): void => {
    const content = currentBuf.join("\n").trim();
    if (content.length > 0) {
      chunks.push({
        source: sourceName,
        heading: currentHeading,
        content,
      });
    }
    currentBuf = [];
  };

  for (const line of lines) {
    if (/^##\s/.test(line) || /^###\s/.test(line)) {
      flush();
      currentHeading = line.replace(/^#+\s+/, "").trim();
      continue;
    }
    currentBuf.push(line);
  }
  flush();

  return chunks;
}
