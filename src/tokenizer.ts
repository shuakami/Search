/**
 * Mixed-script tokenizer used by both the builder and the runtime.
 *
 * - ASCII alphanumeric runs are kept whole (`hello`, `webp123`).
 * - CJK Unified Ideographs (U+3400..U+9FFF) are split into single characters.
 * - Combining marks are stripped via NFKD; punctuation collapses to whitespace.
 * - Everything is lower-cased so query-time and build-time produce the same
 *   token stream.
 *
 * The tokenizer is intentionally small and dependency-free so it can run in any
 * JS runtime (browser, Node, Bun, Deno, Workers).
 */

const ASCII_RE = /[a-z0-9]/;
const ALNUM_RUN_RE = /[a-z0-9]+/g;
const CJK_RE = /[\u3400-\u9fff]/;
const COMBINING_MARKS_RE = /[\u0300-\u036f]/g;

/** Apply NFKD, drop diacritics, lower-case, collapse separator runs. */
export function normalizeText(input: string | null | undefined): string {
  return String(input || "")
    .normalize("NFKD")
    .replace(COMBINING_MARKS_RE, "")
    .toLowerCase()
    .replace(/[\u2010-\u2015_./\\|:+#]+/g, " ")
    .replace(/[^\p{L}\p{N}\s-]/gu, " ")
    .replace(/[-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Trim and collapse internal whitespace without lower-casing. */
export function collapseWhitespace(input: string | null | undefined): string {
  return String(input || "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Produce a flat token stream:
 *   "Hello 世界 v1" -> ["hello", "世", "界", "v1"]
 *
 * ASCII runs, CJK characters, and any other Unicode segments separated by
 * whitespace become individual tokens. Tokens are already normalized.
 */
export function tokenize(input: string): string[] {
  const text = normalizeText(input);
  const out: string[] = [];
  let index = 0;

  while (index < text.length) {
    const char = text[index];

    if (char === " ") {
      index += 1;
      continue;
    }

    if (ASCII_RE.test(char)) {
      let nextIndex = index + 1;
      while (nextIndex < text.length && ASCII_RE.test(text[nextIndex])) {
        nextIndex += 1;
      }
      out.push(text.slice(index, nextIndex));
      index = nextIndex;
      continue;
    }

    if (CJK_RE.test(char)) {
      out.push(char);
      index += 1;
      continue;
    }

    let nextIndex = index + 1;
    while (nextIndex < text.length && text[nextIndex] !== " ") {
      nextIndex += 1;
    }
    out.push(text.slice(index, nextIndex));
    index = nextIndex;
  }

  return out;
}

export function isAsciiToken(token: string): boolean {
  return /^[a-z0-9]+$/.test(token);
}

/** Concatenate ASCII runs only — useful for matching `ssl check` against `sslcheck`. */
export function asciiJoin(input: string): string {
  const matches = normalizeText(input).match(ALNUM_RUN_RE);
  return matches ? matches.join("") : "";
}

/** Concatenate every token (ASCII + CJK) without separators. */
export function compactJoin(input: string): string {
  return tokenize(input).join("");
}

/** Generate inclusive n-grams over a string for the requested size range. */
export function grams(term: string, min = 2, max = 3): string[] {
  const out: string[] = [];
  const maxSize = Math.min(max, term.length);

  for (let size = min; size <= maxSize; size += 1) {
    for (let index = 0; index + size <= term.length; index += 1) {
      out.push(term.slice(index, index + size));
    }
  }

  return out;
}

/** Bounded Damerau-Levenshtein with adjacent-transposition support. */
export function damerauLevenshtein(
  left: string,
  right: string,
  maxDistance = 2,
): number {
  if (left === right) {
    return 0;
  }

  const leftLength = left.length;
  const rightLength = right.length;

  if (Math.abs(leftLength - rightLength) > maxDistance) {
    return maxDistance + 1;
  }

  const previousPrevious = new Uint16Array(rightLength + 1);
  const previous = new Uint16Array(rightLength + 1);
  const current = new Uint16Array(rightLength + 1);

  for (let column = 0; column <= rightLength; column += 1) {
    previous[column] = column;
  }

  for (let row = 1; row <= leftLength; row += 1) {
    current[0] = row;
    let rowMinimum = current[0];

    for (let column = 1; column <= rightLength; column += 1) {
      const cost = left[row - 1] === right[column - 1] ? 0 : 1;
      let best = Math.min(
        previous[column] + 1,
        current[column - 1] + 1,
        previous[column - 1] + cost,
      );

      if (
        row > 1 &&
        column > 1 &&
        left[row - 1] === right[column - 2] &&
        left[row - 2] === right[column - 1]
      ) {
        best = Math.min(best, previousPrevious[column - 2] + cost);
      }

      current[column] = best;
      if (best < rowMinimum) {
        rowMinimum = best;
      }
    }

    if (rowMinimum > maxDistance) {
      return maxDistance + 1;
    }

    previousPrevious.set(previous);
    previous.set(current);
  }

  return previous[rightLength];
}

/**
 * Generate the set of strings reachable from `term` by deleting up to
 * `maxDeletes` characters. Used to power the SymSpell-style fuzzy lookup at
 * query time without an O(N * V) scan over the vocabulary.
 */
export function generateDeletes(term: string, maxDeletes = 1): string[] {
  const seen = new Set<string>();
  const out: string[] = [];

  function walk(current: string, depth: number, start: number) {
    if (depth >= maxDeletes) {
      return;
    }
    for (let index = start; index < current.length; index += 1) {
      const next = current.slice(0, index) + current.slice(index + 1);
      if (!next || seen.has(next)) {
        continue;
      }
      seen.add(next);
      out.push(next);
      walk(next, depth + 1, index);
    }
  }

  walk(term, 0, 0);
  return out;
}

/** Jaccard-like overlap on character bigrams in [0, 1]. */
export function bigramOverlap(left: string, right: string): number {
  if (left.length < 2 || right.length < 2) {
    return left[0] === right[0] ? 1 : 0;
  }

  const leftSet = new Set(grams(left, 2, 2));
  const rightSet = new Set(grams(right, 2, 2));
  let matches = 0;

  for (const gram of leftSet) {
    if (rightSet.has(gram)) {
      matches += 1;
    }
  }

  return matches / Math.max(leftSet.size, rightSet.size, 1);
}

export const __testing = { CJK_RE };
