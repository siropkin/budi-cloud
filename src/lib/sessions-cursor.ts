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
  const json = JSON.stringify(cursor);
  return base64UrlEncode(json);
}

export function decodeSessionsCursor(
  raw: string | null | undefined
): SessionsCursor | null {
  if (!raw) return null;
  try {
    const json = base64UrlDecode(raw);
    const parsed = JSON.parse(json) as Partial<SessionsCursor>;
    if (
      typeof parsed.startedAt === "string" &&
      typeof parsed.sessionId === "string"
    ) {
      return { startedAt: parsed.startedAt, sessionId: parsed.sessionId };
    }
    return null;
  } catch {
    return null;
  }
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
