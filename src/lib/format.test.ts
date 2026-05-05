import { describe, it, expect } from "vitest";
import { formatDuration, repoName } from "./format";

describe("formatDuration (#88)", () => {
  it("uses duration_ms when provided", () => {
    expect(formatDuration(60_000)).toBe("1m");
    expect(formatDuration(30 * 60_000)).toBe("30m");
    expect(formatDuration(2 * 60 * 60_000 + 15 * 60_000)).toBe("2h 15m");
  });

  it("falls back to ended_at - started_at when duration_ms is null", () => {
    const startedAt = "2026-04-29T10:00:00Z";
    const endedAt = "2026-04-29T10:45:00Z";
    expect(formatDuration(null, startedAt, endedAt)).toBe("45m");
  });

  it("returns '<1m' for sub-minute durations", () => {
    const startedAt = "2026-04-29T10:00:00Z";
    const endedAt = "2026-04-29T10:00:30Z";
    expect(formatDuration(null, startedAt, endedAt)).toBe("<1m");
    expect(formatDuration(30_000)).toBe("<1m");
  });

  it("returns '-' when both duration_ms and timestamps are missing", () => {
    expect(formatDuration(null)).toBe("-");
    expect(formatDuration(null, null, null)).toBe("-");
    expect(formatDuration(undefined, undefined, undefined)).toBe("-");
  });

  it("returns '-' when only one timestamp is present", () => {
    expect(formatDuration(null, "2026-04-29T10:00:00Z", null)).toBe("-");
    expect(formatDuration(null, null, "2026-04-29T10:00:00Z")).toBe("-");
  });

  it("returns '-' for negative deltas (clock skew)", () => {
    expect(
      formatDuration(null, "2026-04-29T11:00:00Z", "2026-04-29T10:00:00Z")
    ).toBe("-");
  });

  it("returns '-' for unparseable timestamps", () => {
    expect(formatDuration(null, "not-a-date", "also-bad")).toBe("-");
  });

  it("prefers duration_ms over the timestamp fallback when both are usable", () => {
    expect(
      formatDuration(60_000, "2026-04-29T10:00:00Z", "2026-04-29T11:00:00Z")
    ).toBe("1m");
  });
});

describe("repoName (#121)", () => {
  it("returns sentinel display strings for empty / untagged ids", () => {
    expect(repoName(null)).toBe("(unknown)");
    expect(repoName("Unassigned")).toBe("(no repo)");
    expect(repoName("(untagged)")).toBe("(no repo)");
  });

  it("strips the host so `owner/repo` survives chart label truncation", () => {
    expect(repoName("github.com/siropkin/budi-cloud")).toBe(
      "siropkin/budi-cloud"
    );
    expect(repoName("gitlab.com/team/project")).toBe("team/project");
  });

  it("keeps short non-URL ids as-is and shortens long opaque ids", () => {
    expect(repoName("local")).toBe("local");
    expect(repoName("a-fairly-long-opaque-id-string")).toBe("a-fairly-lon...");
  });

  it("shortens hashed sha256 ids", () => {
    expect(repoName("sha256:abcdef0123456789xyz")).toBe("abcdef01...");
  });
});
