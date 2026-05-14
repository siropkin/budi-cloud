import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * #282: lock in the viewer-timezone cookie contract. The dashboard pages
 * call `getViewerTimeZone()` before composing the date-range filter, so a
 * regression that silently treats an invalid cookie as "trusted" would
 * reintroduce the #78 bucket-drift across the entire dashboard.
 *
 * `next/headers` is server-only, so we mock the cookies adapter and import
 * the module lazily inside each test (matches the csp.test.ts pattern).
 */

const cookieStore = new Map<string, string>();

// `viewer-timezone` declares `import "server-only"`, which Next.js ships as
// an empty CJS module at runtime but isn't resolvable from a plain vitest
// process. The mock keeps the import a no-op.
vi.mock("server-only", () => ({}));

vi.mock("next/headers", () => ({
  cookies: async () => ({
    get(name: string) {
      const value = cookieStore.get(name);
      return value === undefined ? undefined : { name, value };
    },
  }),
}));

beforeEach(() => {
  cookieStore.clear();
});

describe("getViewerTimeZone", () => {
  it("returns the cookie value when it is a real IANA zone", async () => {
    cookieStore.set("budi_tz", "America/Los_Angeles");
    const { getViewerTimeZone } = await import("./viewer-timezone");
    await expect(getViewerTimeZone()).resolves.toBe("America/Los_Angeles");
  });

  it("returns null when the cookie is missing — callers then fall back to UTC", async () => {
    const { getViewerTimeZone } = await import("./viewer-timezone");
    await expect(getViewerTimeZone()).resolves.toBeNull();
  });

  it("returns null when the cookie is present but not a valid zone", async () => {
    // Defense against cookie tampering / a stale value from a runtime that
    // accepted a zone our current runtime no longer knows.
    cookieStore.set("budi_tz", "Not/A/Zone");
    const { getViewerTimeZone } = await import("./viewer-timezone");
    await expect(getViewerTimeZone()).resolves.toBeNull();
  });

  it("returns null when the cookie value is empty", async () => {
    cookieStore.set("budi_tz", "");
    const { getViewerTimeZone } = await import("./viewer-timezone");
    await expect(getViewerTimeZone()).resolves.toBeNull();
  });
});

describe("TIMEZONE_COOKIE", () => {
  it("matches the name the browser-side <TimeZoneSync /> writes", async () => {
    const { TIMEZONE_COOKIE } = await import("./viewer-timezone");
    expect(TIMEZONE_COOKIE).toBe("budi_tz");
  });
});
