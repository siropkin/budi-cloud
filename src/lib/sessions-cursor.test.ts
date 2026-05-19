import { describe, it, expect } from "vitest";
import {
  decodeSessionsCursor,
  encodeSessionsCursor,
} from "@/lib/sessions-cursor";

/**
 * Pins the validation contract added in #176. The Sessions cursor flows from
 * a hand-editable URL parameter into a PostgREST `.or()` filter; without
 * strict decoding, a crafted `session_id` containing PostgREST filter-tree
 * metacharacters (`,`, `(`, `)`) injects extra top-level conditions into the
 * disjunction. The decoder is the first line of defense — anything off-shape
 * collapses to `null` so the page silently falls back to "first page" rather
 * than 500ing or returning rows from outside the intended page.
 */
describe("decodeSessionsCursor (#176)", () => {
  it("round-trips a well-formed cursor", () => {
    const original = {
      lastActiveAt: "2026-04-15T10:00:00.000Z",
      sessionId: "sess_0001",
    };
    const decoded = decodeSessionsCursor(encodeSessionsCursor(original));
    expect(decoded).toEqual(original);
  });

  it("returns null for an empty / missing cursor", () => {
    expect(decodeSessionsCursor(null)).toBeNull();
    expect(decodeSessionsCursor(undefined)).toBeNull();
    expect(decodeSessionsCursor("")).toBeNull();
  });

  it("returns null when base64url decode or JSON parse fails", () => {
    expect(decodeSessionsCursor("not-base64-or-json")).toBeNull();
    expect(decodeSessionsCursor(toBase64Url("not json"))).toBeNull();
  });

  it("returns null when fields are the wrong shape", () => {
    expect(decodeSessionsCursor(toBase64Url(JSON.stringify({})))).toBeNull();
    expect(
      decodeSessionsCursor(
        toBase64Url(JSON.stringify({ lastActiveAt: 123, sessionId: "x" }))
      )
    ).toBeNull();
    expect(
      decodeSessionsCursor(
        toBase64Url(JSON.stringify({ lastActiveAt: "x", sessionId: null }))
      )
    ).toBeNull();
  });

  it("rejects lastActiveAt values that aren't a real ISO-8601 instant", () => {
    for (const lastActiveAt of [
      "not-a-date",
      "2026-13-45T99:99:99.000Z",
      "2026", // Date.parse accepts this; we don't.
      "April 15", // Same — round-trip rejects.
      "2026-04-15", // Date-only, no time component.
      "2026-04-15T10:00:00Z", // No milliseconds → toISOString won't match.
    ]) {
      const raw = toBase64Url(
        JSON.stringify({ lastActiveAt, sessionId: "sess_0001" })
      );
      expect(decodeSessionsCursor(raw)).toBeNull();
    }
  });

  it("rejects sessionId containing PostgREST filter metacharacters", () => {
    // The bug report's exact crafted shape: a `,` lifts the trailing fragment
    // up to a top-level term in the .or() disjunction, breaking the cursor
    // invariant. Same risk for `(` and `)` opening / closing a nested group.
    const lastActiveAt = "2026-01-01T00:00:00.000Z";
    for (const sessionId of [
      "x,y",
      "x)or(true",
      "a),or(last_active_at.gt.1900-01-01,and(true",
      "x(",
      "x)",
      "(",
      ")",
      ",",
    ]) {
      const raw = toBase64Url(JSON.stringify({ lastActiveAt, sessionId }));
      expect(decodeSessionsCursor(raw)).toBeNull();
    }
  });

  it("accepts sessionIds with non-metacharacter punctuation", () => {
    // A real daemon may emit hyphens / underscores / dots / colons in the id
    // (e.g. UUIDs, timestamped ids). None of these break the .or() filter
    // tree, so they round-trip cleanly.
    for (const sessionId of [
      "sess_0001",
      "8c5b2f3a-1b1c-4f2a-9b9a-2e9c6f7d4a3b",
      "claude_code:2026-04-15T10:00:00",
      "sess.with.dots",
      "sess-with-dashes",
    ]) {
      const original = {
        lastActiveAt: "2026-04-15T10:00:00.000Z",
        sessionId,
      };
      const decoded = decodeSessionsCursor(encodeSessionsCursor(original));
      expect(decoded).toEqual(original);
    }
  });

  it("normalizes PostgREST `+00:00` timestamps to the `Z` form on encode (#195)", () => {
    // PostgREST returns `timestamptz` in `+00:00` form; `Date.toISOString()`
    // only emits `Z`. Without encode-side normalization the cursor failed its
    // own round-trip check and pagination silently fell back to first page.
    const postgrestShape = "2026-05-08T02:02:02.469+00:00";
    const canonical = "2026-05-08T02:02:02.469Z";
    const decoded = decodeSessionsCursor(
      encodeSessionsCursor({
        lastActiveAt: postgrestShape,
        sessionId: "sess_0001",
      })
    );
    expect(decoded).toEqual({
      lastActiveAt: canonical,
      sessionId: "sess_0001",
    });
  });

  it("normalizes other valid offset forms on encode", () => {
    // Sanity-check the normalization isn't only `+00:00`-specific: any
    // parseable instant should round-trip into the canonical UTC `Z` form.
    const inputs: Array<[string, string]> = [
      ["2026-05-08T07:30:00.000+05:30", "2026-05-08T02:00:00.000Z"],
      ["2026-05-08T02:02:02+00:00", "2026-05-08T02:02:02.000Z"],
    ];
    for (const [input, expected] of inputs) {
      const decoded = decodeSessionsCursor(
        encodeSessionsCursor({ lastActiveAt: input, sessionId: "sess_x" })
      );
      expect(decoded).toEqual({
        lastActiveAt: expected,
        sessionId: "sess_x",
      });
    }
  });

  it("rejects oversized cursor fields", () => {
    // Defense against a megabyte-long cursor blowing up the downstream
    // .or() string. 256 chars is well above any real daemon-emitted id.
    const big = "a".repeat(257);
    expect(
      decodeSessionsCursor(
        toBase64Url(
          JSON.stringify({
            lastActiveAt: "2026-04-15T10:00:00.000Z",
            sessionId: big,
          })
        )
      )
    ).toBeNull();
    expect(
      decodeSessionsCursor(
        toBase64Url(
          JSON.stringify({
            lastActiveAt: big,
            sessionId: "sess_0001",
          })
        )
      )
    ).toBeNull();
  });
});

function toBase64Url(s: string): string {
  return Buffer.from(s, "utf8")
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}
