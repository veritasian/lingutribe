/**
 * Simplified TextTiling — segment text into meaning-based paragraphs.
 *
 * Algorithm: compute sliding-window cosine similarity between sentence blocks.
 * Split where similarity dips (valleys) or stays below threshold.
 * Returns an array of segment indices (i.e. after which sentence to break).
 *
 * Reference: Hearst, M. "TextTiling: Segmenting Text into Multi-paragraph
 * Subtopic Passages." Computational Linguistics, 1997.
 */

/** Strip punctuation from a token for comparison. */
function cleanWord(w: string): string {
  return w.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/** Build a word-frequency map for a text span. */
function termFreq(text: string): Map<string, number> {
  const m = new Map<string, number>();
  text.split(/\s+/).forEach((w) => {
    const c = cleanWord(w);
    if (c.length >= 2) m.set(c, (m.get(c) || 0) + 1);
  });
  return m;
}

/** Cosine similarity between two frequency maps. */
function cosineSim(a: Map<string, number>, b: Map<string, number>): number {
  let dot = 0, normA = 0, normB = 0;
  const allKeys = new Set([...a.keys(), ...b.keys()]);
  allKeys.forEach((k) => {
    const va = a.get(k) || 0;
    const vb = b.get(k) || 0;
    dot += va * vb;
    normA += va * va;
    normB += vb * vb;
  });
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

/** Segment text into paragraphs.  Returns array of paragraph strings. */
export function segmentText(
  text: string,
  opts?: {
    /** Window size in sentences (per side). Default 3. */
    windowSize?: number;
    /** Minimum sentences per segment. Default 2. */
    minSentences?: number;
    /** Similarity threshold below which to split. Default 0.12. */
    threshold?: number;
  }
): string[] {
  const windowSize = opts?.windowSize ?? 3;
  const minSentences = opts?.minSentences ?? 2;
  const threshold = opts?.threshold ?? 0.12;

  // Split into sentences
  const raw = text.split(/(?<=[.!?。！？…])\s+/).filter((s) => s.trim().length > 0);
  if (raw.length <= minSentences * 2) return [text.trim()];

  // Build term vectors per sentence
  const sentenceVectors = raw.map((s) => termFreq(s));

  // Sliding-window similarity scores (windowSize sentences each side)
  const similarities: number[] = [];
  for (let i = windowSize; i < sentenceVectors.length - windowSize; i++) {
    const left = raw.slice(i - windowSize, i + 1).join(" ");
    const right = raw.slice(i + 1, i + 1 + windowSize).join(" ");
    similarities.push(cosineSim(termFreq(left), termFreq(right)));
  }

  // Find valleys — similarity drops below threshold or local minimum
  const splitAfter: number[] = [];
  let lastSplit = -1;
  const centerOffset = windowSize + 1;

  for (let i = 1; i < similarities.length - 1; i++) {
    const s = similarities[i];
    // Check local minimum (valley)
    const isValley =
      s < similarities[i - 1] &&
      s <= similarities[i + 1] &&
      s < threshold;

    // Also split when similarity drops significantly (>60% drop from previous)
    const bigDrop =
      similarities[i - 1] > threshold * 2 &&
      s < similarities[i - 1] * 0.4;

    if ((isValley || bigDrop) && (i + centerOffset - lastSplit >= minSentences)) {
      splitAfter.push(i + centerOffset);
      lastSplit = i + centerOffset;
    }
  }

  // Build paragraphs from split points
  const paragraphs: string[] = [];
  let start = 0;
  splitAfter.forEach((idx) => {
    paragraphs.push(raw.slice(start, idx).join(" ").trim());
    start = idx;
  });
  if (start < raw.length) {
    paragraphs.push(raw.slice(start).join(" ").trim());
  }

  return paragraphs.length > 1 ? paragraphs : [text.trim()];
}
