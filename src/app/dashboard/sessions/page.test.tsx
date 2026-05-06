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

const MEMBER = {
  id: "usr_jane",
  org_id: "org_team",
  role: "member",
  api_key: "budi_j",
  display_name: "Jane",
  email: "jane@example.com",
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
        main_model: "claude-opus-4-7-20260101",
        owner_name: "Ivan",
      },
      {
        // Older daemon (#140): no main_model on the wire, column NULL in the
        // DB. Pin the dash-rendering branch so a regression that crashes on
        // null shows up here.
        device_id: "dev_jane",
        session_id: "sess_b",
        provider: "claude_code",
        started_at: "2026-04-15T09:00:00.000Z",
        ended_at: "2026-04-15T09:30:00.000Z",
        duration_ms: 1_800_000,
        repo_id: "repo_x",
        git_branch: "refs/heads/main",
        ticket: null,
        message_count: 4,
        total_input_tokens: 200,
        total_output_tokens: 80,
        total_cost_cents: 30,
        main_model: null,
        owner_name: "Jane",
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
    // The trailing "Cost" column is unit-aware (#128): under the default
    // dollars view it reads `Cost`; with `?units=tokens` it flips to
    // `Tokens`. The standalone Tokens column was retired in #128 because
    // the unit toggle on the cost column conveys the same signal.
    for (const col of [
      "Member",
      "Provider",
      "Model",
      "Started",
      "Duration",
      "Repo",
      "Branch",
      "Messages",
      "Cost",
    ]) {
      expect(text).toContain(col);
    }
    // New-daemon row renders the model; old-daemon row's NULL can't drop the
    // row from the page (#140). The full id including the date suffix is
    // also exposed via the cell's `title` so a hover tooltip surfaces it
    // when the truncated label hides the suffix — that's why we don't pin
    // the suffix's absence here.
    expect(text).toContain("claude-opus-4-7");
    // Manager attribution (#138): each row reads as "<member> ran <provider>".
    expect(text).toContain("Ivan");
    expect(text).toContain("Jane");
  });

  it("hides the Member column for non-manager (member) viewers (#138)", async () => {
    // Members only ever see their own rows, so the column would just repeat
    // their own name on every line. Suppress it to keep the table tight.
    dal.getCurrentUser.mockResolvedValue(MEMBER);
    const node = await render();
    const text = extractText(node);
    expect(text).not.toContain("Member");
    // Other column headers must still render — the suppression is scoped.
    expect(text).toContain("Provider");
    expect(text).toContain("Started");
  });

  it("units toggle: ?units=tokens flips the Cost column header to Tokens (#128)", async () => {
    const node = await render({ units: "tokens" });
    const text = extractText(node);
    // Header now reads `Tokens`; the per-row dollar value is replaced with
    // the input+output token sum.
    expect(text).toContain("Tokens");
    expect(text).not.toContain("$");
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
