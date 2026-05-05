import { describe, it, expect, vi, beforeEach } from "vitest";
import { containsSuspense, extractText } from "@/test-utils/page-tree";

/**
 * Page-level coverage for `/dashboard/team` (#112, #131).
 *
 * Defense-in-depth ladder is the moving part to lock down here:
 *   1. Smoke — manager view renders Team headline, the merged cost-by-member
 *      card (chart + table together), and headline averages on each
 *      time-series card.
 *   2. Empty — empty `getCostByUser` still renders the chart-empty fallback.
 *   3. Loading — `<Suspense>` wraps the period selector.
 *   4. Error — DAL faults propagate so the framework error boundary fires.
 *   5. Members are redirected to /dashboard (ADR-0083 §6).
 */

vi.mock("server-only", () => ({}));
vi.mock("@/lib/viewer-timezone", () => ({
  getViewerTimeZone: async () => "UTC",
}));

const redirectMock = vi.fn((to: string) => {
  throw new Error(`__REDIRECT__:${to}`);
});
vi.mock("next/navigation", () => ({
  redirect: (to: string) => redirectMock(to),
  notFound: () => {
    throw new Error("__NOT_FOUND__");
  },
}));

const dal = {
  getCurrentUser: vi.fn(),
  getCostByUser: vi.fn(),
  getEarliestActivity: vi.fn(),
  getTeamActivityByDay: vi.fn(),
  UNASSIGNED_USER_ID: "__unassigned__",
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
  redirectMock.mockClear();
  dal.getCurrentUser.mockReset().mockResolvedValue(MANAGER);
  dal.getCostByUser.mockReset().mockResolvedValue([
    {
      id: "usr_ivan",
      name: "Ivan",
      cost_cents: 2_500_00,
      input_tokens: 600_000,
      output_tokens: 200_000,
    },
    {
      id: "usr_jane",
      name: "Jane",
      cost_cents: 1_500_00,
      input_tokens: 150_000,
      output_tokens: 50_000,
    },
  ]);
  dal.getEarliestActivity.mockReset().mockResolvedValue("2026-04-01");
  dal.getTeamActivityByDay.mockReset().mockResolvedValue([
    {
      bucket_day: "2026-05-01",
      active_members: 2,
      cost_cents: 4_000_00,
      input_tokens: 0,
      output_tokens: 0,
    },
    {
      bucket_day: "2026-05-02",
      active_members: 1,
      cost_cents: 1_000_00,
      input_tokens: 0,
      output_tokens: 0,
    },
  ]);
});

async function render(searchParams: Record<string, string> = {}) {
  const mod = await import("./page");
  return mod.default({ searchParams: Promise.resolve(searchParams) });
}

describe("dashboard/team /page", () => {
  it("smoke: renders Team headline, the merged cost-by-member card, and the headline stats", async () => {
    const node = await render();
    expect(node).toBeTruthy();
    const text = extractText(node);
    expect(text).toContain("Team");
    expect(text).toContain("Cost by Team Member");
    expect(text).toContain("Ivan");
    expect(text).toContain("Jane");
    // Headline tiles on the time-series cards (#131, #135). The values are
    // sourced from `getCostByUser` so they match Overview totals: 2 distinct
    // identifiable members, $4,000 total cost ⇒ $2,000 avg per person.
    expect(text).toContain("Active members");
    expect(text).toContain("Avg cost per person");
    expect(text).toContain("$2000.00");
  });

  it("smoke: tokens unit relabels the per-person headline to tokens", async () => {
    const node = await render({ units: "tokens" });
    const text = extractText(node);
    expect(text).toContain("Avg tokens per person");
    expect(text).not.toContain("Avg cost per person");
    // (600k+200k + 150k+50k) / 2 distinct members = 500,000 tokens/person,
    // which `fmtNum` collapses to "500.0K".
    expect(text).toContain("500.0K");
  });

  it("excludes the synthetic Unassigned bucket from the per-person math (#135)", async () => {
    dal.getCostByUser.mockResolvedValue([
      {
        id: "usr_ivan",
        name: "Ivan",
        cost_cents: 1_000_00,
        input_tokens: 0,
        output_tokens: 0,
      },
      {
        id: "__unassigned__",
        name: "Unassigned",
        cost_cents: 5_000_00,
        input_tokens: 0,
        output_tokens: 0,
      },
    ]);
    const node = await render();
    const text = extractText(node);
    // 1 identifiable member, $1,000 from that member ⇒ $1,000 avg per person.
    // The $5,000 in the Unassigned bucket must NOT inflate the numerator and
    // must NOT increase the active-members count.
    expect(text).toContain("$1000.00");
    expect(text).not.toContain("$3000.00");
  });

  it("empty: renders the chart's empty-state copy and the merged-card collapses to chart-only", async () => {
    dal.getCostByUser.mockResolvedValue([]);
    dal.getTeamActivityByDay.mockResolvedValue([]);
    const node = await render();
    expect(node).toBeTruthy();
    const text = extractText(node);
    expect(text).toContain("No team cost data for this period");
    // No identifiable members ⇒ both stats render the em-dash sentinel rather
    // than `NaN` or `0`.
    expect(text).toContain("—");
  });

  it("loading: composes a Suspense boundary around the filter cluster", async () => {
    const node = await render();
    expect(containsSuspense(node)).toBe(true);
  });

  it("error: a DAL fault propagates so the framework error boundary can render its fallback", async () => {
    dal.getCostByUser.mockRejectedValue(new Error("__DAL_BOOM__"));
    await expect(render()).rejects.toThrow("__DAL_BOOM__");
  });

  it("redirects members to /dashboard (ADR-0083 §6 — page is self-only for non-managers)", async () => {
    dal.getCurrentUser.mockResolvedValue({ ...MANAGER, role: "member" });
    await expect(render()).rejects.toThrow("__REDIRECT__:/dashboard");
    expect(redirectMock).toHaveBeenCalledWith("/dashboard");
  });

  it("returns null (no leak) when the viewer has no org_id yet", async () => {
    dal.getCurrentUser.mockResolvedValue({ ...MANAGER, org_id: null });
    const node = await render();
    expect(node).toBeNull();
  });
});
