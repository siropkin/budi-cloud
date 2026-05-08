import type { SessionsCursor } from "@/lib/dal";

/**
 * URL serialization for the Sessions page cursor.
 *
 * `session_id` is daemon-provided TEXT, so we don't trust it to be free of
 * URL-meaningful characters. Encoding the `(started_at, session_id)` tuple as
 * base64url JSON keeps the cursor opaque to the browser/router and avoids any
 * delimiter collision the daemon could trip on. A malformed cursor decodes to
 * `null` so a hand-edited URL silently falls back to "first page" rather than
 * 500ing — same defensive posture as the user filter in #80.
 */
export function encodeSessionsCursor(cursor: SessionsCursor): string {
  const json = JSON.stringify({
    startedAt: normalizeIsoInstant(cursor.startedAt),
    sessionId: cursor.sessionId,
  });
  return base64UrlEncode(json);
}

/**
 * PostgREST returns `timestamptz` columns in the `+00:00` offset form
 * (e.g. `2026-05-08T02:02:02.469+00:00`), but `Date.prototype.toISOString()`
 * only ever emits the `Z` form. The decoder validates `startedAt` by
 * round-tripping through `toISOString()` (#176), so without normalization
 * here every real cursor produced from `tail.started_at` failed to round-trip
 * and the page silently fell back to "first page" (#195). We normalize once
 * at encode time so the encoded cursor is always in the canonical `Z` shape
 * the decoder expects, regardless of what the daemon / PostgREST emits.
 *
 * If the value isn't parseable we leave it alone — the decoder will reject
 * it, which is the correct behavior for non-instant input.
 */
function normalizeIsoInstant(value: string): string {
  const ms = Date.parse(value);
  if (Number.isNaN(ms)) return value;
  return new Date(ms).toISOString();
}

/**
 * Defense-in-depth caps for #176. The cursor value flows into a PostgREST
 * `.or()` filter that historically built the expression via string
 * interpolation (`getSessions`). Even though the DAL now quotes/escapes
 * cursor values before interpolation, decoding still validates here so a
 * crafted URL falls back cleanly to "first page" instead of producing a 500
 * deeper in the query path.
 *
 * - `startedAt` must round-trip through `Date` and reproduce the same string,
 *   pinning it to a real ISO-8601 instant (e.g. `2026-04-15T10:00:00.000Z`).
 *   This rejects free-form strings the cursor was never meant to carry.
 * - `sessionId` must not contain `,` `(` `)` — the PostgREST filter-tree
 *   delimiters that drove the original injection report. Real daemons emit
 *   opaque token-shaped ids; these characters never legitimately appear.
 * - Both are length-capped so a megabyte-long cursor can't blow up the
 *   downstream `.or()` string.
 */
const MAX_CURSOR_FIELD_LEN = 256;
const SESSION_ID_DISALLOWED = /[,()]/;

export function decodeSessionsCursor(
  raw: string | null | undefined
): SessionsCursor | null {
  if (!raw) return null;
  try {
    const json = base64UrlDecode(raw);
    const parsed = JSON.parse(json) as Partial<SessionsCursor>;
    if (
      typeof parsed.startedAt !== "string" ||
      typeof parsed.sessionId !== "string"
    ) {
      return null;
    }
    if (
      parsed.startedAt.length > MAX_CURSOR_FIELD_LEN ||
      parsed.sessionId.length > MAX_CURSOR_FIELD_LEN
    ) {
      return null;
    }
    if (!isIsoInstant(parsed.startedAt)) return null;
    if (SESSION_ID_DISALLOWED.test(parsed.sessionId)) return null;
    return { startedAt: parsed.startedAt, sessionId: parsed.sessionId };
  } catch {
    return null;
  }
}

/**
 * `Date.parse` happily accepts plenty of strings the cursor should not carry
 * (`"2026"`, `"April 15"`, …). Round-tripping through `toISOString()` is the
 * cheapest way to require an actual UTC instant the daemon would emit.
 */
function isIsoInstant(value: string): boolean {
  const ms = Date.parse(value);
  if (Number.isNaN(ms)) return false;
  return new Date(ms).toISOString() === value;
}

function base64UrlEncode(s: string): string {
  const base64 = Buffer.from(s, "utf8").toString("base64");
  return base64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64UrlDecode(s: string): string {
  const padded = s.replace(/-/g, "+").replace(/_/g, "/");
  const padLen = (4 - (padded.length % 4)) % 4;
  return Buffer.from(padded + "=".repeat(padLen), "base64").toString("utf8");
}
