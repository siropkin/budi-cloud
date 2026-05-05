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

vi.mock("@/lib/dal", () => dal);

beforeEach(() => {
  dal.getCurrentUser.mockReset();
  dal.getSyncFreshness.mockReset();
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
});
