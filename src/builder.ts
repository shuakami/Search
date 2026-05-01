/**
 * Build a binary search pack from a list of documents.
 *
 * The builder produces a `Uint8Array` that can be persisted to a file, served
 * as a static asset, or embedded into a JS bundle. It is round-trip compatible
 * with the runtime in `./runtime.ts`.
 *
 * Build is one-shot and synchronous. For an N-document corpus it is roughly
 * O(N · avgFieldBytes) and dominated by tokenization and ngram emission.
 */

import {
  asciiJoin,
  compactJoin,
  generateDeletes,
  grams,
  isAsciiToken,
  isHanChar,
  normalizeText,
  tokenize,
} from "./tokenizer";
import {
  PACK_MAGIC,
  PACK_VERSION,
  sigilToType,
  TOKEN_TYPE_COUNT,
} from "./format";
import { VarintWriter } from "./varint";

/** Document handed to the builder. `id` must be unique across the corpus. */
export interface SearchDocument {
  id: string;
  [field: string]: unknown;
}

/** Indexing configuration for a single field on a document. */
export type FieldKind = "text" | "keyword" | "url";

export interface FieldConfig {
  /** Relative weight: higher means a hit in this field scores more. */
  weight: number;
  /**
   * - `text`     — natural language. Emits exact, prefix, signal, join, bigrams.
   * - `keyword`  — discrete tags / categories. Same as `text` with smaller windows.
   * - `url`      — path-like. Emits only exact + prefix; skips join/bigram noise.
   */
  kind?: FieldKind;
  /** Window for token n-gram joins. Default depends on `kind`. */
  joinWindow?: number;
}

export interface BuildOptions {
  /** Field name → weight (number) or full config. */
  fields: Record<string, FieldConfig | number>;
  /**
   * Field names to copy verbatim into the pack so search results carry them.
   * Defaults to every field declared in `fields`.
   *
   * For large `body`-style fields it is usually worth excluding them from
   * `storeFields` and rendering the source from a separate document store —
   * stored fields dominate pack size on long-text corpora.
   */
  storeFields?: string[];
  /**
   * Field names whose normalized contents are concatenated into the per-doc
   * "signal" string used by the runtime for `.includes()` boosts.
   *
   * Defaults to fields whose weight is at least 50% of the maximum weight
   * (and whose `kind` is not `url`). Set this explicitly to keep the signal
   * focused on short title-like fields.
   */
  signalFields?: string[];
  /**
   * Cap the per-doc signal length (compact + ascii each). Default: 512 chars.
   * The signal is only used for substring boosts at query time; over-long
   * signals waste pack bytes without measurably improving results.
   */
  signalMaxLength?: number;
  /** If supplied, doc[tagsField] (a string[]) is stored as filterable tags. */
  tagsField?: string;
  /**
   * Enable typo-tolerant fuzzy lookup. Adds correction tables to the pack.
   * Default: true.
   */
  fuzzy?: boolean;
}

export interface BuildManifest {
  docs: number;
  features: number;
  postings: number;
  correctionDeletes: number;
  packBytes: number;
}

export interface BuildResult {
  pack: Uint8Array;
  manifest: BuildManifest;
}

interface ResolvedField {
  name: string;
  weight: number;
  kind: FieldKind;
  joinWindow: number;
}

type PostingMap = Map<string, Map<number, number>>;

const SCORE_CAP = 65535;

function resolveFields(
  fields: BuildOptions["fields"],
): ResolvedField[] {
  const out: ResolvedField[] = [];
  for (const [name, raw] of Object.entries(fields)) {
    const config =
      typeof raw === "number" ? ({ weight: raw } as FieldConfig) : raw;
    if (config.weight <= 0) {
      continue;
    }
    const kind: FieldKind = config.kind ?? "text";
    const joinWindow =
      config.joinWindow ?? (kind === "url" ? 3 : kind === "keyword" ? 3 : 3);
    out.push({ name, weight: config.weight, kind, joinWindow });
  }
  return out;
}

function fieldValueToText(value: unknown): string {
  if (value == null) {
    return "";
  }
  if (typeof value === "string") {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((entry) => fieldValueToText(entry)).join(" ");
  }
  if (typeof value === "object") {
    return Object.values(value as Record<string, unknown>)
      .map((entry) => fieldValueToText(entry))
      .join(" ");
  }
  return String(value);
}

function addScore(map: Map<string, number>, key: string, score: number) {
  const previous = map.get(key) || 0;
  map.set(key, Math.min(SCORE_CAP, previous + score));
}

function collectFieldFeatures(
  fieldText: string,
  baseWeight: number,
  featureMap: Map<string, number>,
  options: {
    maxWindow: number;
    skipCompactJoin: boolean;
    skipJoinedAscii: boolean;
    skipAsciiBigrams: boolean;
  },
) {
  const normalized = normalizeText(fieldText);
  if (!normalized) {
    return;
  }

  const tokens = tokenize(normalized);
  const asciiTokens = tokens.filter(isAsciiToken);
  const joinedAscii = asciiTokens.join("");
  const compact = tokens.join("");

  for (const token of tokens) {
    if (token.length < 2) {
      continue;
    }

    addScore(featureMap, `e:${token}`, baseWeight);

    if (isAsciiToken(token)) {
      const maxPrefix = Math.min(4, token.length);
      for (let size = 2; size <= maxPrefix; size += 1) {
        addScore(
          featureMap,
          `p:${token.slice(0, size)}`,
          Math.max(6, Math.round(baseWeight * 0.4)),
        );
      }
    }
  }

  // Per-field full-string tokens (s:, j:) only earn their place on shortish
  // fields (titles, names, tags). Emitting them on long body text gives the
  // pack thousands of unique single-document features that nothing will ever
  // query for.
  if (
    !options.skipJoinedAscii &&
    joinedAscii.length >= 3 &&
    joinedAscii.length <= 32
  ) {
    addScore(featureMap, `s:${joinedAscii}`, Math.round(baseWeight * 1.28));

    const maxPrefix = Math.min(4, joinedAscii.length);
    for (let size = 2; size <= maxPrefix; size += 1) {
      addScore(
        featureMap,
        `p:${joinedAscii.slice(0, size)}`,
        Math.max(6, Math.round(baseWeight * 0.56)),
      );
    }

    if (!options.skipAsciiBigrams && joinedAscii.length <= 12) {
      for (const gram of grams(joinedAscii, 2, 2)) {
        addScore(
          featureMap,
          `g:${gram}`,
          Math.max(4, Math.round(baseWeight * 0.16)),
        );
      }
    }
  }

  if (!options.skipCompactJoin && compact.length >= 3 && compact.length <= 32) {
    addScore(featureMap, `j:${compact}`, Math.round(baseWeight * 1.08));
  }

  // CJK bigrams. Earlier we only emitted these when the *whole* field compact
  // was ≤24 chars, which silently disabled CJK indexing on every body field
  // longer than a few sentences. Fan them out across the full token stream
  // instead: every pair of adjacent CJK tokens (single hanzi each, after the
  // tokenizer's CJK split) becomes one `h:` feature.
  if (!options.skipCompactJoin) {
    const seenHanGrams = new Set<string>();
    for (let i = 0; i + 1 < tokens.length; i += 1) {
      const left = tokens[i];
      const right = tokens[i + 1];
      // Each CJK-character token is exactly one hanzi long after our
      // tokenizer's split. Anything longer is ASCII/code/symbol, which
      // shouldn't go into the han bigram table.
      if (left.length !== 1 || right.length !== 1) continue;
      if (!isHanChar(left) || !isHanChar(right)) continue;
      const gram = left + right;
      if (seenHanGrams.has(gram)) continue;
      seenHanGrams.add(gram);
      addScore(
        featureMap,
        `h:${gram}`,
        Math.max(4, Math.round(baseWeight * 0.22)),
      );
    }
  }

  const emitted = new Set<string>();
  for (let index = 0; index < tokens.length; index += 1) {
    let joined = "";
    for (
      let width = 1;
      width <= options.maxWindow && index + width <= tokens.length;
      width += 1
    ) {
      joined += tokens[index + width - 1];
      if (joined.length < 3 || joined.length > 12 || emitted.has(joined)) {
        continue;
      }
      emitted.add(joined);
      if (width > 1) {
        addScore(
          featureMap,
          `j:${joined}`,
          Math.max(8, Math.round(baseWeight * (1.02 - (width - 1) * 0.16))),
        );
      }
    }
  }
}

function fieldOptionsForKind(
  kind: FieldKind,
  joinWindow: number,
): {
  maxWindow: number;
  skipCompactJoin: boolean;
  skipJoinedAscii: boolean;
  skipAsciiBigrams: boolean;
} {
  if (kind === "url") {
    return {
      maxWindow: joinWindow,
      skipCompactJoin: true,
      skipJoinedAscii: true,
      skipAsciiBigrams: true,
    };
  }
  return {
    maxWindow: joinWindow,
    skipCompactJoin: false,
    skipJoinedAscii: false,
    skipAsciiBigrams: false,
  };
}

function buildDocSignal(
  doc: SearchDocument,
  signalFields: ResolvedField[],
  signalMaxLength: number,
): { compact: string; ascii: string } {
  // The signal is used for `.includes()` boosts at query time. Any field that
  // contributes here should be short and high-precision (titles, keywords,
  // tags). Long body text rarely benefits from substring boosts and just
  // bloats the pack.
  const parts: string[] = [];
  for (const field of signalFields) {
    parts.push(fieldValueToText(doc[field.name]));
  }
  const joined = parts.join(" ");
  let compact = compactJoin(joined);
  let ascii = asciiJoin(joined);
  if (compact.length > signalMaxLength) compact = compact.slice(0, signalMaxLength);
  if (ascii.length > signalMaxLength) ascii = ascii.slice(0, signalMaxLength);
  return { compact, ascii };
}

function shouldGenerateCorrections(feature: string) {
  const type = feature.slice(0, 2);
  const term = feature.slice(2);
  if (!term || term.length < 3 || term.length > 14) {
    return false;
  }
  if (!/^[a-z0-9]+$/.test(term)) {
    return false;
  }
  // Both signal-joined strings (s:) and individual ASCII tokens (e:) earn
  // fuzzy-correction tables. The score gate (titleLikeWeight) below keeps
  // body-only tokens out so the pack stays compact.
  return type === "s:" || type === "e:";
}

function addPosting(
  tokenPostings: PostingMap,
  feature: string,
  docId: number,
  score: number,
) {
  let postings = tokenPostings.get(feature);
  if (!postings) {
    postings = new Map<number, number>();
    tokenPostings.set(feature, postings);
  }
  postings.set(
    docId,
    Math.min(SCORE_CAP, (postings.get(docId) || 0) + score),
  );
}

function writeString(
  writer: VarintWriter,
  value: string,
  encoder: TextEncoder,
) {
  const bytes = encoder.encode(value);
  writer.writeVarint(bytes.length);
  writer.writeBytes(bytes);
}

function writeTokenHeader(
  writer: VarintWriter,
  typeValue: number,
  nameBytes: number,
) {
  if (nameBytes < 0x1f) {
    writer.writeByte((typeValue << 5) | nameBytes);
    return;
  }
  writer.writeByte((typeValue << 5) | 0x1f);
  writer.writeVarint(nameBytes - 0x1f);
}

export function buildIndex(
  documents: readonly SearchDocument[],
  options: BuildOptions,
): BuildResult {
  if (!options || !options.fields) {
    throw new Error("buildIndex: `options.fields` is required");
  }

  const resolvedFields = resolveFields(options.fields);
  if (resolvedFields.length === 0) {
    throw new Error(
      "buildIndex: at least one field with weight > 0 is required",
    );
  }

  const storedFields =
    options.storeFields ?? resolvedFields.map((field) => field.name);
  const tagsField = options.tagsField;
  const fuzzy = options.fuzzy !== false;
  // 512 was tuned for a tiny FAQ-shaped corpus and proved far too aggressive
  // on real bodies — wiki / Stack Overflow / news articles have 1–5 KB of
  // content and we were truncating the gate signal after one paragraph. A
  // 4 KB cap keeps long-doc recall close to oracle while still cutting the
  // very long pages (full books, manpages) that would otherwise dominate
  // pack size.
  const signalMaxLength = options.signalMaxLength ?? 4096;

  // The signal default keeps every non-URL field — URLs introduce noisy
  // collapsed forms that dilute substring boosts. A length cap on the whole
  // signal keeps the pack tight even when body fields are long.
  const defaultSignalFields = resolvedFields.filter(
    (field) => field.kind !== "url",
  );
  const signalFieldNames = options.signalFields;
  const signalFields = signalFieldNames
    ? resolvedFields.filter((field) => signalFieldNames.includes(field.name))
    : defaultSignalFields.length > 0
      ? defaultSignalFields
      : resolvedFields;

  const tokenPostings: PostingMap = new Map();
  const correctionMap = new Map<string, Set<string>>();
  const docSignals = documents.map((doc) =>
    buildDocSignal(doc, signalFields, signalMaxLength),
  );

  documents.forEach((doc, docId) => {
    const featureMap = new Map<string, number>();

    for (const field of resolvedFields) {
      const text = fieldValueToText(doc[field.name]);
      if (!text) {
        continue;
      }
      collectFieldFeatures(
        text,
        field.weight,
        featureMap,
        fieldOptionsForKind(field.kind, field.joinWindow),
      );
    }

    if (tagsField) {
      const tagValue = doc[tagsField];
      const tags = Array.isArray(tagValue)
        ? tagValue.map((entry) => String(entry))
        : tagValue
          ? [String(tagValue)]
          : [];
      for (const tag of tags) {
        const text = String(tag);
        if (!text) continue;
        collectFieldFeatures(
          text,
          // Tags carry roughly the weight of a `keyword` field. The default
          // primary field weight tends to live around 100..180 in practice.
          120,
          featureMap,
          fieldOptionsForKind("keyword", 3),
        );
      }
    }

    const titleLikeWeight = Math.max(
      ...resolvedFields.map((field) => field.weight),
    );

    for (const [feature, score] of featureMap) {
      addPosting(tokenPostings, feature, docId, score);

      if (
        !fuzzy ||
        !shouldGenerateCorrections(feature) ||
        score < titleLikeWeight
      ) {
        continue;
      }

      const term = feature.slice(2);
      // Index with maxDeletes=2 for terms long enough to absorb the cost.
      // Pairs with the runtime's maxDeletes=1 to recover 2-edit typos via
      // shared length-(L-2) deletes (e.g. user types "typscript" for
      // "typescript": the runtime's 1-delete and the index's 2-delete meet
      // at length 8). Short terms (< 4) keep maxDeletes=1 to bound the pack.
      const maxDeletes = term.length >= 4 ? 2 : 1;
      for (const deletion of generateDeletes(term, maxDeletes)) {
        if (!deletion) continue;
        let candidates = correctionMap.get(deletion);
        if (!candidates) {
          candidates = new Set<string>();
          correctionMap.set(deletion, candidates);
        }
        candidates.add(feature);
      }
    }
  });

  // Sort tokens by (type, name) so the pack streams in lookup order.
  const tokenList = [...tokenPostings.entries()].sort((left, right) =>
    left[0].localeCompare(right[0]),
  );
  const tokenIdByFeature = new Map<string, number>();
  tokenList.forEach(([feature], index) => {
    tokenIdByFeature.set(feature, index);
  });

  const deleteEntries = [...correctionMap.entries()]
    .map(([deletion, features]) => {
      const tokenIds: number[] = [];
      for (const feature of features) {
        const id = tokenIdByFeature.get(feature);
        if (id !== undefined) {
          tokenIds.push(id);
        }
      }
      tokenIds.sort((left, right) => left - right);
      return [deletion, tokenIds] as const;
    })
    .filter(([, tokenIds]) => tokenIds.length > 0)
    .sort((left, right) => left[0].localeCompare(right[0]));

  const encoder = new TextEncoder();
  const writer = new VarintWriter();

  writer.writeUint32LE(PACK_MAGIC);
  writer.writeUint16LE(PACK_VERSION);
  writer.writeUint16LE(0); // flags reserved
  writer.writeUint32LE(documents.length);
  writer.writeUint32LE(tokenList.length);

  writer.writeVarint(storedFields.length);
  for (const name of storedFields) {
    writeString(writer, name, encoder);
  }

  for (let docId = 0; docId < documents.length; docId += 1) {
    const doc = documents[docId];
    writeString(writer, String(doc.id), encoder);

    for (const fieldName of storedFields) {
      writeString(writer, fieldValueToText(doc[fieldName]), encoder);
    }

    writeString(writer, docSignals[docId].compact, encoder);
    writeString(writer, docSignals[docId].ascii, encoder);

    if (tagsField) {
      const tagValue = doc[tagsField];
      const tags = Array.isArray(tagValue)
        ? tagValue.map((entry) => String(entry))
        : tagValue
          ? [String(tagValue)]
          : [];
      writer.writeVarint(tags.length);
      for (const tag of tags) {
        writeString(writer, tag, encoder);
      }
    } else {
      writer.writeVarint(0);
    }
  }

  let totalPostings = 0;
  for (const [feature, postings] of tokenList) {
    const sigil = feature.slice(0, 1);
    const typeValue = sigilToType(sigil);
    const name = feature.slice(2);
    const nameBytes = encoder.encode(name);

    writeTokenHeader(writer, typeValue, nameBytes.length);
    writer.writeBytes(nameBytes);

    const rows = [...postings.entries()].sort(
      (left, right) => left[0] - right[0],
    );
    writer.writeVarint(rows.length);
    totalPostings += rows.length;

    let previousDocId = 0;
    for (let index = 0; index < rows.length; index += 1) {
      const [docId, score] = rows[index];
      const delta = index === 0 ? docId : docId - previousDocId;
      writer.writeVarint(delta);
      writer.writeVarint(score);
      previousDocId = docId;
    }
  }

  writer.writeVarint(deleteEntries.length);
  for (const [deletion, tokenIds] of deleteEntries) {
    writeString(writer, deletion, encoder);
    writer.writeVarint(tokenIds.length);
    let previous = 0;
    for (let index = 0; index < tokenIds.length; index += 1) {
      const delta = index === 0 ? tokenIds[index] : tokenIds[index] - previous;
      writer.writeVarint(delta);
      previous = tokenIds[index];
    }
  }

  // Reserve TOKEN_TYPE_COUNT to keep the format extension-aware.
  void TOKEN_TYPE_COUNT;

  const pack = writer.toUint8Array();
  return {
    pack,
    manifest: {
      docs: documents.length,
      features: tokenList.length,
      postings: totalPostings,
      correctionDeletes: deleteEntries.length,
      packBytes: pack.length,
    },
  };
}
