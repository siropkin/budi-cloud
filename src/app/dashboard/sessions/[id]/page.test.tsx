import { describe, it, expect, vi, beforeEach } from "vitest";
import { extractText } from "@/test-utils/page-tree";

/**
 * Page-level coverage for `/dashboard/sessions/[id]` (#99 + #112).
 *
 * Locks in:
 *   1. Smoke — populated `getSessionDetail` renders the back link, vitals
 *      card, and summary fields.
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
  vital_context_drag_state: "yellow" as const,
  vital_context_drag_metric: 18.2,
  vital_cache_efficiency_state: "green" as const,
  vital_cache_efficiency_metric: 87,
  vital_thrashing_state: "red" as const,
  vital_thrashing_metric: 0.95,
  vital_cost_acceleration_state: "yellow" as const,
  vital_cost_acceleration_metric: 42,
  vital_overall_state: "red" as const,
};

beforeEach(() => {
  notFoundMock.mockClear();
  dal.getCurrentUser.mockReset().mockResolvedValue(MANAGER);
  dal.getSessionDetail.mockReset().mockResolvedValue(SESSION);
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
  it("smoke: renders the back link, Session Vitals card, and Summary fields", async () => {
    const node = await render();
    expect(node).toBeTruthy();
    const text = extractText(node);
    expect(text).toContain("← Sessions");
    expect(text).toContain("Session Vitals");
    expect(text).toContain("Summary");
    // Lock down the summary field labels so a refactor that drops one shows up.
    for (const label of [
      "Provider",
      "Started",
      "Duration",
      "Repo",
      "Branch",
      "Messages",
      "Tokens",
      "Cost",
    ]) {
      expect(text).toContain(label);
    }
  });

  it("empty: 404s when the `device` query param is missing — composite PK can't be resolved", async () => {
    await expect(render("sess_v", {})).rejects.toThrow("__NOT_FOUND__");
    expect(notFoundMock).toHaveBeenCalled();
    // Must not have called the DAL at all — bail before any visibility probe
    // so we don't leak existence of a session via timing/error shape.
    expect(dal.getSessionDetail).not.toHaveBeenCalled();
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
});
