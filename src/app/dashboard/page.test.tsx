import { describe, it, expect, vi, beforeEach } from "vitest";
import { containsSuspense, extractText } from "@/test-utils/page-tree";

/**
 * Page-level coverage for `/dashboard` (the Overview page).
 *
 * Locks in four contracts the recent dashboard PRs have shipped without
 * page-level integration tests (#112):
 *   1. Smoke — the page renders against a populated DAL response.
 *   2. Empty — empty totals + empty activity series render the page chrome
 *      instead of crashing on a missing field.
 *   3. Loading — the page composes a `<Suspense>` boundary around the
 *      filter cluster so the rest of the tree streams while filters load.
 *   4. Error — DAL faults propagate so the framework's error boundary can
 *      render its fallback (rather than the page silently rendering empty).
 */

vi.mock("server-only", () => ({}));
vi.mock("@/lib/viewer-timezone", () => ({
  getViewerTimeZone: async () => "UTC",
}));
vi.mock("next/navigation", () => ({
  redirect: (to: string) => {
    throw new Error(`__REDIRECT__:${to}`);
  },
  notFound: () => {
    throw new Error("__NOT_FOUND__");
  },
}));

const dal = {
  getCurrentUser: vi.fn(),
  getOverviewStats: vi.fn(),
  getDailyActivity: vi.fn(),
  getEarliestActivity: vi.fn(),
  getOrgMembers: vi.fn(),
  getSyncFreshness: vi.fn(),
};
vi.mock("@/lib/dal", () => dal);

const MANAGER = {
  id: "usr_ivan",
  org_id: "org_team",
  role: "manager",
  api_key: "budi_i",
  display_name: "Ivan",
  email: "ivan@example.com",
};

beforeEach(() => {
  for (const fn of Object.values(dal)) fn.mockReset();
  dal.getCurrentUser.mockResolvedValue(MANAGER);
  dal.getOverviewStats.mockResolvedValue({
    totalCostCents: 1_234_56,
    totalInputTokens: 4000,
    totalOutputTokens: 2000,
    totalMessages: 17,
    totalSessions: 5,
  });
  dal.getDailyActivity.mockResolvedValue([
    {
      bucket_day: "2026-04-15",
      input_tokens: 4000,
      output_tokens: 2000,
      cost_cents: 1_234_56,
      message_count: 17,
    },
  ]);
  dal.getEarliestActivity.mockResolvedValue("2026-04-01");
  dal.getOrgMembers.mockResolvedValue([]);
  dal.getSyncFreshness.mockResolvedValue({
    deviceCount: 1,
    lastSeenAt: "2026-04-15T10:00:00Z",
    lastRollupAt: "2026-04-15T10:00:00Z",
    lastSessionAt: "2026-04-15T10:00:00Z",
  });
});

async function render(searchParams: Record<string, string> = {}) {
  const mod = await import("./page");
  return mod.default({ searchParams: Promise.resolve(searchParams) });
}

describe("dashboard /page (Overview)", () => {
  it("smoke: renders headline, stat cards, and the daily-activity card with populated DAL data", async () => {
    const node = await render();
    expect(node).toBeTruthy();
    const text = extractText(node);
    expect(text).toContain("Overview");
    expect(text).toContain("Daily Activity (Tokens)");
    // The four stat-card titles are part of the page's primary contract.
    expect(text).toContain("Total Cost");
    expect(text).toContain("Total Tokens");
    expect(text).toContain("Messages");
    expect(text).toContain("Sessions");
  });

  it("empty: renders headline + zero-value stat cards (not a crash) when the org has no devices yet", async () => {
    dal.getOverviewStats.mockResolvedValue({
      totalCostCents: 0,
      totalInputTokens: 0,
      totalOutputTokens: 0,
      totalMessages: 0,
      totalSessions: 0,
    });
    dal.getDailyActivity.mockResolvedValue([]);
    dal.getSyncFreshness.mockResolvedValue({
      deviceCount: 0,
      lastSeenAt: null,
      lastRollupAt: null,
      lastSessionAt: null,
    });

    const node = await render();
    expect(node).toBeTruthy();
    const text = extractText(node);
    // Page deliberately distinguishes "no devices" from "no data" — the
    // empty-org case must still render the headline + stat cards (zero
    // values), not throw.
    expect(text).toContain("Overview");
    expect(text).toContain("Total Cost");
  });

  it("loading: composes a Suspense boundary around the filter cluster so the page can stream", async () => {
    const node = await render();
    expect(containsSuspense(node)).toBe(true);
  });

  it("error: a DAL fault propagates so the framework error boundary can render its fallback", async () => {
    dal.getOverviewStats.mockRejectedValue(new Error("__DAL_BOOM__"));
    await expect(render()).rejects.toThrow("__DAL_BOOM__");
  });

  it("returns null (no leak) when the viewer has no org_id yet", async () => {
    dal.getCurrentUser.mockResolvedValue({ ...MANAGER, org_id: null });
    const node = await render();
    expect(node).toBeNull();
  });
});
