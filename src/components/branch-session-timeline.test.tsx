import { describe, it, expect } from "vitest";
import type { ReactElement } from "react";
import { BranchSessionTimeline } from "@/components/branch-session-timeline";
import { type BranchSessionTimelineRow } from "@/lib/dal";

/**
 * Unit tests for the same-branch-over-time bar chart (#216).
 *
 * Pins the three acceptance behaviors:
 *   1. Timeline renders 1+ bars when there are other sessions on the branch.
 *   2. The current session's bar is visually marked.
 *   3. Empty-state copy renders when this is the only session on the branch.
 */

interface CapturedBar {
  sessionId: string;
  isCurrent: boolean;
}

function collectBars(node: unknown): CapturedBar[] {
  const out: CapturedBar[] = [];
  const seen = new WeakSet<object>();
  function walk(n: unknown): void {
    if (!n || typeof n !== "object") return;
    if (Array.isArray(n)) {
      for (const c of n) walk(c);
      return;
    }
    if (seen.has(n as object)) return;
    seen.add(n as object);
    const el = n as ReactElement & {
      props?: Record<string, unknown> & { children?: unknown };
    };
    const props = el.props as Record<string, unknown> | undefined;
    if (props && props["data-session-id"] != null) {
      out.push({
        sessionId: String(props["data-session-id"]),
        isCurrent:
          (props as { "data-current"?: string })["data-current"] === "true",
      });
    }
    walk(el.props?.children);
  }
  walk(node);
  return out;
}

function findByTestId(node: unknown, testId: string): unknown | null {
  const seen = new WeakSet<object>();
  function walk(n: unknown): unknown | null {
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
    const el = n as ReactElement & {
      props?: Record<string, unknown> & { children?: unknown };
    };
    if (el.props && el.props["data-testid"] === testId) return el;
    return walk(el.props?.children);
  }
  return walk(node);
}

function textOf(node: unknown): string {
  const parts: string[] = [];
  function walk(n: unknown): void {
    if (n == null || typeof n === "boolean") return;
    if (typeof n === "string" || typeof n === "number") {
      parts.push(String(n));
      return;
    }
    if (Array.isArray(n)) {
      for (const c of n) walk(c);
      return;
    }
    if (typeof n === "object") {
      const el = n as ReactElement & { props?: { children?: unknown } };
      walk(el.props?.children);
    }
  }
  walk(node);
  return parts.join("");
}

function mkSession(
  overrides: Partial<BranchSessionTimelineRow> & { session_id: string }
): BranchSessionTimelineRow {
  return {
    started_at: "2026-05-01T10:00:00.000Z",
    total_cost_cents: 50,
    total_input_tokens: 1000,
    total_output_tokens: 500,
    ...overrides,
  };
}

const rangeStart = "2026-04-11T00:00:00.000Z";
const rangeEnd = "2026-05-11T23:59:59.999Z";

describe("BranchSessionTimeline (#216)", () => {
  it("renders one bar per session and marks the current session's bar", () => {
    const sessions = [
      mkSession({ session_id: "sess_a", started_at: "2026-04-15T12:00:00Z" }),
      mkSession({ session_id: "sess_b", started_at: "2026-04-22T12:00:00Z" }),
      mkSession({ session_id: "sess_c", started_at: "2026-05-01T12:00:00Z" }),
    ];
    const node = BranchSessionTimeline({
      sessions,
      currentSessionId: "sess_b",
      rangeStartIso: rangeStart,
      rangeEndIso: rangeEnd,
      unit: "dollars",
    });
    const bars = collectBars(node);
    expect(bars).toHaveLength(3);
    const current = bars.filter((b) => b.isCurrent);
    expect(current).toHaveLength(1);
    expect(current[0]!.sessionId).toBe("sess_b");
  });

  it("renders empty-state copy when this is the only session on the branch", () => {
    const node = BranchSessionTimeline({
      sessions: [mkSession({ session_id: "sess_only" })],
      currentSessionId: "sess_only",
      rangeStartIso: rangeStart,
      rangeEndIso: rangeEnd,
      unit: "dollars",
    });
    const empty = findByTestId(node, "branch-session-timeline-empty");
    expect(empty).not.toBeNull();
    expect(textOf(empty)).toMatch(
      /only session on this branch in the last 30 days/i
    );
    // And critically, no bars are rendered alongside the empty-state copy
    // (a 0-bar chart would read as a broken UI).
    expect(findByTestId(node, "branch-session-timeline-bars")).toBeNull();
  });

  it("renders the bar lane when other sessions exist alongside the current one", () => {
    const sessions = [
      mkSession({ session_id: "sess_a", started_at: "2026-04-15T12:00:00Z" }),
      mkSession({ session_id: "sess_current" }),
    ];
    const node = BranchSessionTimeline({
      sessions,
      currentSessionId: "sess_current",
      rangeStartIso: rangeStart,
      rangeEndIso: rangeEnd,
      unit: "dollars",
    });
    expect(findByTestId(node, "branch-session-timeline-bars")).not.toBeNull();
    expect(findByTestId(node, "branch-session-timeline-empty")).toBeNull();
  });

  it("renders nothing when the session has no branch context (sessions=[])", () => {
    // Page-side guard: when the session is missing a (repo_id, git_branch)
    // pair, the DAL is skipped and we pass `[]` — the component must collapse
    // to null rather than render an "only session" message that would be
    // misleading.
    const node = BranchSessionTimeline({
      sessions: [],
      currentSessionId: "sess_x",
      rangeStartIso: rangeStart,
      rangeEndIso: rangeEnd,
      unit: "dollars",
    });
    expect(node).toBeNull();
  });
});
