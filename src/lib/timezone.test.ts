import { describe, it, expect } from "vitest";
import {
  isValidTimeZone,
  localDateInTimeZone,
  utcBucketDayForLocalEnd,
  utcBucketDayForLocalStart,
  utcInstantForLocalEnd,
  utcInstantForLocalStart,
} from "./timezone";

/**
 * #282: cover the bucket-bound math that the cloud dashboard relies on to
 * keep `?days=1` in sync with the user's wall-clock day. Regressing any of
 * these helpers reintroduces the `bucket_day` drift fixed in #78 — silently
 * dropping evening-local activity from the lifetime view.
 */

describe("isValidTimeZone", () => {
  it("accepts well-known IANA zones", () => {
    expect(isValidTimeZone("UTC")).toBe(true);
    expect(isValidTimeZone("America/Los_Angeles")).toBe(true);
    expect(isValidTimeZone("Asia/Tokyo")).toBe(true);
  });

  it("rejects empty / non-string / unknown values without throwing", () => {
    expect(isValidTimeZone("")).toBe(false);
    expect(isValidTimeZone("Not/A/Zone")).toBe(false);
    // Cookie tampering: defensively coerced inputs must not crash.
    expect(isValidTimeZone(undefined as unknown as string)).toBe(false);
    expect(isValidTimeZone(null as unknown as string)).toBe(false);
    expect(isValidTimeZone(123 as unknown as string)).toBe(false);
  });
});

describe("localDateInTimeZone", () => {
  it("formats the instant as the local calendar date", () => {
    // Mid-day UTC: every zone agrees on the calendar date.
    const instant = new Date("2024-01-15T12:00:00Z");
    expect(localDateInTimeZone(instant, "UTC")).toBe("2024-01-15");
    expect(localDateInTimeZone(instant, "America/Los_Angeles")).toBe(
      "2024-01-15"
    );
    expect(localDateInTimeZone(instant, "Asia/Tokyo")).toBe("2024-01-15");
  });

  it("rolls back across the date boundary for zones west of UTC", () => {
    // 03:00 UTC on the 15th is still 19:00 on the 14th in LA (PST).
    const instant = new Date("2024-01-15T03:00:00Z");
    expect(localDateInTimeZone(instant, "America/Los_Angeles")).toBe(
      "2024-01-14"
    );
  });
});

describe("utcBucketDayForLocalStart", () => {
  it("returns the same calendar date for UTC viewers", () => {
    expect(utcBucketDayForLocalStart("2024-01-15", "UTC")).toBe("2024-01-15");
  });

  it("returns the same date for west-of-UTC zones (00:00 local is still that date in UTC)", () => {
    // LA 2024-01-15 00:00 PST = 2024-01-15 08:00 UTC → bucket day 2024-01-15.
    expect(utcBucketDayForLocalStart("2024-01-15", "America/Los_Angeles")).toBe(
      "2024-01-15"
    );
  });

  it("rolls back a day for east-of-UTC zones (00:00 local is the previous UTC day)", () => {
    // Tokyo 2024-01-15 00:00 JST = 2024-01-14 15:00 UTC → bucket day 2024-01-14.
    expect(utcBucketDayForLocalStart("2024-01-15", "Asia/Tokyo")).toBe(
      "2024-01-14"
    );
  });

  it("handles DST spring-forward without dropping a bucket", () => {
    // 2024-03-10 is the US spring-forward; the day before is PST, the day
    // after is PDT. Both must still resolve to a sane UTC bucket date.
    expect(utcBucketDayForLocalStart("2024-03-09", "America/Los_Angeles")).toBe(
      "2024-03-09"
    );
    expect(utcBucketDayForLocalStart("2024-03-11", "America/Los_Angeles")).toBe(
      "2024-03-11"
    );
  });
});

describe("utcBucketDayForLocalEnd", () => {
  it("returns the same date for UTC viewers", () => {
    expect(utcBucketDayForLocalEnd("2024-01-15", "UTC")).toBe("2024-01-15");
  });

  it("rolls forward a day for west-of-UTC zones — the #78 case", () => {
    // LA 2024-01-15 23:59:59.999 PST = 2024-01-16 07:59:59.999 UTC. Without
    // this widening, the daemon's UTC-bucketed evening activity would fall
    // outside `?days=1` for everyone west of UTC.
    expect(utcBucketDayForLocalEnd("2024-01-15", "America/Los_Angeles")).toBe(
      "2024-01-16"
    );
  });

  it("returns the same date for east-of-UTC zones (23:59 local is still that date in UTC)", () => {
    // Tokyo 2024-01-15 23:59:59.999 JST = 2024-01-15 14:59:59.999 UTC.
    expect(utcBucketDayForLocalEnd("2024-01-15", "Asia/Tokyo")).toBe(
      "2024-01-15"
    );
  });
});

describe("utcInstant helpers", () => {
  it("anchor the start of the local day at 00:00:00.000 UTC", () => {
    expect(utcInstantForLocalStart("2024-01-15", "UTC")).toBe(
      "2024-01-15T00:00:00.000Z"
    );
    // LA midnight PST is 08:00 UTC.
    expect(utcInstantForLocalStart("2024-01-15", "America/Los_Angeles")).toBe(
      "2024-01-15T08:00:00.000Z"
    );
  });

  it("anchor the end of the local day at 23:59:59.999 UTC", () => {
    expect(utcInstantForLocalEnd("2024-01-15", "UTC")).toBe(
      "2024-01-15T23:59:59.999Z"
    );
    // LA 23:59:59.999 PST is 07:59:59.999 UTC the next day.
    expect(utcInstantForLocalEnd("2024-01-15", "America/Los_Angeles")).toBe(
      "2024-01-16T07:59:59.999Z"
    );
  });

  it("preserves the milliseconds component across the offset round-trip", () => {
    // Regression guard for the `.999 → .998` floor mentioned in the source
    // comment — the sec-aligned offset must not steal precision from the
    // upper bound passed to session_summaries queries.
    expect(utcInstantForLocalEnd("2024-01-15", "UTC")).toMatch(/\.999Z$/);
    expect(utcInstantForLocalEnd("2024-01-15", "America/Los_Angeles")).toMatch(
      /\.999Z$/
    );
  });
});
