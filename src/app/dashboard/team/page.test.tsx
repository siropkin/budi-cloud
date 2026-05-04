import { describe, it, expect, vi, beforeEach } from "vitest";
import { containsSuspense, extractText } from "@/test-utils/page-tree";

/**
 * Page-level coverage for `/dashboard/team` (#112).
 *
 * Defense-in-depth ladder is the moving part to lock down here:
 *   1. Smoke — manager view renders Team headline, chart card, and member table.
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
    { id: "usr_ivan", name: "Ivan", cost_cents: 2_500_00 },
    { id: "usr_jane", name: "Jane", cost_cents: 1_500_00 },
  ]);
  dal.getEarliestActivity.mockReset().mockResolvedValue("2026-04-01");
});

async function render(searchParams: Record<string, string> = {}) {
  const mod = await import("./page");
  return mod.default({ searchParams: Promise.resolve(searchParams) });
}

describe("dashboard/team /page", () => {
  it("smoke: renders Team headline, the cost chart, and the member table", async () => {
    const node = await render();
    expect(node).toBeTruthy();
    const text = extractText(node);
    expect(text).toContain("Team");
    expect(text).toContain("Cost by Team Member");
    expect(text).toContain("Team Members");
    expect(text).toContain("Ivan");
    expect(text).toContain("Jane");
  });

  it("empty: renders the chart's empty-state copy and skips the member table", async () => {
    dal.getCostByUser.mockResolvedValue([]);
    const node = await render();
    expect(node).toBeTruthy();
    const text = extractText(node);
    expect(text).toContain("No team cost data for this period");
    // Members table is gated on `userCosts.length > 0` — must not render here.
    expect(text).not.toContain("Team Members");
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
