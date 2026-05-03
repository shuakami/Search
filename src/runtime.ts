/**
 * Load a binary search pack and expose a synchronous `search()` function.
 *
 * The runtime is the only piece that ships to the client. It is allocation-
 * conscious (Float32Array / Uint32Array scratch buffers, Map lookups, no
 * TypedArray growth in the hot path) and has no external dependencies.
 */

import {
  asciiJoin,
  bigramOverlap,
  compactJoin,
  damerauLevenshtein,
  generateDeletes,
  grams,
  normalizeText,
  tokenize,
} from "./tokenizer";
import {
  PACK_MAGIC,
  PACK_VERSION,
  TOKEN_TYPE_BIGRAM_ASCII,
  TOKEN_TYPE_BIGRAM_HAN,
  TOKEN_TYPE_COUNT,
  TOKEN_TYPE_EXACT,
  TOKEN_TYPE_JOIN,
  TOKEN_TYPE_PREFIX,
  TOKEN_TYPE_SIGNAL,
} from "./format";
import { VarintReader } from "./varint";

/** A document recovered from the pack — only stored fields come back. */
export interface StoredDocument {
  id: string;
  fields: Record<string, string>;
  tags: readonly string[];
}

/** A character range `[startInclusive, endInclusive]` inside a stored field. */
export type MatchRange = readonly [number, number];

/** Highlight matches grouped by the stored field they apply to. */
export interface FieldMatches {
  field: string;
  ranges: readonly MatchRange[];
}

export interface SearchHit {
  doc: StoredDocument;
  score: number;
  /** Insertion order of this hit before the final sort — useful for tie-break. */
  refIndex: number;
  matches: readonly FieldMatches[];
}

export interface SearchOptions {
  /** Maximum number of hits to return. Default: 10. */
  limit?: number;
  /**
   * Drop hits whose normalized score is below `topScore * minScoreRatio`.
   * Default: 0.18. Set to 0 to keep every hit returned by the engine.
   */
  minScoreRatio?: number;
  /** Optional client-side filter applied after scoring. */
  filter?: (doc: StoredDocument) => boolean;
  /**
   * Optional rescorer. Return a NEW score; the engine will re-sort accordingly.
   * Use this to bake in domain knowledge (recency, popularity, locale boosts).
   */
  rescore?: (hit: SearchHit) => number;
  /**
   * If truthy, fields whose names appear here are matched for highlighting in
   * the order given. Defaults to every stored field.
   */
  highlightFields?: readonly string[];
}

/**
 * One typo correction applied during fuzzy recovery — useful for surfacing
 * a "did you mean: …" hint in the UI.
 */
export interface QueryCorrection {
  /** The token the user actually typed, lowercased and normalised. */
  from: string;
  /** The indexed term the engine matched it to. */
  to: string;
  /** Damerau–Levenshtein edit distance between `from` and `to` (1 or 2). */
  distance: number;
}

/**
 * Rich search result that also exposes whether the engine had to correct any
 * typos to find these hits, plus a single suggested rewrite of the original
 * query (`correctedQuery`) for "did you mean" prompts.
 */
export interface DetailedSearchResult {
  hits: SearchHit[];
  /**
   * The original query rewritten with corrections applied. `null` when the
   * engine did not need to correct anything (i.e. all hits came from direct
   * matches).
   */
  correctedQuery: string | null;
  /** Each individual correction used while running the query. */
  corrections: readonly QueryCorrection[];
}

/** A single autocomplete candidate produced by `suggest()`. */
export interface SuggestHit {
  /** The completed term (lowercased, indexed form). */
  term: string;
  /**
   * Number of documents the term occurs in. Higher = more popular within the
   * corpus, useful for ranking suggestions in the UI.
   */
  docFrequency: number;
  /** How the suggestion was obtained — direct prefix match or fuzzy recovery. */
  kind: "prefix" | "fuzzy";
  /** Edit distance from the input prefix when `kind === "fuzzy"`. */
  distance?: number;
}

export interface SuggestOptions {
  /** Maximum number of suggestions to return. Default: 8. */
  limit?: number;
  /**
   * If true and no prefix candidates exist, fall back to the fuzzy table to
   * recover from typos in the prefix itself. Default: true.
   */
  fuzzy?: boolean;
}

export interface SearchEngine {
  /** Run a query. Synchronous, no I/O, no allocations beyond the result list. */
  search(query: string, options?: SearchOptions): SearchHit[];
  /**
   * Same as `search()`, but additionally returns the rewritten query and the
   * list of corrections applied so the UI can show a "did you mean" hint.
   */
  searchDetailed(
    query: string,
    options?: SearchOptions,
  ): DetailedSearchResult;
  /**
   * Autocomplete / type-ahead helper. Returns up to `limit` indexed terms
   * that begin with `prefix`, ranked by document frequency. ASCII only.
   */
  suggest(prefix: string, options?: SuggestOptions): SuggestHit[];
  /** Stored documents in pack order, useful for warmup / debug. */
  readonly docs: readonly StoredDocument[];
  /** Pack-level statistics, derived from the binary at load time. */
  readonly stats: {
    docs: number;
    features: number;
    postings: number;
    deletes: number;
    storedFields: readonly string[];
  };
}

interface InternalDocument extends StoredDocument {
  signalCompact: string;
  signalAscii: string;
  /**
   * Loose union of every stored field plus tags, lowercased and stripped of
   * separators. Used by the query-quality gate to verify the query hits
   * *something* — including URL paths and tags that the ranking signal
   * deliberately excludes to keep the pack tight.
   */
  gateCompact: string;
  /** ASCII-only twin of `gateCompact` for "sslcheck" / "githubapi" style joins. */
  gateAscii: string;
}

interface TokenSlot {
  readonly offset: number;
  readonly count: number;
}

function toUint8Array(input: ArrayBuffer | Uint8Array): Uint8Array {
  if (input instanceof Uint8Array) return input;
  return new Uint8Array(input);
}

function findMatchRanges(
  text: string,
  needles: readonly string[],
  maxMatches = 12,
): MatchRange[] {
  if (!text || needles.length === 0) {
    return [];
  }
  const haystack = text.toLowerCase();
  const ranges: Array<[number, number]> = [];
  for (const needle of needles) {
    let startIndex = 0;
    while (startIndex < haystack.length) {
      const matchIndex = haystack.indexOf(needle, startIndex);
      if (matchIndex < 0) {
        break;
      }
      ranges.push([matchIndex, matchIndex + needle.length - 1]);
      if (ranges.length >= maxMatches) {
        return mergeRanges(ranges);
      }
      startIndex = matchIndex + needle.length;
    }
  }
  return mergeRanges(ranges);
}

function mergeRanges(ranges: Array<[number, number]>): MatchRange[] {
  if (ranges.length === 0) return [];
  ranges.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const merged: Array<[number, number]> = [ranges[0]];
  for (let index = 1; index < ranges.length; index += 1) {
    const current = ranges[index];
    const last = merged[merged.length - 1];
    if (current[0] <= last[1] + 1) {
      last[1] = Math.max(last[1], current[1]);
      continue;
    }
    merged.push(current);
  }
  return merged;
}

const CJK_NEEDLE_RE = /[\u3400-\u9fff]/;

function buildHighlightNeedles(query: string): string[] {
  const normalized = normalizeText(query);
  const tokens = tokenize(normalized).filter((token) => token.length >= 2);
  const joinedAscii = asciiJoin(normalized);
  const compact = compactJoin(normalized);
  const compactBigrams =
    compact.length >= 2 && compact.length <= 24
      ? grams(compact, 2, 2).filter((gram) => CJK_NEEDLE_RE.test(gram))
      : [];

  return Array.from(
    new Set(
      [
        ...tokens,
        ...compactBigrams,
        joinedAscii.length >= 2 ? joinedAscii : "",
        compact.length >= 2 ? compact : "",
      ].filter(Boolean),
    ),
  ).sort((left, right) => right.length - left.length);
}

export function loadIndex(input: ArrayBuffer | Uint8Array): SearchEngine {
  const bytes = toUint8Array(input);
  const reader = new VarintReader(bytes);

  const magic = reader.readUint32LE();
  if (magic !== PACK_MAGIC) {
    throw new Error(
      `loadIndex: bad magic 0x${magic.toString(16).padStart(8, "0")}; ` +
        `expected SCH1 (0x${PACK_MAGIC.toString(16).padStart(8, "0")}).`,
    );
  }
  const version = reader.readUint16LE();
  if (version !== PACK_VERSION) {
    throw new Error(`loadIndex: unsupported pack version ${version}`);
  }
  reader.readUint16LE(); // flags reserved

  const docCount = reader.readUint32LE();
  const tokenCount = reader.readUint32LE();

  const decoder = new TextDecoder();

  function readString(): string {
    const length = reader.readVarint();
    return decoder.decode(reader.readBytes(length));
  }

  const storedFieldCount = reader.readVarint();
  const storedFieldNames: string[] = [];
  for (let index = 0; index < storedFieldCount; index += 1) {
    storedFieldNames.push(readString());
  }

  const docs = new Array<InternalDocument>(docCount);
  for (let index = 0; index < docCount; index += 1) {
    const id = readString();
    const fields: Record<string, string> = {};
    for (const fieldName of storedFieldNames) {
      fields[fieldName] = readString();
    }
    const signalCompact = readString();
    const signalAscii = readString();
    const tagCount = reader.readVarint();
    const tags: string[] = [];
    for (let tag = 0; tag < tagCount; tag += 1) {
      tags.push(readString());
    }
    // Build the gate join once at load time. It must include the *indexed*
    // signal text, not just the stored fields — apps frequently store only
    // `title` + `url` while indexing a much larger `body`, and we don't want
    // queries that legitimately hit the body to be rejected by the gate.
    // The signal join already contains every non-URL indexed field, so we
    // start from it and union the stored URLs and tags on top so URL-only or
    // tag-only matches still satisfy the gate.
    const gateParts: string[] = [signalCompact];
    for (const name of storedFieldNames) gateParts.push(fields[name] || "");
    for (const tag of tags) gateParts.push(tag);
    const gateJoined = gateParts.join(" ");
    // signalCompact / signalAscii are *already* compacted, so re-running the
    // join over them is idempotent — we just need to fold in the URLs/tags.
    const gateCompact = compactJoin(gateJoined);
    const gateAscii = asciiJoin(
      [signalAscii, ...storedFieldNames.map((n) => fields[n] || ""), ...tags].join(
        " ",
      ),
    );
    docs[index] = {
      id,
      fields,
      tags,
      signalCompact,
      signalAscii,
      gateCompact,
      gateAscii,
    };
  }

  const typeMaps: Map<string, TokenSlot>[] = new Array(TOKEN_TYPE_COUNT);
  for (let index = 0; index < TOKEN_TYPE_COUNT; index += 1) {
    typeMaps[index] = new Map();
  }
  const tokenPostingOffsets = new Int32Array(tokenCount);
  const tokenPostingCounts = new Int32Array(tokenCount);
  const tokenTerms = new Array<string>(tokenCount);
  const tokenTypes = new Uint8Array(tokenCount);

  for (let tokenId = 0; tokenId < tokenCount; tokenId += 1) {
    const header = reader.readByte();
    const typeValue = (header >>> 5) & 0x07;
    const shortLen = header & 0x1f;
    const nameLen =
      shortLen < 0x1f ? shortLen : reader.readVarint() + 0x1f;
    const name = decoder.decode(reader.readBytes(nameLen));

    const postingCountOffset = reader.position;
    const postingCount = reader.readVarint();
    typeMaps[typeValue].set(name, {
      offset: postingCountOffset,
      count: postingCount,
    });
    tokenPostingOffsets[tokenId] = postingCountOffset;
    tokenPostingCounts[tokenId] = postingCount;
    tokenTerms[tokenId] = name;
    tokenTypes[tokenId] = typeValue;

    // Skip the posting payload — we re-read it lazily per query.
    for (let posting = 0; posting < postingCount; posting += 1) {
      reader.readVarint(); // doc delta
      reader.readVarint(); // score
    }
  }

  const deleteCount = reader.readVarint();
  const deleteLookup = new Map<string, Int32Array>();
  for (let index = 0; index < deleteCount; index += 1) {
    const keyLen = reader.readVarint();
    const key = decoder.decode(reader.readBytes(keyLen));
    const candidateCount = reader.readVarint();
    const tokenIds = new Int32Array(candidateCount);
    let previous = 0;
    for (let c = 0; c < candidateCount; c += 1) {
      const delta = reader.readVarint();
      const tokenId = c === 0 ? delta : previous + delta;
      tokenIds[c] = tokenId;
      previous = tokenId;
    }
    deleteLookup.set(key, tokenIds);
  }

  const tokenOffsetToId = new Map<number, number>();
  for (let id = 0; id < tokenCount; id += 1) {
    tokenOffsetToId.set(tokenPostingOffsets[id], id);
  }

  const exactMap = typeMaps[TOKEN_TYPE_EXACT];
  const prefixMap = typeMaps[TOKEN_TYPE_PREFIX];
  const signalMap = typeMaps[TOKEN_TYPE_SIGNAL];
  const joinMap = typeMaps[TOKEN_TYPE_JOIN];
  const hanBigramMap = typeMaps[TOKEN_TYPE_BIGRAM_HAN];
  const asciiBigramMap = typeMaps[TOKEN_TYPE_BIGRAM_ASCII];

  const scores = new Float32Array(docCount);
  const touched = new Uint32Array(docCount);
  const seenGeneration = new Uint32Array(docCount);
  // Per-doc gate-auto-pass marker. When a posting *from an anchor-quality
  // feature* (exact / prefix / joinedAscii signal / joinedAscii join) touches
  // a doc, we mark it. The query-quality gate then short-circuits for
  // marked docs and avoids 4–6 String.includes() calls per doc, which on
  // 10k-doc corpora cuts hot-query latency by 5–10×.
  const gateGeneration = new Uint32Array(docCount);
  // Per-doc multi-token coverage mask. Each query token gets a unique bit;
  // when the token's *exact* posting touches a doc, we OR the bit in. After
  // the posting pass, we know which docs covered every query token without
  // needing a substring scan over a (capped, possibly-truncated) signal
  // string. Bit 31 is reserved for "covered by some non-token anchor
  // feature" so multi-token bonuses still kick in when one token came in
  // via signal/join rather than an exact hit.
  const coverMask = new Uint32Array(docCount);
  let generation = 1;

  function addPostingByTokenId(
    tokenId: number,
    multiplier: number,
    touchedState: { count: number },
    markAnchor: boolean,
    coverBit: number,
  ) {
    const offset = tokenPostingOffsets[tokenId];
    const count = tokenPostingCounts[tokenId];
    const local = new VarintReader(bytes);
    local.position = offset;
    local.readVarint(); // posting_count (already known)

    let docId = 0;
    for (let index = 0; index < count; index += 1) {
      const delta = local.readVarint();
      const score = local.readVarint();
      docId = index === 0 ? delta : docId + delta;

      if (seenGeneration[docId] !== generation) {
        seenGeneration[docId] = generation;
        scores[docId] = 0;
        coverMask[docId] = 0;
        touched[touchedState.count++] = docId;
      }
      scores[docId] += score * multiplier;
      if (markAnchor) gateGeneration[docId] = generation;
      if (coverBit !== 0) coverMask[docId] |= coverBit;
    }
  }

  function addPostingByMapEntry(
    entry: TokenSlot,
    multiplier: number,
    touchedState: { count: number },
    markAnchor: boolean,
    coverBit: number,
  ) {
    const tokenId = tokenOffsetToId.get(entry.offset);
    if (tokenId === undefined) return;
    addPostingByTokenId(
      tokenId,
      multiplier,
      touchedState,
      markAnchor,
      coverBit,
    );
  }

  function tryFeature(
    map: Map<string, TokenSlot>,
    name: string,
    multiplier: number,
    touchedState: { count: number },
    markAnchor: boolean,
    coverBit: number,
  ) {
    const entry = map.get(name);
    if (!entry) return false;
    addPostingByMapEntry(entry, multiplier, touchedState, markAnchor, coverBit);
    return true;
  }

  function rankFuzzy(
    term: string,
    touchedState: { count: number },
    fuzzyAnchors?: string[],
    corrections?: QueryCorrection[],
  ) {
    if (!term || term.length < 3) return 0;
    // Index emits 2-delete keys for terms ≥ 4 chars. Pairing query at 2-delete
    // for terms ≥ 6 lets us recover 2-edit typos (e.g. "typscrpt" → typescript)
    // while keeping query work bounded for short terms.
    const queryMaxDeletes = term.length >= 6 ? 2 : 1;
    const visited = new Set<number>();
    let accepted = 0;
    type BestForTerm = { to: string; distance: number };
    let bestForTerm: BestForTerm | null = null;
    let bestPostingCount = -1;

    /** Returns true when the per-query cap is hit. */
    function tryCandidates(candidates: Int32Array | undefined): boolean {
      if (!candidates) return false;
      for (let index = 0; index < candidates.length; index += 1) {
        const tokenId = candidates[index];
        if (visited.has(tokenId)) continue;
        visited.add(tokenId);

        const raw = tokenTerms[tokenId];
        if (!raw) continue;
        if (Math.abs(raw.length - term.length) > 2) continue;
        if (raw[0] !== term[0]) continue;
        if (bigramOverlap(raw, term) < 0.34) continue;

        const distance = damerauLevenshtein(
          raw,
          term,
          raw.length > 6 ? 2 : 1,
        );
        if (distance > (raw.length > 6 ? 2 : 1)) continue;

        // Fuzzy hits *are* anchor-quality: the term we matched is a real
        // indexed word, just spelled slightly differently. They count toward
        // multi-token coverage via the non-token anchor bit (a fuzzy match
        // doesn't correspond to a single user-typed token slot).
        addPostingByTokenId(
          tokenId,
          distance === 1 ? 0.64 : 0.42,
          touchedState,
          true,
          1 << 31,
        );
        if (fuzzyAnchors && raw.length >= 2) fuzzyAnchors.push(raw);

        // Track the best correction for this term: prefer lower edit distance,
        // then prefer the more popular token (higher posting count).
        const postingCount = tokenPostingCounts[tokenId];
        if (
          !bestForTerm ||
          distance < bestForTerm.distance ||
          (distance === bestForTerm.distance && postingCount > bestPostingCount)
        ) {
          bestForTerm = { to: raw, distance };
          bestPostingCount = postingCount;
        }
        accepted += 1;
        if (accepted >= 12) return true;
      }
      return false;
    }

    // 1) Direct lookup: the typo may itself be a delete-permutation of a real
    //    token (e.g. "typscript" is "typescript" with 'e' deleted).
    if (!tryCandidates(deleteLookup.get(term))) {
      // 2) Walk deletions of the typo, intersecting with indexed deletes.
      const deletions = generateDeletes(term, queryMaxDeletes);
      for (const deletion of deletions) {
        if (tryCandidates(deleteLookup.get(deletion))) break;
      }
    }

    const best = bestForTerm as BestForTerm | null;
    if (corrections && best) {
      corrections.push({ from: term, to: best.to, distance: best.distance });
    }
    return accepted;
  }

  function rawSearch(query: string, candidateLimit: number) {
    generation = generation === 0xffffffff ? 1 : generation + 1;
    const touchedState = { count: 0 };
    const corrections: QueryCorrection[] = [];
    const normalized = normalizeText(query);
    const empty = {
      results: [] as { docId: number; score: number }[],
      tokens: [] as string[],
      corrections,
    };
    if (!normalized) return empty;

    const tokens = tokenize(normalized);
    const compact = compactJoin(normalized);
    const joinedAscii = asciiJoin(normalized);
    let matchedDirect = 0;

    // Pre-pass: fire the anchor channels first so we know whether to bother
    // with the (much more expensive) bigram noise channel below.
    //
    // An exact hit on a real indexed token is *strong* evidence — it counts
    // as 2 toward matchedDirect on its own. (The previous "+1 exact, +1
    // prefix" scheme silently undercounted ASCII tokens of length ≥5,
    // because our prefix index only stores prefixes of length 2–4 and so
    // never returned a hit for a longer-than-4-char query token. That made
    // matchedDirect=1 for queries like "router", which then forced the
    // expensive bigram channel to fire and added 20+ ms of latency.)
    // Distinct query tokens get distinct bits (cap at 31 tokens; bit 31 is
    // reserved for "covered by the joinedAscii / signal anchor"). The mask
    // is OR'd into coverMask[doc] when the corresponding posting touches a
    // doc, which lets the multi-token coverage bonus run without a (capped,
    // possibly-truncated) substring scan over signalCompact.
    const tokenBits = new Map<string, number>();
    let nextBit = 0;
    for (const token of tokens) {
      if (token.length < 2) continue;
      if (!tokenBits.has(token) && nextBit < 31) {
        tokenBits.set(token, 1 << nextBit);
        nextBit += 1;
      }
    }
    const NON_TOKEN_ANCHOR_BIT = 1 << 31;

    for (const token of tokens) {
      if (token.length < 2) continue;
      const bit = tokenBits.get(token) ?? 0;
      if (tryFeature(exactMap, token, 1, touchedState, true, bit))
        matchedDirect += 2;
      if (tryFeature(prefixMap, token, 0.72, touchedState, true, bit))
        matchedDirect += 1;
    }

    if (compact.length >= 3) {
      if (
        tryFeature(joinMap, compact, 1.1, touchedState, true, NON_TOKEN_ANCHOR_BIT)
      )
        matchedDirect += 1;
    }

    if (joinedAscii.length >= 3) {
      if (
        tryFeature(
          signalMap,
          joinedAscii,
          1.25,
          touchedState,
          true,
          NON_TOKEN_ANCHOR_BIT,
        )
      )
        matchedDirect += 2;
      if (
        tryFeature(
          prefixMap,
          joinedAscii,
          0.88,
          touchedState,
          true,
          NON_TOKEN_ANCHOR_BIT,
        )
      )
        matchedDirect += 1;
      if (
        tryFeature(
          joinMap,
          joinedAscii,
          1.08,
          touchedState,
          true,
          NON_TOKEN_ANCHOR_BIT,
        )
      )
        matchedDirect += 1;
    }

    // Bigrams are the fallback / noise channel. They're very expensive on big
    // corpora because each ASCII bigram (`ro`, `ou`, ...) hits thousands of
    // postings in real text. Only fire them when the anchor channels haven't
    // already pinned the corpus — bigrams add nothing to recall once we've
    // matched the exact term, and they bloat hot-query latency 3–10×.
    const fireBigrams = matchedDirect < 2;
    if (fireBigrams) {
      if (compact.length >= 2 && compact.length <= 24) {
        for (let index = 0; index + 2 <= compact.length; index += 1) {
          const gram = compact.slice(index, index + 2);
          // Bigrams are explicitly NOT anchors — they're the noise channel
          // that the gate exists to suppress. Don't mark gate from them.
          tryFeature(asciiBigramMap, gram, 0.17, touchedState, false, 0);
          tryFeature(hanBigramMap, gram, 0.28, touchedState, false, 0);
        }
      }
      if (joinedAscii.length >= 3) {
        for (let index = 0; index + 2 <= joinedAscii.length; index += 1) {
          tryFeature(
            asciiBigramMap,
            joinedAscii.slice(index, index + 2),
            0.22,
            touchedState,
            false,
            0,
          );
        }
      }
    }

    const fuzzyAnchors: string[] = [];
    if (matchedDirect < 2) {
      const lastAsciiToken = [...tokens]
        .reverse()
        .find((token) => /^[a-z0-9]+$/.test(token));
      if (joinedAscii)
        rankFuzzy(joinedAscii, touchedState, fuzzyAnchors, corrections);
      if (lastAsciiToken && lastAsciiToken !== joinedAscii)
        rankFuzzy(lastAsciiToken, touchedState, fuzzyAnchors, corrections);
      if (!joinedAscii && compact)
        rankFuzzy(compact, touchedState, fuzzyAnchors, corrections);
    }

    // Quality gate: a doc must contain *some* substring of the user's intent,
    // otherwise we're just summing background bigram noise. Without this,
    // queries like "1111111健康的那jdnwadjanda" return arbitrary docs because
    // CJK bigrams ("健康", "的那") and ASCII bigrams ("ad", "an") accumulate
    // small per-doc scores across the whole corpus.
    const strongAnchors: string[] = [];
    for (const token of tokens) {
      if (token.length >= 2) strongAnchors.push(token);
    }
    if (compact.length >= 2) strongAnchors.push(compact);
    if (joinedAscii.length >= 3 && joinedAscii !== compact)
      strongAnchors.push(joinedAscii);
    for (const fuzzy of fuzzyAnchors) strongAnchors.push(fuzzy);

    // Pure-CJK fallback: when the query is only short single-CJK tokens
    // (length < 2 each), tokens.length is 0 but the user typed real content.
    // Allow docs that contain at least ceil(N/2) of the unique compact bigrams.
    const bigramAnchors: string[] = [];
    let bigramNeed = 0;
    const isPureCjk =
      tokens.length === 0 && compact.length >= 2 && joinedAscii.length === 0;
    if (isPureCjk) {
      const seen = new Set<string>();
      for (let i = 0; i + 2 <= compact.length; i += 1) {
        const gram = compact.slice(i, i + 2);
        if (CJK_NEEDLE_RE.test(gram[0]) && CJK_NEEDLE_RE.test(gram[1])) {
          if (!seen.has(gram)) {
            seen.add(gram);
            bigramAnchors.push(gram);
          }
        }
      }
      bigramNeed = Math.max(1, Math.ceil(bigramAnchors.length / 2));
    }

    function passesGate(docId: number, doc: InternalDocument): boolean {
      // Fast path: posting iteration already proved this doc was touched by an
      // anchor-quality feature (exact / prefix / signal / join / fuzzy on the
      // user's tokens). No need to substring-search the gate fields.
      if (gateGeneration[docId] === generation) return true;
      // Fallback substring path: needed when the user's intent only appears as
      // a substring of a longer word that the indexer didn't tokenize as the
      // user typed it. Rare on real corpora, but matters for things like
      // "abc" matching docs that contain "xyzabc".
      for (const a of strongAnchors) {
        if (doc.gateCompact.includes(a) || doc.gateAscii.includes(a))
          return true;
      }
      if (bigramAnchors.length > 0) {
        let hits = 0;
        for (const b of bigramAnchors) {
          if (doc.gateCompact.includes(b)) {
            hits += 1;
            if (hits >= bigramNeed) return true;
          }
        }
      }
      return false;
    }

    const limit = Math.max(1, candidateLimit);
    const topDocIds = new Int32Array(limit);
    const topScores = new Float32Array(limit);
    topDocIds.fill(-1);
    topScores.fill(-1e9);

    for (let index = 0; index < touchedState.count; index += 1) {
      const docId = touched[index];
      const doc = docs[docId];
      if (!passesGate(docId, doc)) continue;
      let score = scores[docId];

      if (compact.length >= 3 && doc.signalCompact.includes(compact)) {
        score += 100;
      }
      if (joinedAscii.length >= 3 && doc.signalAscii.includes(joinedAscii)) {
        score += 125;
      }
      // Multi-token coverage. For an N-token query, count how many of the
      // tokens this doc actually contains. A token is "covered" when EITHER
      //   (a) one of its postings (exact / prefix) touched the doc — checked
      //       via the per-query coverage mask we built during the posting
      //       pass; this is fast and correct even on long-body docs whose
      //       tokens live past signalMaxLength,
      //   OR
      //   (b) the token appears as a substring of the signal text — catches
      //       cases like query "useState" hitting docs that contain
      //       "useStateContext" in the title (we don't tokenize the suffix
      //       boundary so the exact posting wouldn't fire).
      // Docs that cover all tokens get a large additive bonus AND a
      // multiplicative boost so that they reliably rank above docs that
      // only cover one common token. Docs that cover < N-1 tokens are
      // demoted hard — they're unlikely to be what the user wanted.
      if (tokens.length > 1) {
        const docMask = coverMask[docId];
        let coveredCount = 0;
        let uniqueTokens = 0;
        const seenInQuery = new Set<string>();
        for (const token of tokens) {
          if (token.length < 2) continue;
          if (seenInQuery.has(token)) continue;
          seenInQuery.add(token);
          uniqueTokens += 1;
          const bit = tokenBits.get(token) ?? 0;
          if (bit !== 0 && (docMask & bit) !== 0) {
            coveredCount += 1;
            continue;
          }
          if (
            doc.signalCompact.includes(token) ||
            doc.signalAscii.includes(token)
          ) {
            coveredCount += 1;
          }
        }
        if (uniqueTokens >= 2) {
          const ratio = coveredCount / uniqueTokens;
          if (ratio >= 0.999) {
            // Full coverage: +200 additive plus 1.6× multiplicative. The
            // multiplicative term is what keeps a 3-token-match doc above
            // a doc that scored highly on one common token alone (a base
            // term like "test" or "buffer" can contribute 5–15 points of
            // posting score by itself, so a flat additive bonus of 36 was
            // not enough to outrank it).
            score = score * 1.6 + 200;
          } else if (
            uniqueTokens >= 3 &&
            coveredCount >= uniqueTokens - 1
          ) {
            // Near-full coverage on long queries (3+ tokens) — partial credit.
            score = score * 1.18 + 60;
          } else if (coveredCount === 0) {
            // Zero coverage on a multi-token query strongly suggests
            // bigram noise picked the doc up. Demote.
            score *= 0.4;
          } else if (uniqueTokens >= 3 && coveredCount === 1) {
            // Many-token query but only one token matched — also weak.
            score *= 0.7;
          }
        }
      }

      if (score <= topScores[limit - 1]) continue;
      let slot = limit - 1;
      while (slot > 0 && score > topScores[slot - 1]) {
        topScores[slot] = topScores[slot - 1];
        topDocIds[slot] = topDocIds[slot - 1];
        slot -= 1;
      }
      topScores[slot] = score;
      topDocIds[slot] = docId;
    }

    const results: { docId: number; score: number }[] = [];
    for (let index = 0; index < limit; index += 1) {
      const docId = topDocIds[index];
      if (docId < 0) continue;
      results.push({ docId, score: Number(topScores[index].toFixed(2)) });
    }
    return { results, tokens, corrections };
  }

  /**
   * Build a "did you mean" string by walking the original query and replacing
   * each fuzzy-corrected token with its match. Casing of the surrounding
   * text is preserved for everything that wasn't corrected.
   */
  function rebuildCorrectedQuery(
    original: string,
    corrections: readonly QueryCorrection[],
  ): string | null {
    if (corrections.length === 0) return null;
    const map = new Map<string, string>();
    for (const c of corrections) {
      // Avoid recommending a replacement that is identical to what the user
      // typed (after normalisation). This happens when fuzzy fired but the
      // best candidate is the same string.
      if (c.from === c.to) continue;
      // Prefer the lower-distance correction when both apply.
      const existing = map.get(c.from);
      if (!existing) map.set(c.from, c.to);
    }
    if (map.size === 0) return null;

    // Walk the lowercased version, but emit slices of the original to keep
    // surrounding casing intact. We replace whole tokens only.
    const lower = original.toLowerCase();
    const out: string[] = [];
    let i = 0;
    while (i < original.length) {
      const ch = original.charCodeAt(i);
      // Scan an alphanumeric run.
      if (
        (ch >= 0x30 && ch <= 0x39) ||
        (ch >= 0x41 && ch <= 0x5a) ||
        (ch >= 0x61 && ch <= 0x7a)
      ) {
        let end = i + 1;
        while (end < original.length) {
          const c2 = original.charCodeAt(end);
          if (
            (c2 >= 0x30 && c2 <= 0x39) ||
            (c2 >= 0x41 && c2 <= 0x5a) ||
            (c2 >= 0x61 && c2 <= 0x7a)
          ) {
            end += 1;
          } else break;
        }
        const slice = lower.slice(i, end);
        const corrected = map.get(slice);
        out.push(corrected ?? original.slice(i, end));
        i = end;
      } else {
        out.push(original[i]);
        i += 1;
      }
    }
    const rebuilt = out.join("");
    return rebuilt.toLowerCase() === original.toLowerCase() ? null : rebuilt;
  }

  function search(query: string, options: SearchOptions = {}): SearchHit[] {
    return searchDetailed(query, options).hits;
  }

  function searchDetailed(
    query: string,
    options: SearchOptions = {},
  ): DetailedSearchResult {
    const trimmed = String(query || "").trim();
    if (trimmed.length < 2)
      return { hits: [], correctedQuery: null, corrections: [] };

    const limit = options.limit ?? 10;
    const minScoreRatio = options.minScoreRatio ?? 0.18;
    const filter = options.filter;
    const rescore = options.rescore;
    const highlightFields =
      options.highlightFields ?? storedFieldNames;

    const candidateLimit = Math.max(limit * 3, 24);
    const raw = rawSearch(trimmed, candidateLimit);
    const candidates = raw.results;
    const corrections = raw.corrections;

    const needles = buildHighlightNeedles(trimmed);
    let hits: SearchHit[] = candidates.map((candidate, refIndex) => {
      const internal = docs[candidate.docId];
      const doc: StoredDocument = {
        id: internal.id,
        fields: internal.fields,
        tags: internal.tags,
      };
      const matches: FieldMatches[] = [];
      for (const field of highlightFields) {
        const value = doc.fields[field];
        if (!value) continue;
        const ranges = findMatchRanges(value, needles);
        if (ranges.length > 0) {
          matches.push({ field, ranges });
        }
      }
      return { doc, score: candidate.score, refIndex, matches };
    });

    if (filter) {
      hits = hits.filter((hit) => filter(hit.doc));
    }

    if (rescore) {
      hits = hits.map((hit) => ({ ...hit, score: rescore(hit) }));
    }

    const correctedQuery = rebuildCorrectedQuery(trimmed, corrections);

    if (hits.length === 0) {
      return { hits: [], correctedQuery, corrections };
    }

    hits.sort((left, right) => {
      if (right.score !== left.score) return right.score - left.score;
      return left.refIndex - right.refIndex;
    });

    const topScore = hits[0].score;
    const minimum = Math.max(0, topScore * minScoreRatio);
    const filtered = hits
      .filter((hit, index) => index === 0 || hit.score >= minimum)
      .slice(0, limit);
    return { hits: filtered, correctedQuery, corrections };
  }

  function suggest(
    prefix: string,
    options: SuggestOptions = {},
  ): SuggestHit[] {
    const limit = options.limit ?? 8;
    const allowFuzzy = options.fuzzy !== false;
    const trimmed = String(prefix || "")
      .trim()
      .toLowerCase();
    if (trimmed.length < 1) return [];

    // Reject obviously non-ASCII prefixes — the prefix index is ASCII-only.
    if (!/^[a-z0-9]+$/.test(trimmed)) return [];

    const candidates: SuggestHit[] = [];
    const seen = new Set<string>();

    // Walk every ASCII exact token; this is cheap (Map iteration over ~10–50k
    // entries even for large corpora) and gives popularity-sorted completions.
    for (let tokenId = 0; tokenId < tokenCount; tokenId += 1) {
      if (tokenTypes[tokenId] !== TOKEN_TYPE_EXACT) continue;
      const term = tokenTerms[tokenId];
      if (!term || term.length < trimmed.length) continue;
      if (!term.startsWith(trimmed)) continue;
      if (seen.has(term)) continue;
      seen.add(term);
      candidates.push({
        term,
        docFrequency: tokenPostingCounts[tokenId],
        kind: "prefix",
      });
    }

    candidates.sort((left, right) => {
      // Prefer exact-length match first, then higher doc frequency, then
      // shorter terms (alphabetically tied terms get the popular one first).
      if (left.term === trimmed && right.term !== trimmed) return -1;
      if (right.term === trimmed && left.term !== trimmed) return 1;
      if (right.docFrequency !== left.docFrequency)
        return right.docFrequency - left.docFrequency;
      return left.term.length - right.term.length;
    });

    if (candidates.length > 0 || !allowFuzzy) {
      return candidates.slice(0, limit);
    }

    // No prefix candidates — fall back to prefix-aware fuzzy, comparing the
    // typo against the leading slice of every indexed term. This is O(N) over
    // exact tokens (cheap; ~10-50k entries even on big corpora) but only
    // fires when the literal prefix scan returned nothing.
    if (trimmed.length < 3) return [];
    const fuzzy: SuggestHit[] = [];
    const maxDistance = trimmed.length >= 6 ? 2 : 1;

    for (let tokenId = 0; tokenId < tokenCount; tokenId += 1) {
      if (tokenTypes[tokenId] !== TOKEN_TYPE_EXACT) continue;
      const term = tokenTerms[tokenId];
      if (!term) continue;
      // The candidate must be at least roughly the typo's length, but we don't
      // require it to *be* the typo's length — we compare against the term's
      // leading slice to recover partial-word typos like "trabsl" → translate.
      if (term.length < trimmed.length - 1) continue;
      // Cheap reject: first chars must agree (same edit-distance heuristic
      // used by `rankFuzzy`). Avoid scanning every token in the corpus.
      if (term[0] !== trimmed[0]) continue;

      // Compare the typo against term.slice(0, trimmed.length + 1) so a single
      // insertion / deletion at the end still matches. Two slices catch the
      // most-common cases (one extra char, one fewer char).
      const slice = term.slice(0, trimmed.length);
      const sliceLong = term.slice(0, trimmed.length + 1);
      const dShort = damerauLevenshtein(slice, trimmed, maxDistance);
      const dLong =
        sliceLong === slice
          ? Number.POSITIVE_INFINITY
          : damerauLevenshtein(sliceLong, trimmed, maxDistance);
      const distance = Math.min(dShort, dLong);
      if (distance > maxDistance) continue;

      fuzzy.push({
        term,
        docFrequency: tokenPostingCounts[tokenId],
        kind: "fuzzy",
        distance,
      });
    }

    fuzzy.sort((left, right) => {
      if (left.distance !== right.distance)
        return (left.distance ?? 9) - (right.distance ?? 9);
      return right.docFrequency - left.docFrequency;
    });
    return fuzzy.slice(0, limit);
  }

  const totalPostings = (() => {
    let sum = 0;
    for (let index = 0; index < tokenCount; index += 1) {
      sum += tokenPostingCounts[index];
    }
    return sum;
  })();

  void tokenTypes; // type information is consumed inside rankFuzzy via tokenTerms

  return {
    search,
    searchDetailed,
    suggest,
    docs: docs.map((doc) => ({
      id: doc.id,
      fields: doc.fields,
      tags: doc.tags,
    })),
    stats: {
      docs: docCount,
      features: tokenCount,
      postings: totalPostings,
      deletes: deleteCount,
      storedFields: storedFieldNames,
    },
  };
}
