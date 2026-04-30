import type { BenchmarkDoc } from "./adapters";

const STOP_WORDS = new Set([
  "a",
  "an",
  "and",
  "are",
  "as",
  "at",
  "be",
  "by",
  "for",
  "from",
  "has",
  "he",
  "in",
  "is",
  "it",
  "its",
  "of",
  "on",
  "that",
  "the",
  "to",
  "was",
  "were",
  "will",
  "with",
  "this",
  "these",
  "those",
  "you",
  "your",
  "we",
  "us",
  "our",
  "i",
  "or",
  "but",
  "not",
  "so",
  "if",
  "than",
  "then",
  "there",
  "they",
  "them",
  "their",
  "have",
  "had",
  "do",
  "does",
  "did",
  "can",
  "could",
  "should",
  "would",
]);

function pick<T>(items: readonly T[], rng: () => number): T {
  return items[Math.floor(rng() * items.length)];
}

function mulberry32(seed: number) {
  let state = seed >>> 0;
  return function () {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function asciiTokens(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((token) => token.length >= 3 && !STOP_WORDS.has(token));
}

function cjkChars(text: string): string[] {
  const out: string[] = [];
  for (const char of text) {
    if (/[\u3400-\u9fff]/.test(char)) out.push(char);
  }
  return out;
}

function injectTypo(token: string, rng: () => number): string {
  if (token.length < 4) return token;
  const at = Math.floor(rng() * token.length);
  if (rng() < 0.5) {
    return token.slice(0, at) + token.slice(at + 1);
  }
  if (at === token.length - 1) return token;
  return (
    token.slice(0, at) + token[at + 1] + token[at] + token.slice(at + 2)
  );
}

export interface BenchmarkQuery {
  query: string;
  /** Doc IDs that contain the query tokens — our pseudo ground truth. */
  truth: readonly string[];
}

/**
 * Pull camelCase / snake_case / kebab-case identifiers out of code text. We
 * keep the original casing — code-search corpora are case-sensitive in the
 * way users actually type queries (`useState`, not `usestate`).
 */
function codeSymbols(text: string): string[] {
  const out: string[] = [];
  const re = /[A-Za-z_][A-Za-z_0-9]{4,30}/g;
  for (const match of text.matchAll(re)) {
    const token = match[0];
    if (
      /[A-Z]/.test(token.slice(1)) ||
      token.includes("_")
    ) {
      out.push(token);
    }
  }
  return out;
}

interface QueryAttempt {
  build(): string | null;
  truthFor(query: string): readonly string[];
}

function tryGenerate(out: BenchmarkQuery[], target: number, attempt: QueryAttempt) {
  let added = 0;
  for (let i = 0; i < target * 4 && added < target; i += 1) {
    const query = attempt.build();
    if (!query) continue;
    const truth = attempt.truthFor(query);
    if (truth.length === 0) continue;
    out.push({ query, truth });
    added += 1;
  }
}

/**
 * Generate ~queryCount queries that hit at least one doc. The distribution
 * is intentionally mixed: ASCII single-words and short phrases dominate
 * (this is what users mostly type), but we also throw in typos, CJK pairs,
 * code symbols, prefix-only queries, and 3-4 word multi-token queries.
 *
 * Truth sets are computed per-query against the raw corpus using simple
 * substring containment — every engine should match those at recall=1, so
 * the recall column in the bench is a real apples-to-apples comparison.
 */
export function generateQueries(
  docs: readonly BenchmarkDoc[],
  queryCount: number,
  seed = 0xdeadbeef,
): BenchmarkQuery[] {
  const rng = mulberry32(seed);
  const out: BenchmarkQuery[] = [];

  // 45% — single ASCII token from a random doc title or body
  tryGenerate(out, Math.floor(queryCount * 0.45), {
    build: () => {
      const doc = pick(docs, rng);
      const tokens = asciiTokens(doc.title || doc.body || "");
      if (tokens.length === 0) return null;
      return pick(tokens, rng);
    },
    truthFor: (q) => matchingDocs(docs, [q]),
  });

  // 15% — two-token phrase from a random title
  tryGenerate(out, Math.floor(queryCount * 0.15), {
    build: () => {
      const doc = pick(docs, rng);
      const tokens = asciiTokens(doc.title || "");
      if (tokens.length < 2) return null;
      const start = Math.floor(rng() * (tokens.length - 1));
      return `${tokens[start]} ${tokens[start + 1]}`;
    },
    truthFor: (q) => matchingDocs(docs, q.split(" ")),
  });

  // 10% — typo'd single token: ground truth is docs containing the *original*
  // word so engines without fuzzy matching are scored fairly low.
  {
    const target = Math.floor(queryCount * 0.1);
    let added = 0;
    for (let i = 0; i < target * 4 && added < target; i += 1) {
      const doc = pick(docs, rng);
      const tokens = asciiTokens(doc.title || doc.body || "").filter(
        (t) => t.length >= 5,
      );
      if (tokens.length === 0) continue;
      const token = pick(tokens, rng);
      const typo = injectTypo(token, rng);
      if (typo === token) continue;
      const truth = matchingDocs(docs, [token]);
      if (truth.length === 0) continue;
      out.push({ query: typo, truth });
      added += 1;
    }
  }

  // 10% — CJK bigram (corpora without CJK simply add zero queries here)
  tryGenerate(out, Math.floor(queryCount * 0.1), {
    build: () => {
      const doc = pick(docs, rng);
      const chars = cjkChars(doc.title || doc.body || "");
      if (chars.length < 2) return null;
      const start = Math.floor(rng() * (chars.length - 1));
      return chars[start] + chars[start + 1];
    },
    truthFor: (q) => matchingDocs(docs, [q]),
  });

  // 5% — long multi-token query (3-4 tokens) from body content
  tryGenerate(out, Math.floor(queryCount * 0.05), {
    build: () => {
      const doc = pick(docs, rng);
      const tokens = asciiTokens(doc.body || doc.title || "");
      if (tokens.length < 4) return null;
      const start = Math.floor(rng() * (tokens.length - 3));
      const len = 3 + Math.floor(rng() * 2); // 3 or 4 tokens
      return tokens.slice(start, start + len).join(" ");
    },
    truthFor: (q) => matchingDocs(docs, q.split(" ")),
  });

  // 5% — code symbol (CamelCase / snake_case)
  tryGenerate(out, Math.floor(queryCount * 0.05), {
    build: () => {
      const doc = pick(docs, rng);
      const symbols = codeSymbols(doc.body || doc.title || "");
      if (symbols.length === 0) return null;
      return pick(symbols, rng);
    },
    truthFor: (q) => matchingDocs(docs, [q.toLowerCase()]),
  });

  // 5% — prefix-only query (first 3-5 chars of an existing token)
  tryGenerate(out, Math.floor(queryCount * 0.05), {
    build: () => {
      const doc = pick(docs, rng);
      const tokens = asciiTokens(doc.title || doc.body || "").filter(
        (t) => t.length >= 6,
      );
      if (tokens.length === 0) return null;
      const token = pick(tokens, rng);
      const length = 3 + Math.floor(rng() * 3);
      return token.slice(0, length);
    },
    truthFor: (q) => matchingDocs(docs, [q]),
  });

  // 5% — rare-tail token: pick a word that appears in only a handful of docs
  tryGenerate(out, Math.floor(queryCount * 0.05), {
    build: () => {
      const doc = pick(docs, rng);
      const tokens = asciiTokens(doc.title || doc.body || "");
      if (tokens.length === 0) return null;
      // Try a few candidates; keep the rarest one that still hits 1+ docs.
      let best: { token: string; count: number } | null = null;
      for (let i = 0; i < 6; i += 1) {
        const token = pick(tokens, rng);
        if (token.length < 5) continue;
        const count = matchingDocs(docs, [token]).length;
        if (count > 0 && (!best || count < best.count)) {
          best = { token, count };
        }
      }
      return best?.token ?? null;
    },
    truthFor: (q) => matchingDocs(docs, [q]),
  });

  return out;
}

function matchingDocs(
  docs: readonly BenchmarkDoc[],
  needles: readonly string[],
): string[] {
  const lowered = needles.map((needle) => needle.toLowerCase());
  const matches: string[] = [];
  for (const doc of docs) {
    const haystack = (
      (doc.title || "") +
      " " +
      (doc.body || "") +
      " " +
      (doc.url || "") +
      " " +
      (doc.keywords || []).join(" ")
    ).toLowerCase();
    if (lowered.every((needle) => haystack.includes(needle))) {
      matches.push(doc.id);
    }
  }
  return matches;
}
