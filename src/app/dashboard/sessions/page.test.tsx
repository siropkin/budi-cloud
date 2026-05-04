import { describe, it, expect, vi, beforeEach } from "vitest";
import { containsSuspense, extractText } from "@/test-utils/page-tree";

/**
 * Page-level coverage for `/dashboard/sessions`.
 *
 * The sessions surface has been the busiest area of the codebase recently
 * (5 of the last 5 merged PRs touched it), and shipped without page-level
 * coverage. This pins the four contracts called out in #112:
 *   1. Smoke — populated session rows render the table headers + filter cluster.
 *   2. Empty — empty `rows` renders the "No sessions found" copy without
 *      throwing on the missing pagination range.
 *   3. Loading — `<Suspense>` wraps the filter cluster so the table can stream.
 *   4. Error — DAL faults propagate so the framework error boundary takes over.
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
  getEarliestActivity: vi.fn(),
  getOrgMembers: vi.fn(),
  getSessions: vi.fn(),
  SESSIONS_PAGE_SIZE: 50,
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
  dal.getCurrentUser.mockReset().mockResolvedValue(MANAGER);
  dal.getEarliestActivity.mockReset().mockResolvedValue("2026-04-01");
  dal.getOrgMembers.mockReset().mockResolvedValue([]);
  dal.getSessions.mockReset().mockResolvedValue({
    rows: [
      {
        device_id: "dev_ivan",
        session_id: "sess_a",
        provider: "claude_code",
        started_at: "2026-04-15T10:00:00.000Z",
        ended_at: "2026-04-15T11:00:00.000Z",
        duration_ms: 3_600_000,
        repo_id: "repo_x",
        git_branch: "refs/heads/main",
        ticket: null,
        message_count: 12,
        total_input_tokens: 2000,
        total_output_tokens: 800,
        total_cost_cents: 250,
      },
    ],
    nextCursor: null,
  });
});

async function render(searchParams: Record<string, string> = {}) {
  const mod = await import("./page");
  return mod.default({ searchParams: Promise.resolve(searchParams) });
}

describe("dashboard/sessions /page", () => {
  it("smoke: renders the table with headers + a session row when DAL returns rows", async () => {
    const node = await render();
    expect(node).toBeTruthy();
    const text = extractText(node);
    expect(text).toContain("Sessions");
    expect(text).toContain("Recent Sessions");
    // Lock down the column contract so a regression that drops one shows up.
    for (const col of [
      "Provider",
      "Started",
      "Duration",
      "Repo",
      "Branch",
      "Messages",
      "Tokens",
      "Cost",
    ]) {
      expect(text).toContain(col);
    }
  });

  it("empty: renders the 'No sessions' empty-state copy and skips pagination chrome", async () => {
    dal.getSessions.mockResolvedValue({ rows: [], nextCursor: null });
    const node = await render();
    expect(node).toBeTruthy();
    const text = extractText(node);
    expect(text).toContain("No sessions found");
    // The "← Newest" / "Older →" labels live in the pagination nav — neither
    // should render when there are no rows + no next cursor.
    expect(text).not.toContain("Newest");
    expect(text).not.toContain("Older");
  });

  it("loading: composes a Suspense boundary around the filter cluster so the table can stream", async () => {
    const node = await render();
    expect(containsSuspense(node)).toBe(true);
  });

  it("error: a DAL fault propagates so the framework error boundary can render its fallback", async () => {
    dal.getSessions.mockRejectedValue(new Error("__DAL_BOOM__"));
    await expect(render()).rejects.toThrow("__DAL_BOOM__");
  });

  it("returns null (no leak) when the viewer has no org_id yet", async () => {
    dal.getCurrentUser.mockResolvedValue({ ...MANAGER, org_id: null });
    const node = await render();
    expect(node).toBeNull();
  });
});
