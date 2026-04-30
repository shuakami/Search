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

export interface SearchEngine {
  /** Run a query. Synchronous, no I/O, no allocations beyond the result list. */
  search(query: string, options?: SearchOptions): SearchHit[];
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
    // Build the gate join once at load time. It includes every stored field
    // *and* tags so URLs/tag-only matches can satisfy the query-quality gate.
    const gateParts: string[] = [];
    for (const name of storedFieldNames) gateParts.push(fields[name] || "");
    for (const tag of tags) gateParts.push(tag);
    const gateJoined = gateParts.join(" ");
    const gateCompact = compactJoin(gateJoined);
    const gateAscii = asciiJoin(gateJoined);
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
  let generation = 1;

  function addPostingByTokenId(
    tokenId: number,
    multiplier: number,
    touchedState: { count: number },
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
        touched[touchedState.count++] = docId;
      }
      scores[docId] += score * multiplier;
    }
  }

  function addPostingByMapEntry(
    entry: TokenSlot,
    multiplier: number,
    touchedState: { count: number },
  ) {
    const tokenId = tokenOffsetToId.get(entry.offset);
    if (tokenId === undefined) return;
    addPostingByTokenId(tokenId, multiplier, touchedState);
  }

  function tryFeature(
    map: Map<string, TokenSlot>,
    name: string,
    multiplier: number,
    touchedState: { count: number },
  ) {
    const entry = map.get(name);
    if (!entry) return false;
    addPostingByMapEntry(entry, multiplier, touchedState);
    return true;
  }

  function rankFuzzy(
    term: string,
    touchedState: { count: number },
    fuzzyAnchors?: string[],
  ) {
    if (!term || term.length < 3) return 0;
    // Index emits 2-delete keys for terms ≥ 4 chars. Pairing query at 2-delete
    // for terms ≥ 6 lets us recover 2-edit typos (e.g. "typscrpt" → typescript)
    // while keeping query work bounded for short terms.
    const queryMaxDeletes = term.length >= 6 ? 2 : 1;
    const visited = new Set<number>();
    let accepted = 0;

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

        addPostingByTokenId(
          tokenId,
          distance === 1 ? 0.64 : 0.42,
          touchedState,
        );
        if (fuzzyAnchors && raw.length >= 2) fuzzyAnchors.push(raw);
        accepted += 1;
        if (accepted >= 12) return true;
      }
      return false;
    }

    // 1) Direct lookup: the typo may itself be a delete-permutation of a real
    //    token (e.g. "typscript" is "typescript" with 'e' deleted).
    if (tryCandidates(deleteLookup.get(term))) return accepted;

    // 2) Walk deletions of the typo, intersecting with indexed deletes.
    const deletions = generateDeletes(term, queryMaxDeletes);
    for (const deletion of deletions) {
      if (tryCandidates(deleteLookup.get(deletion))) break;
    }
    return accepted;
  }

  function rawSearch(query: string, candidateLimit: number) {
    generation = generation === 0xffffffff ? 1 : generation + 1;
    const touchedState = { count: 0 };
    const normalized = normalizeText(query);
    if (!normalized) return [] as { docId: number; score: number }[];

    const tokens = tokenize(normalized);
    const compact = compactJoin(normalized);
    const joinedAscii = asciiJoin(normalized);
    let matchedDirect = 0;

    for (const token of tokens) {
      if (token.length < 2) continue;
      if (tryFeature(exactMap, token, 1, touchedState)) matchedDirect += 1;
      if (tryFeature(prefixMap, token, 0.72, touchedState)) matchedDirect += 1;
    }

    if (compact.length >= 3) {
      if (tryFeature(joinMap, compact, 1.1, touchedState)) matchedDirect += 1;
    }
    if (compact.length >= 2 && compact.length <= 24) {
      for (let index = 0; index + 2 <= compact.length; index += 1) {
        const gram = compact.slice(index, index + 2);
        tryFeature(asciiBigramMap, gram, 0.17, touchedState);
        tryFeature(hanBigramMap, gram, 0.28, touchedState);
      }
    }

    if (joinedAscii.length >= 3) {
      if (tryFeature(signalMap, joinedAscii, 1.25, touchedState))
        matchedDirect += 2;
      if (tryFeature(prefixMap, joinedAscii, 0.88, touchedState))
        matchedDirect += 1;
      if (tryFeature(joinMap, joinedAscii, 1.08, touchedState))
        matchedDirect += 1;

      for (let index = 0; index + 2 <= joinedAscii.length; index += 1) {
        tryFeature(
          asciiBigramMap,
          joinedAscii.slice(index, index + 2),
          0.22,
          touchedState,
        );
      }
    }

    const fuzzyAnchors: string[] = [];
    if (matchedDirect < 2) {
      const lastAsciiToken = [...tokens]
        .reverse()
        .find((token) => /^[a-z0-9]+$/.test(token));
      if (joinedAscii) rankFuzzy(joinedAscii, touchedState, fuzzyAnchors);
      if (lastAsciiToken && lastAsciiToken !== joinedAscii)
        rankFuzzy(lastAsciiToken, touchedState, fuzzyAnchors);
      if (!joinedAscii && compact)
        rankFuzzy(compact, touchedState, fuzzyAnchors);
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
    let bigramAnchors: string[] = [];
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

    function passesGate(doc: InternalDocument): boolean {
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
      if (!passesGate(doc)) continue;
      let score = scores[docId];

      if (compact.length >= 3 && doc.signalCompact.includes(compact)) {
        score += 100;
      }
      if (joinedAscii.length >= 3 && doc.signalAscii.includes(joinedAscii)) {
        score += 125;
      }
      if (tokens.length > 1) {
        let hitAll = true;
        for (const token of tokens) {
          if (
            !doc.signalCompact.includes(token) &&
            !doc.signalAscii.includes(token)
          ) {
            hitAll = false;
            break;
          }
        }
        if (hitAll) score += 36;
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
    return results;
  }

  function search(query: string, options: SearchOptions = {}): SearchHit[] {
    const trimmed = String(query || "").trim();
    if (trimmed.length < 2) return [];

    const limit = options.limit ?? 10;
    const minScoreRatio = options.minScoreRatio ?? 0.18;
    const filter = options.filter;
    const rescore = options.rescore;
    const highlightFields =
      options.highlightFields ?? storedFieldNames;

    const candidateLimit = Math.max(limit * 3, 24);
    const candidates = rawSearch(trimmed, candidateLimit);

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

    if (hits.length === 0) return [];

    hits.sort((left, right) => {
      if (right.score !== left.score) return right.score - left.score;
      return left.refIndex - right.refIndex;
    });

    const topScore = hits[0].score;
    const minimum = Math.max(0, topScore * minScoreRatio);
    return hits
      .filter((hit, index) => index === 0 || hit.score >= minimum)
      .slice(0, limit);
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
