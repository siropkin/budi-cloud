import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  collectClassNames,
  containsSuspense,
  extractText,
} from "@/test-utils/page-tree";

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
  getCostByModel: vi.fn(),
  getCostByRepo: vi.fn(),
  getCostByUser: vi.fn(),
  getActivityHeatmap: vi.fn(),
};
vi.mock("@/lib/dal", () => ({
  ...dal,
  UNASSIGNED_USER_ID: "__unassigned__",
}));

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
  dal.getCostByModel.mockResolvedValue([
    {
      provider: "anthropic",
      model: "claude-sonnet-4-5",
      cost_cents: 80_000,
      input_tokens: 3000,
      output_tokens: 1500,
    },
  ]);
  dal.getCostByRepo.mockResolvedValue([
    {
      repo_id: "github.com/acme/widgets",
      cost_cents: 60_000,
      input_tokens: 2000,
      output_tokens: 1000,
    },
  ]);
  dal.getCostByUser.mockResolvedValue([
    {
      id: "usr_alice",
      name: "Alice",
      cost_cents: 90_000,
      input_tokens: 3500,
      output_tokens: 1800,
    },
  ]);
  dal.getActivityHeatmap.mockResolvedValue([
    { dow: 2, hour: 14, session_count: 3, cost_cents: 50_000 },
  ]);
});

async function render(searchParams: Record<string, string> = {}) {
  const mod = await import("./page");
  return mod.default({ searchParams: Promise.resolve(searchParams) });
}

describe("dashboard /page (Overview)", () => {
  it("smoke: renders headline, the dollars-default stat cards, and the daily-activity card with populated DAL data", async () => {
    const node = await render();
    expect(node).toBeTruthy();
    const text = extractText(node);
    expect(text).toContain("Overview");
    // Default unit is dollars (#128), so the activity card carries the Cost
    // suffix and the spend card is `Total Cost` — `Total Tokens` only
    // appears when the toggle is flipped to tokens.
    expect(text).toContain("Daily Activity (Cost)");
    expect(text).toContain("Total Cost");
    expect(text).toContain("Messages");
    expect(text).toContain("Sessions");
    expect(text).not.toContain("Total Tokens");
  });

  it("units toggle: ?units=tokens swaps Total Cost for Total Tokens and re-titles the activity card (#128)", async () => {
    const node = await render({ units: "tokens" });
    const text = extractText(node);
    expect(text).toContain("Daily Activity (Tokens)");
    expect(text).toContain("Total Tokens");
    expect(text).not.toContain("Total Cost");
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

  it("mobile: header stacks below sm: and the filter cluster wraps so the time-range buttons cannot be clipped (#117)", async () => {
    const node = await render();
    const classes = collectClassNames(node);
    // Outer header row stacks vertically by default and only switches to a
    // horizontal layout at the `sm` breakpoint — this is what keeps the
    // title + team scope + period buttons from sharing one ~470px row on
    // a 375px phone.
    const stacked = classes.find(
      (c) =>
        c.includes("flex-col") &&
        c.includes("sm:flex-row") &&
        c.includes("sm:justify-between")
    );
    expect(stacked).toBeTruthy();
    // Inner filter cluster must opt into wrapping; without `flex-wrap` the
    // PeriodSelector's "All" button is what gets pushed off-screen.
    const wrapping = classes.find(
      (c) => c.includes("flex-wrap") && c.includes("items-center")
    );
    expect(wrapping).toBeTruthy();
  });

  it("returns null (no leak) when the viewer has no org_id yet", async () => {
    dal.getCurrentUser.mockResolvedValue({ ...MANAGER, org_id: null });
    const node = await render();
    expect(node).toBeNull();
  });

  it("top-breakdowns: manager sees Top model / Top contributor / Top repo cards once data has synced (#150)", async () => {
    const node = await render();
    const text = extractText(node);
    expect(text).toContain("Top model");
    expect(text).toContain("Top contributor");
    expect(text).toContain("Top repo");
    expect(text).toContain("claude-sonnet-4-5");
    expect(text).toContain("Alice");
  });

  it("top-breakdowns: members never see the Top contributor card (their own row would be the only one)", async () => {
    dal.getCurrentUser.mockResolvedValue({ ...MANAGER, role: "member" });
    const node = await render();
    const text = extractText(node);
    expect(text).toContain("Top model");
    expect(text).toContain("Top repo");
    expect(text).not.toContain("Top contributor");
  });

  it("top-breakdowns: do not render before first sync (link banner / first-sync banner suppress the row)", async () => {
    dal.getSyncFreshness.mockResolvedValue({
      deviceCount: 0,
      lastSeenAt: null,
      lastRollupAt: null,
      lastSessionAt: null,
    });
    const node = await render();
    const text = extractText(node);
    expect(text).not.toContain("Top model");
    expect(text).not.toContain("Top repo");
  });

  it("top-breakdowns: a manager who has scoped to a single user does not see Top contributor (it would only echo the filter)", async () => {
    const node = await render({ user: "usr_bob" });
    const text = extractText(node);
    expect(text).toContain("Top model");
    expect(text).toContain("Top repo");
    expect(text).not.toContain("Top contributor");
  });
});
