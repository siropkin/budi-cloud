import { describe, it, expect, vi, beforeEach } from "vitest";
import { extractText } from "@/test-utils/page-tree";

/**
 * Page-level coverage for `/dashboard/sessions/[id]` (#99 + #112).
 *
 * Locks in:
 *   1. Smoke — populated `getSessionDetail` renders the back link and
 *      summary fields. The Session Vitals card was removed in #141 because
 *      the daemon never emitted vitals to the cloud; this test no longer
 *      asserts that surface.
 *   2. Empty — a missing `device` query param 404s rather than silently
 *      guessing (the composite PK requires both halves).
 *   3. Loading — there's no Suspense on this page; instead we pin the
 *      back-link round-trip contract that survives the loading→detail→back
 *      navigation (#101).
 *   4. Error — DAL faults propagate so the framework error boundary fires.
 */

vi.mock("server-only", () => ({}));
const notFoundMock = vi.fn(() => {
  throw new Error("__NOT_FOUND__");
});
vi.mock("next/navigation", () => ({
  redirect: (to: string) => {
    throw new Error(`__REDIRECT__:${to}`);
  },
  notFound: () => notFoundMock(),
}));

const dal = {
  getCurrentUser: vi.fn(),
  getSessionDetail: vi.fn(),
  getSessionDetailBySessionId: vi.fn(),
  getDeviceSessionsForDay: vi.fn(),
  getEarliestActivity: vi.fn(),
  getSessionCostDistribution: vi.fn(),
};
// The strip component imports `sessionCostBucketIndex` directly from
// `@/lib/dal`; spread the real exports so that helper resolves while the
// async DAL entry points stay mockable per-test.
vi.mock("@/lib/dal", async () => {
  const actual = await vi.importActual<typeof import("@/lib/dal")>("@/lib/dal");
  return {
    ...actual,
    getCurrentUser: dal.getCurrentUser,
    getSessionDetail: dal.getSessionDetail,
    getSessionDetailBySessionId: dal.getSessionDetailBySessionId,
    getDeviceSessionsForDay: dal.getDeviceSessionsForDay,
    getEarliestActivity: dal.getEarliestActivity,
    getSessionCostDistribution: dal.getSessionCostDistribution,
  };
});
vi.mock("@/lib/viewer-timezone", () => ({
  getViewerTimeZone: async () => "UTC",
}));

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

const SESSION = {
  device_id: "dev_ivan",
  session_id: "sess_v",
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
  owner_name: "Jane Smith",
  surface: "vscode",
};

beforeEach(() => {
  notFoundMock.mockClear();
  dal.getCurrentUser.mockReset().mockResolvedValue(MANAGER);
  dal.getSessionDetail.mockReset().mockResolvedValue(SESSION);
  dal.getSessionDetailBySessionId.mockReset().mockResolvedValue(SESSION);
  // Default: single-session day so the timeline is hidden in baseline
  // smoke tests. Suites that exercise the timeline override per-case.
  dal.getDeviceSessionsForDay.mockReset().mockResolvedValue([SESSION]);
  dal.getEarliestActivity.mockReset().mockResolvedValue(null);
  // Default: empty cost distribution so the cost-vs-team strip is hidden in
  // baseline smoke tests (matches the < 10 sessions empty state from #217).
  dal.getSessionCostDistribution.mockReset().mockResolvedValue({
    buckets: [],
    total_sessions: 0,
    max_cost_cents: 0,
  });
});

async function render(
  id: string = "sess_v",
  searchParams: Record<string, string> = { device: "dev_ivan" }
) {
  const mod = await import("./page");
  return mod.default({
    params: Promise.resolve({ id }),
    searchParams: Promise.resolve(searchParams),
  });
}

/**
 * Walk the rendered tree for the cost-distribution strip element and pull its
 * props out. The strip is a function component, so its body never executes
 * inside the page-test pipeline — we capture the props the page handed it
 * (distribution + current cost) and verify the wiring without poking at the
 * strip's rendered output. Render-side coverage lives in the strip's own
 * test file (`session-cost-distribution-strip.test.tsx`).
 */
function findStripProps(node: unknown): {
  distribution: unknown;
  currentCostCents: unknown;
} | null {
  const seen = new WeakSet<object>();
  function walk(n: unknown): {
    distribution: unknown;
    currentCostCents: unknown;
  } | null {
    if (!n || typeof n !== "object") return null;
    if (Array.isArray(n)) {
      for (const c of n) {
        const f = walk(c);
        if (f) return f;
      }
      return null;
    }
    if (seen.has(n as object)) return null;
    seen.add(n as object);
    const el = n as {
      type?: unknown;
      props?: {
        children?: unknown;
        distribution?: unknown;
        currentCostCents?: unknown;
      };
    };
    const t = el.type as { name?: string } | undefined;
    if (
      t &&
      typeof t === "function" &&
      (t as { name?: string }).name === "SessionCostDistributionStrip"
    ) {
      return {
        distribution: el.props?.distribution,
        currentCostCents: el.props?.currentCostCents,
      };
    }
    return walk(el.props?.children);
  }
  return walk(node);
}

/**
 * The back link is rendered as a Next `<Link>` whose `href` is a prop, not a
 * child — so it doesn't show up in `extractText`. Walk the tree to pluck the
 * Sessions back-link href explicitly.
 */
function findSessionsBackHref(node: unknown): string | null {
  const seen = new WeakSet<object>();
  function walk(n: unknown): string | null {
    if (!n || typeof n !== "object") return null;
    if (seen.has(n as object)) return null;
    seen.add(n as object);
    if (Array.isArray(n)) {
      for (const c of n) {
        const found = walk(c);
        if (found) return found;
      }
      return null;
    }
    const el = n as {
      props?: { href?: string; children?: unknown };
    };
    const href = el.props?.href;
    if (
      typeof href === "string" &&
      (href === "/dashboard/sessions" ||
        href.startsWith("/dashboard/sessions?"))
    ) {
      return href;
    }
    return walk(el.props?.children);
  }
  return walk(node);
}

describe("dashboard/sessions/[id] /page", () => {
  it("smoke: renders the back link and the two-section detail (Context + Activity), with no Session Vitals card (#141)", async () => {
    const node = await render();
    expect(node).toBeTruthy();
    const text = extractText(node);
    expect(text).toContain("← Sessions");
    // The single Summary card was split into Context (who/what/where) +
    // Activity (when/how-much) so each thread reads in one place. Pin both
    // section titles so a refactor that drops a section is loud.
    expect(text).toContain("Context");
    expect(text).toContain("Activity");
    // The vitals card was removed in #141 because the daemon never sent the
    // numbers to populate it. Pin its absence here so a future revert that
    // brings the empty card back is loud rather than silent.
    expect(text).not.toContain("Session Vitals");
    expect(text).not.toContain("Vitals unavailable");
    // Lock down every detail-field label so a refactor that drops one shows up.
    for (const label of [
      "Member",
      "Provider",
      "Surface",
      "Model",
      "Repo",
      "Branch",
      "Started",
      "Duration",
      "Messages",
      "Tokens",
      "Cost",
    ]) {
      expect(text).toContain(label);
    }
    // Manager-attribution (#138): the resolved owner label renders in the
    // Context section so a manager can tell whose session this is without
    // pivoting back to the device list.
    expect(text).toContain("Jane Smith");
    // The date suffix on the model id is render-only noise (`-20260101`);
    // formatModelName strips it. Pin both halves so a regression that drops
    // the formatter or shows the raw id is caught here (#140).
    expect(text).toContain("claude-opus-4-7");
    expect(text).not.toContain("claude-opus-4-7-20260101");
  });

  it("hides the Member field for non-manager (member) viewers (#138)", async () => {
    // Members only see their own sessions, so attribution would be a constant
    // restating their own name. Suppress it to keep the card focused.
    dal.getCurrentUser.mockResolvedValue(MEMBER);
    const node = await render();
    const text = extractText(node);
    expect(text).not.toContain("Member");
    // The rest of the detail surface still renders.
    expect(text).toContain("Provider");
    expect(text).toContain("Context");
    expect(text).toContain("Activity");
  });

  it("renders a dash for the Model field when the daemon didn't send one (#140)", async () => {
    // Older daemons (< 8.3.16) never emit `primary_model`, so `main_model`
    // lands NULL. The detail page must render a placeholder rather than
    // collapse the field — pair the field's null-handling with the list.
    dal.getSessionDetail.mockResolvedValue({ ...SESSION, main_model: null });
    const node = await render();
    const text = extractText(node);
    expect(text).toContain("Model");
    expect(text).not.toContain("claude-opus-4-7");
  });

  it("groups detail fields so each section's pair on a row reads as a phrase (#137, #140, #203 follow-up)", async () => {
    // The page splits into two sections; each is a 2-col grid that renders
    // fields in document order. Pin the order so the pair groupings a
    // viewer reads as a single phrase don't silently drift:
    //   Context:
    //     Row 1: Member   / Provider  (manager attribution + tool)
    //     Row 2: Surface  / Model     (where it ran + which model)
    //     Row 3: Repo     / Branch    (where in the codebase)
    //   Activity:
    //     Row 1: Started  / Duration  (when, how long)
    //     Row 2: Messages / Tokens    (volume)
    //     Row 3: Cost                 (the dollar takeaway)
    const node = await render();
    const text = extractText(node);
    const order = [
      "Context",
      "Member",
      "Provider",
      "Surface",
      "Model",
      "Repo",
      "Branch",
      "Activity",
      "Started",
      "Duration",
      "Messages",
      "Tokens",
      "Cost",
    ];
    const positions = order.map((label) => text.indexOf(label));
    expect(positions.every((p) => p !== -1)).toBe(true);
    for (let i = 1; i < positions.length; i++) {
      expect(positions[i]).toBeGreaterThan(positions[i - 1]!);
    }
  });

  it("renders the session via session_id-only lookup when `?device=` is missing (#202 deep-link)", async () => {
    // Deep-linked session URLs pasted from chat / a ticket typically lack
    // the `?device=` half of the composite PK. The page must still resolve
    // the row by walking the viewer's visible devices, so a manager
    // forwarding a session URL to a teammate doesn't dead-end on a 404.
    const node = await render("sess_v", {});
    const text = extractText(node);
    expect(text).toContain("Context");
    expect(text).toContain("Activity");
    expect(dal.getSessionDetailBySessionId).toHaveBeenCalledWith(
      MANAGER,
      "sess_v"
    );
    // The composite-PK fast path is only used when `?device=` is provided —
    // skipping it here keeps the deep-link path off the device-scoped query.
    expect(dal.getSessionDetail).not.toHaveBeenCalled();
  });

  it("404s on deep-link when the session_id resolves to nothing in the viewer's scope (#202)", async () => {
    // A session that doesn't exist OR isn't visible to the viewer collapses
    // into the same not-found shape so the URL parameter can't be used to
    // probe foreign-org session existence (ADR-0083 §6).
    dal.getSessionDetailBySessionId.mockResolvedValue(null);
    await expect(render("sess_v", {})).rejects.toThrow("__NOT_FOUND__");
    expect(notFoundMock).toHaveBeenCalled();
  });

  it("empty: 404s for a session not visible to the viewer (DAL returns null)", async () => {
    // Per ADR-0083 §6: a foreign-org session collapses with not-found rather
    // than leaking existence. The page-level contract for that is `notFound()`.
    dal.getSessionDetail.mockResolvedValue(null);
    await expect(render()).rejects.toThrow("__NOT_FOUND__");
    expect(notFoundMock).toHaveBeenCalled();
  });

  it("loading: round-trips list-page filters onto the back link so loading→detail→back preserves state", async () => {
    // The page has no Suspense of its own — instead, the load-aware contract
    // is that filters survive the round-trip (#101). Pin it here since this
    // is the loading-state behavior users actually see.
    const node = await render("sess_v", {
      device: "dev_ivan",
      days: "7",
      user: "usr_jane",
      cursor: "abc",
      p: "2",
    });
    const href = findSessionsBackHref(node);
    expect(href).not.toBeNull();
    expect(href).toContain("days=7");
    expect(href).toContain("user=usr_jane");
    expect(href).toContain("cursor=abc");
    expect(href).toContain("p=2");
  });

  it("error: a DAL fault propagates so the framework error boundary can render its fallback", async () => {
    dal.getSessionDetail.mockRejectedValue(new Error("__DAL_BOOM__"));
    await expect(render()).rejects.toThrow("__DAL_BOOM__");
  });

  it("returns null (no leak) when the viewer has no org_id yet", async () => {
    dal.getCurrentUser.mockResolvedValue({ ...MANAGER, org_id: null });
    const node = await render();
    expect(node).toBeNull();
  });

  it("renders the canonical provider key as a display label so users never see the snake_case wire value (#168)", async () => {
    // Copilot Chat lands on the dashboard via 8.4 (siropkin/budi#665) without a
    // schema change — the polish ticket is making the raw `copilot_chat`
    // render as "Copilot Chat" wherever the field is read.
    dal.getSessionDetail.mockResolvedValue({
      ...SESSION,
      provider: "copilot_chat",
    });
    const node = await render();
    const text = extractText(node);
    expect(text).toContain("Copilot Chat");
    expect(text).not.toContain("copilot_chat");
  });

  it("queries the cost distribution and feeds it into the strip with the current session's cost (#217)", async () => {
    // The strip itself owns the render-side contract (see its own tests).
    // At the page level we pin the wiring: the DAL is called with the
    // viewer's user, and the strip element receives the current session's
    // `total_cost_cents` so the highlighted bucket can resolve correctly.
    const distribution = {
      buckets: Array.from({ length: 20 }, (_, i) => ({
        lower_cents: i * 100,
        upper_cents: (i + 1) * 100,
        count: i === 5 ? 8 : 1,
      })),
      total_sessions: 27,
      max_cost_cents: 2000,
    };
    dal.getSessionCostDistribution.mockResolvedValue(distribution);
    const node = await render();
    expect(dal.getSessionCostDistribution).toHaveBeenCalledTimes(1);
    expect(dal.getSessionCostDistribution).toHaveBeenCalledWith(
      MANAGER,
      expect.objectContaining({ from: expect.any(String) })
    );
    const stripProps = findStripProps(node);
    expect(stripProps).not.toBeNull();
    expect(stripProps!.distribution).toBe(distribution);
    expect(stripProps!.currentCostCents).toBe(250);
  });

  it("round-trips `?days=` from the URL into the cost-distribution range (#217)", async () => {
    // When the viewer arrived from a filtered Sessions list (?days=7), the
    // percentile must be computed against the same window so the call-out
    // doesn't disagree with what the list page showed.
    await render("sess_v", { device: "dev_ivan", days: "7" });
    const range = dal.getSessionCostDistribution.mock.calls[0]?.[1] as {
      from: string;
      to: string;
    };
    // 7-day rolling window: from = to - 7 days.
    const fromMs = new Date(`${range.from}T00:00:00Z`).getTime();
    const toMs = new Date(`${range.to}T00:00:00Z`).getTime();
    expect((toMs - fromMs) / 86_400_000).toBe(7);
  });

  it("annotates output-only sessions so a `0` input-token count reads as a known May-2026+ Copilot Chat state, not missing data (#168)", async () => {
    // ADR-0092 §2.3 v3: VS Code Copilot Chat builds drop prompt-token counts
    // on disk from May 2026 onward. The daemon's output-only fallback emits
    // rows with `input_tokens = 0` and a non-zero `output_tokens`. The detail
    // page tags those so the breakdown isn't ambiguous with "we lost the data".
    dal.getSessionDetail.mockResolvedValue({
      ...SESSION,
      provider: "copilot_chat",
      total_input_tokens: 0,
      total_output_tokens: 1500,
    });
    const node = await render();
    const text = extractText(node);
    expect(text).toContain("output-only");
  });
});
