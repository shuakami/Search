/**
 * Binary pack format constants — shared by the builder and the runtime.
 *
 * Layout summary:
 *   [header]
 *     magic       u32 LE ('SCH1' == 0x31_48_43_53)
 *     version     u16    == 1
 *     flags       u16    (reserved, currently 0)
 *     docCount    u32
 *     tokenCount  u32
 *     varint storedFieldCount
 *       per field: varint nameLen + name bytes (UTF-8)
 *
 *   [doc section] one entry per doc, in insertion order
 *     varint id_len + id bytes
 *     for each stored field (in declared order):
 *       varint value_len + value bytes
 *     varint signal_compact_len + bytes
 *     varint signal_ascii_len   + bytes
 *     varint tag_count
 *       per tag: varint tag_len + tag bytes
 *
 *   [token section] tokens sorted ascending by (type, name)
 *     u8 type_and_len: top 3 bits = type (0..5), low 5 bits = name byte length;
 *       if low 5 bits == 0x1F, an additional varint encodes (actualLen - 31)
 *     name bytes
 *     varint posting_count
 *     posting_count × [varint doc_delta, varint score]
 *       doc_delta: absolute for first posting, then doc_id_i - doc_id_{i-1}
 *
 *   [delete section] deletes sorted ascending by key
 *     varint delete_count
 *     per delete:
 *       varint key_len + key bytes
 *       varint candidate_count
 *       candidate_count × varint token_id_delta (absolute for first)
 *
 * The token type prefix is a 3-bit enum so a typical pack does not waste any
 * bytes on sigils like "e:", "p:", and so on.
 */

export const PACK_MAGIC = 0x3148_4353; // "SCH1" little-endian
export const PACK_VERSION = 1;
export const PACK_HEADER_FIXED_BYTES = 16;

/** Exact-match token: a normalized whole token. */
export const TOKEN_TYPE_EXACT = 0;
/** Prefix token: 2..4 chars from the start of an ASCII token. */
export const TOKEN_TYPE_PREFIX = 1;
/** Signal token: ASCII-only join across a field (`ssl check` → `sslcheck`). */
export const TOKEN_TYPE_SIGNAL = 2;
/** Join token: bigram-of-tokens for phrase/CJK matching. */
export const TOKEN_TYPE_JOIN = 3;
/** Bigram inside the compact (CJK + ASCII) projection of a field. */
export const TOKEN_TYPE_BIGRAM_HAN = 4;
/** Bigram inside the ASCII-only projection of a field. */
export const TOKEN_TYPE_BIGRAM_ASCII = 5;
export const TOKEN_TYPE_COUNT = 6;

export const TOKEN_TYPE_TO_SIGIL: readonly string[] = [
  "e",
  "p",
  "s",
  "j",
  "h",
  "g",
];

const SIGIL_TO_TYPE: Record<string, number> = {
  e: TOKEN_TYPE_EXACT,
  p: TOKEN_TYPE_PREFIX,
  s: TOKEN_TYPE_SIGNAL,
  j: TOKEN_TYPE_JOIN,
  h: TOKEN_TYPE_BIGRAM_HAN,
  g: TOKEN_TYPE_BIGRAM_ASCII,
};

export function sigilToType(sigil: string): number {
  const value = SIGIL_TO_TYPE[sigil];
  if (value === undefined) {
    throw new Error(`Unknown search feature sigil: ${sigil}`);
  }
  return value;
}
