import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * #133: `GET /api/freshness` — cheap read-only watermark probe used by the
 * dashboard header to detect a newer daemon upload than what was SSR'd
 * with the page, then trigger `router.refresh()`.
 *
 * Tests treat `getCurrentUser`/`getSyncFreshness` as the bounded API and
 * mock them directly — the route handler is a thin auth + JSON wrapper.
 */

const dal = vi.hoisted(() => ({
  getCurrentUser: vi.fn(),
  getSyncFreshness: vi.fn(),
}));

const rateLimitState = vi.hoisted(() => ({ blocked: false }));

vi.mock("@/lib/dal", () => dal);

vi.mock("@/lib/supabase/admin", () => ({
  // The rate-limit helper is the only consumer of the admin client in this
  // route. Returning a tiny `rpc` shim keeps the test focused on the route's
  // behaviour rather than reproducing the full Supabase surface.
  createAdminClient: () => ({
    rpc: async () => ({
      data: [
        {
          allowed: !rateLimitState.blocked,
          remaining: rateLimitState.blocked ? 0 : 59,
          reset_at: new Date(Date.now() + 60_000).toISOString(),
        },
      ],
      error: null,
    }),
  }),
}));

beforeEach(() => {
  dal.getCurrentUser.mockReset();
  dal.getSyncFreshness.mockReset();
  rateLimitState.blocked = false;
});

describe("GET /api/freshness (#133)", () => {
  it("returns the freshness snapshot for the current user", async () => {
    dal.getCurrentUser.mockResolvedValue({ id: "usr_a", org_id: "org_x" });
    dal.getSyncFreshness.mockResolvedValue({
      deviceCount: 1,
      lastSeenAt: "2026-05-05T22:00:00Z",
      lastRollupAt: "2026-05-05T21:55:00Z",
      lastSessionAt: "2026-05-05T21:30:00Z",
    });

    const { GET } = await import("./route");
    const res = await GET();
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toEqual({
      deviceCount: 1,
      lastSeenAt: "2026-05-05T22:00:00Z",
      lastRollupAt: "2026-05-05T21:55:00Z",
      lastSessionAt: "2026-05-05T21:30:00Z",
    });
  });

  it("401s when the viewer is not authenticated", async () => {
    dal.getCurrentUser.mockResolvedValue(null);

    const { GET } = await import("./route");
    const res = await GET();
    expect(res.status).toBe(401);
    expect(dal.getSyncFreshness).not.toHaveBeenCalled();
  });

  it("returns 429 with Retry-After when the bucket is exhausted (#179)", async () => {
    dal.getCurrentUser.mockResolvedValue({ id: "usr_a", org_id: "org_x" });
    rateLimitState.blocked = true;

    const { GET } = await import("./route");
    const res = await GET();
    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBeTruthy();
    expect(res.headers.get("X-RateLimit-Limit")).toBe("60");
    // Freshness is never queried when the rate-limit short-circuits.
    expect(dal.getSyncFreshness).not.toHaveBeenCalled();
  });

  it("emits rate-limit headers on a successful response (#179)", async () => {
    dal.getCurrentUser.mockResolvedValue({ id: "usr_a", org_id: "org_x" });
    dal.getSyncFreshness.mockResolvedValue({
      deviceCount: 0,
      lastSeenAt: null,
      lastRollupAt: null,
      lastSessionAt: null,
    });

    const { GET } = await import("./route");
    const res = await GET();
    expect(res.status).toBe(200);
    expect(res.headers.get("X-RateLimit-Limit")).toBe("60");
    expect(res.headers.get("X-RateLimit-Remaining")).toBe("59");
  });
});
