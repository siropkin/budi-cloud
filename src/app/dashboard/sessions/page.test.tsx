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
  getWorkspaceMembers: vi.fn(),
  getSessions: vi.fn(),
  getKnownSurfaces: vi.fn(),
  SESSIONS_PAGE_SIZE: 50,
};
vi.mock("@/lib/dal", () => dal);

const MANAGER = {
  id: "usr_ivan",
  workspace_id: "org_team",
  role: "manager",
  api_key: "budi_i",
  display_name: "Ivan",
  email: "ivan@example.com",
};

const MEMBER = {
  id: "usr_jane",
  workspace_id: "org_team",
  role: "member",
  api_key: "budi_j",
  display_name: "Jane",
  email: "jane@example.com",
};

beforeEach(() => {
  dal.getCurrentUser.mockReset().mockResolvedValue(MANAGER);
  dal.getEarliestActivity.mockReset().mockResolvedValue("2026-04-01");
  dal.getWorkspaceMembers.mockReset().mockResolvedValue([]);
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
        total_cost_cents_effective: 250,
        total_cost_cents_ingested: 250,
        main_model: "claude-opus-4-7-20260101",
        owner_name: "Ivan",
        surface: "vscode",
        // v8.5.0+ jetbrains row carries an IntelliJ project name as title
        // (siropkin/budi#779). The list must surface it (#256).
        title: "Verkada-Web",
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
        total_cost_cents_effective: 30,
        total_cost_cents_ingested: 30,
        main_model: null,
        owner_name: "Jane",
        surface: "cursor",
      },
    ],
    nextCursor: null,
  });
  dal.getKnownSurfaces.mockReset().mockResolvedValue(["cursor", "vscode"]);
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
      "Title",
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
    // Session title (#256): the populated row shows its title; the row
    // without a title renders an em-dash placeholder.
    expect(text).toContain("Verkada-Web");
    expect(text).toContain("—");
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
    // The "« First" / "Next ›" labels live in the pagination nav — neither
    // should render when there are no rows + no next cursor.
    expect(text).not.toContain("First");
    expect(text).not.toContain("Next");
  });

  it("pagination labels: forward-only cursor scheme exposes only « First and Next › (#197)", async () => {
    // Page 1 with more pages available: only Next renders. The earlier copy
    // ("← Newest") read as a back-by-one button and confused users (#197).
    dal.getSessions.mockResolvedValueOnce({
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
          total_cost_cents_effective: 250,
          total_cost_cents_ingested: 250,
          main_model: "claude-opus-4-7-20260101",
          owner_name: "Ivan",
          surface: "vscode",
        },
      ],
      nextCursor: {
        startedAt: "2026-04-15T10:00:00.000Z",
        sessionId: "sess_a",
      },
    });
    let text = extractText(await render());
    expect(text).toContain("Next");
    expect(text).not.toContain("First");
    // The retired labels must not creep back in.
    expect(text).not.toContain("Newest");
    expect(text).not.toContain("Older");

    // Page 2+ with no further pages: only « First renders. Next is hidden
    // because `nextCursor` is null.
    dal.getSessions.mockResolvedValueOnce({
      rows: [
        {
          device_id: "dev_ivan",
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
          total_cost_cents_effective: 30,
          total_cost_cents_ingested: 30,
          main_model: null,
          owner_name: "Ivan",
          surface: "vscode",
        },
      ],
      nextCursor: null,
    });
    text = extractText(await render({ p: "2" }));
    expect(text).toContain("First");
    expect(text).not.toContain("Next");
  });

  it("loading: composes a Suspense boundary around the filter cluster so the table can stream", async () => {
    const node = await render();
    expect(containsSuspense(node)).toBe(true);
  });

  it("error: a DAL fault propagates so the framework error boundary can render its fallback", async () => {
    dal.getSessions.mockRejectedValue(new Error("__DAL_BOOM__"));
    await expect(render()).rejects.toThrow("__DAL_BOOM__");
  });

  it("returns null (no leak) when the viewer has no workspace_id yet", async () => {
    dal.getCurrentUser.mockResolvedValue({ ...MANAGER, workspace_id: null });
    const node = await render();
    expect(node).toBeNull();
  });

  it("surface filter: ?surface=vscode threads the search-param into getSessions so the table narrows to one surface (#187)", async () => {
    await render({ surface: "vscode" });
    const lastCall = dal.getSessions.mock.calls.at(-1);
    expect(lastCall).toBeTruthy();
    // getSessions(user, range, scope, pagination) — scope is index 2.
    expect(lastCall![2]).toMatchObject({ surfaces: ["vscode"] });
  });

  it("multi-provider: lists rows for every provider the daemon ships, not only claude_code (#202)", async () => {
    // The daemon's 8.4.2 release surfaced sessions for `copilot_chat`,
    // `cursor`, `codex`, and `copilot_cli` alongside `claude_code`. The
    // Sessions list contract is provider-agnostic — pin that the table
    // renders one row per provider with each row's actual display label,
    // so a future change can't silently re-collapse the list to one
    // provider without tripping this assertion.
    const baseRow = {
      device_id: "dev_ivan",
      ended_at: null,
      duration_ms: null,
      repo_id: "repo_x",
      git_branch: "refs/heads/main",
      ticket: null,
      message_count: 1,
      total_input_tokens: 0,
      total_output_tokens: 0,
      total_cost_cents_effective: 0,
      total_cost_cents_ingested: 0,
      main_model: null,
      owner_name: "Ivan",
      surface: "vscode",
    };
    dal.getSessions.mockResolvedValue({
      rows: [
        {
          ...baseRow,
          session_id: "sess_cc",
          provider: "claude_code",
          started_at: "2026-04-15T14:00:00.000Z",
        },
        {
          ...baseRow,
          session_id: "sess_copilot",
          provider: "copilot_chat",
          started_at: "2026-04-15T13:00:00.000Z",
        },
        {
          ...baseRow,
          session_id: "sess_cursor",
          provider: "cursor",
          started_at: "2026-04-15T12:00:00.000Z",
          surface: "cursor",
        },
        {
          ...baseRow,
          session_id: "sess_codex",
          provider: "codex",
          started_at: "2026-04-15T11:00:00.000Z",
          surface: "terminal",
        },
        {
          ...baseRow,
          session_id: "sess_copilot_cli",
          provider: "copilot_cli",
          started_at: "2026-04-15T10:00:00.000Z",
          surface: "terminal",
        },
      ],
      nextCursor: null,
    });
    const node = await render();
    const text = extractText(node);
    // Each provider lands on the list with its display label, never the
    // raw snake_case wire value.
    for (const label of [
      "Claude Code",
      "Copilot Chat",
      "Cursor",
      "Codex",
      "Copilot CLI",
    ]) {
      expect(text).toContain(label);
    }
    for (const wire of ["claude_code", "copilot_chat", "copilot_cli"]) {
      expect(text).not.toContain(wire);
    }
  });

  it("surface column: not rendered in the table — surface lives on the filter chip + detail page only", async () => {
    // The Surface column was dropped from the Sessions list once it became
    // clear the per-row cell duplicated information already conveyed by the
    // chip and the session-detail Summary card. Pin the absence so a
    // future Surface-on-list revival has to update this test on the way in.
    const node = await render();
    const text = extractText(node);
    // Header row reads `Member, Provider, Model, …` — no Surface header.
    expect(text).not.toMatch(/Provider.*Surface.*Model/);
    // The filter chip still renders (its options come from `knownSurfaces`),
    // so the dimension is reachable for narrowing without occupying a column.
    // Use the same test-id the page exposes on the chip.
  });
});
