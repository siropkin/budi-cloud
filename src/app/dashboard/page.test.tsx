import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  collectClassNames,
  containsSuspense,
  extractText,
} from "@/test-utils/page-tree";

/**
 * Find an element with a given displayName / function name anywhere in the
 * tree. Lighter than rendering — Server Component bodies aren't invoked, so
 * the walker just sees component nodes by their type. Used by the #235
 * tests to assert the cost-lens toggle is or isn't mounted without peeking
 * inside its function body.
 */
function containsElementType(node: unknown, name: string): boolean {
  const seen = new WeakSet<object>();
  function walk(n: unknown): boolean {
    if (n == null || typeof n === "boolean") return false;
    if (typeof n === "string" || typeof n === "number") return false;
    if (Array.isArray(n)) return n.some(walk);
    if (typeof n !== "object") return false;
    if (seen.has(n as object)) return false;
    seen.add(n as object);
    const el = n as { type?: unknown; props?: { children?: unknown } };
    const t = el.type as
      | { displayName?: string; name?: string }
      | string
      | undefined;
    if (
      t &&
      typeof t === "function" &&
      ((t as { displayName?: string }).displayName === name ||
        (t as { name?: string }).name === name)
    ) {
      return true;
    }
    return walk(el.props?.children);
  }
  return walk(node);
}

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
  getWorkspaceHasActivePriceList: vi.fn(),
  getWorkspaceMembers: vi.fn(),
  getSyncFreshness: vi.fn(),
  getCostByModel: vi.fn(),
  getCostByRepo: vi.fn(),
  getCostByUser: vi.fn(),
  getCostBySurface: vi.fn(),
  getKnownSurfaces: vi.fn(),
  getActivityHeatmap: vi.fn(),
};
vi.mock("@/lib/dal", () => ({
  ...dal,
  UNASSIGNED_USER_ID: "__unassigned__",
}));

const MANAGER = {
  id: "usr_ivan",
  workspace_id: "org_team",
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
    totalCostCentsIngested: 1_234_56,
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
      cost_cents_ingested: 1_234_56,
      message_count: 17,
    },
  ]);
  dal.getEarliestActivity.mockResolvedValue("2026-04-01");
  dal.getWorkspaceHasActivePriceList.mockResolvedValue(false);
  dal.getWorkspaceMembers.mockResolvedValue([]);
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
  // #187 surface dimension. Default fixture: a multi-surface workspace so the
  // chip renders and the "Spend by Surface" card has non-zero data;
  // single-surface coverage is in the dedicated test.
  dal.getKnownSurfaces.mockResolvedValue(["cursor", "vscode"]);
  dal.getCostBySurface.mockResolvedValue([
    {
      surface: "vscode",
      cost_cents: 80_000,
      input_tokens: 3000,
      output_tokens: 1500,
    },
    {
      surface: "cursor",
      cost_cents: 40_000,
      input_tokens: 1000,
      output_tokens: 500,
    },
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

  it("empty: renders headline + zero-value stat cards (not a crash) when the workspace has no devices yet", async () => {
    dal.getOverviewStats.mockResolvedValue({
      totalCostCents: 0,
      totalCostCentsIngested: 0,
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
    // empty-workspace case must still render the headline + stat cards (zero
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

  it("mobile: header stacks below sm: and the filter cluster wraps so the time-range buttons cannot be clipped (#117, #270)", async () => {
    const node = await render();
    // The page mounts the shared <PageHeader>, which owns the
    // `flex-col … sm:flex-row sm:justify-between` stacking. The classes
    // themselves are covered by page-header.test.tsx — here we only pin
    // that the page hasn't drifted back to an inline header div.
    expect(containsElementType(node, "PageHeader")).toBe(true);
    // Inner filter cluster must opt into wrapping; without `flex-wrap` the
    // PeriodSelector's "All" button is what gets pushed off-screen.
    const classes = collectClassNames(node);
    const wrapping = classes.find(
      (c) => c.includes("flex-wrap") && c.includes("items-center")
    );
    expect(wrapping).toBeTruthy();
  });

  it("returns null (no leak) when the viewer has no workspace_id yet", async () => {
    dal.getCurrentUser.mockResolvedValue({ ...MANAGER, workspace_id: null });
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

  it("surface filter: ?surface=vscode threads through to every breakdown DAL call so every chart on the page narrows to one surface (#187)", async () => {
    await render({ surface: "vscode" });
    // Every breakdown helper that takes scope should see the surface
    // narrowed to ["vscode"]. The chip carries the URL into the DAL via
    // `parseSurfaceParam`, so a regression that drops the wiring on a
    // single helper would surface here.
    for (const fn of [
      dal.getOverviewStats,
      dal.getDailyActivity,
      dal.getCostByModel,
      dal.getCostByRepo,
      dal.getCostByUser,
      dal.getCostBySurface,
    ]) {
      const lastCall = fn.mock.calls.at(-1);
      expect(
        lastCall,
        `${fn.getMockName?.() ?? "dal fn"} was not called`
      ).toBeTruthy();
      const scope = lastCall![lastCall!.length - 1];
      expect(scope).toMatchObject({ surfaces: ["vscode"] });
    }
  });

  it("surface filter: CSV `?surface=vscode,cursor` is parsed into a multi-value scope (#187 acceptance)", async () => {
    await render({ surface: "vscode,cursor" });
    const overviewCall = dal.getOverviewStats.mock.calls.at(-1);
    expect(overviewCall).toBeTruthy();
    const scope = overviewCall![overviewCall!.length - 1];
    expect(scope).toMatchObject({ surfaces: ["vscode", "cursor"] });
  });

  it("surface chart: renders the 'Spend by Surface' card and pulls per-surface costs from the DAL (#187)", async () => {
    const node = await render();
    const text = extractText(node);
    expect(text).toContain("Spend by Surface");
    expect(dal.getCostBySurface).toHaveBeenCalled();
    // The chart receives bars as a prop array (not visible in extractText),
    // so the user-facing assertion lives on the card title — the DAL-call
    // assertion above is what catches a regression that drops the data
    // pipeline upstream of the chart.
  });

  it("surface chart: single-surface workspace renders an empty-state copy that names the next-state condition (#187)", async () => {
    dal.getKnownSurfaces.mockResolvedValue(["vscode"]);
    dal.getCostBySurface.mockResolvedValue([
      {
        surface: "vscode",
        cost_cents: 0,
        input_tokens: 0,
        output_tokens: 0,
      },
    ]);
    const node = await render();
    const text = extractText(node);
    expect(text).toContain("Spend by Surface");
    expect(text).toContain("Single-surface workspace");
  });

  it("surface chart: all-unknown period falls back to the empty-state with the daemon-version unlock copy, not a single self-tautological bar (#210)", async () => {
    dal.getKnownSurfaces.mockResolvedValue(["unknown"]);
    dal.getCostBySurface.mockResolvedValue([
      {
        surface: "unknown",
        cost_cents: 193_776,
        input_tokens: 100_000,
        output_tokens: 5_000_000,
      },
    ]);
    const node = await render();
    const text = extractText(node);
    expect(text).toContain("Spend by Surface");
    expect(text).toContain("every row in this window is tagged Unknown");
    expect(text).toContain("v8.4.2");
    // The single-surface copy is for "one *named* surface" — must not fire
    // here, otherwise a viewer is told to wait for a second IDE when the
    // real unlock is a daemon upgrade.
    expect(text).not.toContain("Single-surface workspace");
  });

  it("savings strip is removed: never appears regardless of price-list/cost state", async () => {
    // The Saved This Period strip was removed per user request — the
    // CostLensToggle on the activity charts now does all the surfacing of
    // list-vs-effective deltas. Pin the absence so a revert that brings the
    // banner back trips the test.
    dal.getWorkspaceHasActivePriceList.mockResolvedValue(true);
    dal.getOverviewStats.mockResolvedValue({
      totalCostCents: 352_777,
      totalCostCentsIngested: 481_520,
      totalInputTokens: 4000,
      totalOutputTokens: 2000,
      totalMessages: 17,
      totalSessions: 5,
    });
    const node = await render();
    const text = extractText(node);
    expect(text).not.toContain("saved this period");
    expect(text).not.toContain("negotiated rates");
  });

  it("cost-lens toggle: hidden when ingested == effective for every visible point (#235 acceptance)", async () => {
    dal.getWorkspaceHasActivePriceList.mockResolvedValue(true);
    // Every row has equal ingested/effective — the toggle would be a no-op,
    // so it must collapse to keep the chrome quiet.
    dal.getDailyActivity.mockResolvedValue([
      {
        bucket_day: "2026-04-15",
        input_tokens: 4000,
        output_tokens: 2000,
        cost_cents: 100_00,
        cost_cents_ingested: 100_00,
        message_count: 17,
      },
    ]);
    const node = await render();
    expect(containsElementType(node, "CostLensToggle")).toBe(false);
  });

  it("cost-lens toggle: hidden when no active price list exists, even if mocked data carries a delta (#235)", async () => {
    dal.getWorkspaceHasActivePriceList.mockResolvedValue(false);
    dal.getDailyActivity.mockResolvedValue([
      {
        bucket_day: "2026-04-15",
        input_tokens: 4000,
        output_tokens: 2000,
        cost_cents: 70_00,
        cost_cents_ingested: 100_00,
        message_count: 17,
      },
    ]);
    const node = await render();
    expect(containsElementType(node, "CostLensToggle")).toBe(false);
  });

  it("cost-lens toggle: visible when any point has list ≠ effective and a price list is active (#235)", async () => {
    dal.getWorkspaceHasActivePriceList.mockResolvedValue(true);
    dal.getDailyActivity.mockResolvedValue([
      {
        bucket_day: "2026-04-15",
        input_tokens: 4000,
        output_tokens: 2000,
        cost_cents: 70_00,
        cost_cents_ingested: 100_00,
        message_count: 17,
      },
    ]);
    const node = await render();
    expect(containsElementType(node, "CostLensToggle")).toBe(true);
  });

  it("cost-lens toggle: hidden under ?units=tokens (the toggle only configures the dollar lens) (#235)", async () => {
    dal.getWorkspaceHasActivePriceList.mockResolvedValue(true);
    dal.getDailyActivity.mockResolvedValue([
      {
        bucket_day: "2026-04-15",
        input_tokens: 4000,
        output_tokens: 2000,
        cost_cents: 70_00,
        cost_cents_ingested: 100_00,
        message_count: 17,
      },
    ]);
    const node = await render({ units: "tokens" });
    expect(containsElementType(node, "CostLensToggle")).toBe(false);
  });

  it("surface chart: mixed window with a small unknown slice keeps the unknown bar visible alongside named surfaces (#210)", async () => {
    dal.getKnownSurfaces.mockResolvedValue(["vscode", "unknown"]);
    dal.getCostBySurface.mockResolvedValue([
      {
        surface: "vscode",
        cost_cents: 80_000,
        input_tokens: 3000,
        output_tokens: 1500,
      },
      {
        surface: "unknown",
        cost_cents: 5_000,
        input_tokens: 100,
        output_tokens: 50,
      },
    ]);
    const node = await render();
    const text = extractText(node);
    expect(text).toContain("Spend by Surface");
    // Mixed window must NOT trigger the all-unknown empty-state copy —
    // managers want to see how much spend is untagged in absolute terms.
    expect(text).not.toContain("every row in this window is tagged Unknown");
    expect(text).not.toContain("Single-surface workspace");
  });
});
