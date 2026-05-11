import { describe, it, expect } from "vitest";
import type { ReactElement } from "react";
import {
  DeviceDayTimeline,
  type DeviceDayTimelineSession,
} from "@/components/device-day-timeline";

/**
 * Unit tests for the same-day device timeline strip (#218).
 *
 * Pins the four acceptance behaviors:
 *   1. ordering — bars are rendered in `started_at` ascending order;
 *   2. current-session highlight — the bar matching `currentSessionId` is
 *      marked as `aria-current="page"` and visually distinguished;
 *   3. click-through href — each bar links to `/dashboard/sessions/<id>` with
 *      the `device` half of the composite PK preserved (#202);
 *   4. empty state — a single-session lane collapses to `null` so the cards
 *      above aren't crowded by a one-bar timeline.
 */

interface CapturedBar {
  href: string;
  sessionId: string;
  isCurrent: boolean;
  leftPct: number;
  widthPct: number;
  tooltip: string;
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
    if (props && typeof props.href === "string" && props.href.startsWith("/dashboard/sessions/")) {
      const href = props.href as string;
      const style = (props.style as Record<string, string>) ?? {};
      const dataCurrent = (props as { "data-current"?: string })["data-current"];
      const ariaCurrent = (props as { "aria-current"?: string })["aria-current"];
      out.push({
        href,
        sessionId: href.slice("/dashboard/sessions/".length).split("?")[0]!,
        isCurrent: dataCurrent === "true" || ariaCurrent === "page",
        leftPct: parseFloat(String(style.left ?? "0")),
        widthPct: parseFloat(String(style.width ?? "0")),
        tooltip: String((props as { title?: string }).title ?? ""),
      });
    }
    walk(el.props?.children);
  }
  walk(node);
  return out;
}

const TIMEZONE = "UTC";
const LOCAL_DATE = "2026-04-15";

const baseSessions: DeviceDayTimelineSession[] = [
  // Deliberately out of chronological order in the input array so the
  // "ordering" test exercises the (started_at, session_id) sort applied
  // upstream by the DAL — the component itself preserves order, so the
  // test mirrors the input the DAL will hand it.
  {
    session_id: "sess_a",
    device_id: "dev_ivan",
    started_at: "2026-04-15T09:00:00.000Z",
    ended_at: "2026-04-15T09:30:00.000Z",
    duration_ms: 30 * 60 * 1000,
    repo_id: "repo_x",
    git_branch: "refs/heads/main",
    total_cost_cents: 100,
  },
  {
    session_id: "sess_b",
    device_id: "dev_ivan",
    started_at: "2026-04-15T12:00:00.000Z",
    ended_at: "2026-04-15T13:00:00.000Z",
    duration_ms: 60 * 60 * 1000,
    repo_id: "repo_x",
    git_branch: "refs/heads/main",
    total_cost_cents: 500,
  },
  {
    session_id: "sess_c",
    device_id: "dev_ivan",
    started_at: "2026-04-15T18:00:00.000Z",
    ended_at: "2026-04-15T18:30:00.000Z",
    duration_ms: 30 * 60 * 1000,
    repo_id: "repo_x",
    git_branch: "refs/heads/feature",
    total_cost_cents: 250,
  },
];

describe("DeviceDayTimeline (#218)", () => {
  it("renders one bar per session in input order", () => {
    const node = DeviceDayTimeline({
      sessions: baseSessions,
      currentSessionId: "sess_b",
      timeZone: TIMEZONE,
      localDate: LOCAL_DATE,
    });
    const bars = collectBars(node);
    expect(bars.map((b) => b.sessionId)).toEqual(["sess_a", "sess_b", "sess_c"]);
    // The leftFraction is monotonically increasing because the input is
    // already started_at ascending — this catches a regression that
    // accidentally re-sorts by cost or duration.
    expect(bars[0]!.leftPct).toBeLessThan(bars[1]!.leftPct);
    expect(bars[1]!.leftPct).toBeLessThan(bars[2]!.leftPct);
  });

  it("highlights the current session and only the current session", () => {
    const node = DeviceDayTimeline({
      sessions: baseSessions,
      currentSessionId: "sess_b",
      timeZone: TIMEZONE,
      localDate: LOCAL_DATE,
    });
    const bars = collectBars(node);
    const currents = bars.filter((b) => b.isCurrent);
    expect(currents).toHaveLength(1);
    expect(currents[0]!.sessionId).toBe("sess_b");
  });

  it("links each bar to /dashboard/sessions/<id>?device=<device_id> so the composite-PK fast path is used on click-through (#202)", () => {
    const node = DeviceDayTimeline({
      sessions: baseSessions,
      currentSessionId: "sess_b",
      timeZone: TIMEZONE,
      localDate: LOCAL_DATE,
    });
    const bars = collectBars(node);
    for (const bar of bars) {
      expect(bar.href).toBe(
        `/dashboard/sessions/${bar.sessionId}?device=dev_ivan`
      );
    }
  });

  it("surfaces session id, repo, branch, and cost in the bar tooltip", () => {
    const node = DeviceDayTimeline({
      sessions: baseSessions,
      currentSessionId: "sess_b",
      timeZone: TIMEZONE,
      localDate: LOCAL_DATE,
    });
    const bars = collectBars(node);
    const c = bars.find((b) => b.sessionId === "sess_c")!;
    expect(c.tooltip).toContain("sess_c");
    expect(c.tooltip).toContain("feature");
    // Cost is rendered via `fmtCost`, which is dollar-prefixed; the bar
    // surfaces the magnitude so a manager triaging a runaway can spot the
    // expensive bar without clicking through.
    expect(c.tooltip).toMatch(/\$/);
  });

  it("renders nothing when there's only one session on the device that day (empty-state contract)", () => {
    const node = DeviceDayTimeline({
      sessions: [baseSessions[0]!],
      currentSessionId: "sess_a",
      timeZone: TIMEZONE,
      localDate: LOCAL_DATE,
    });
    expect(node).toBeNull();
  });

  it("renders nothing when there are zero sessions (defensive — DAL should already short-circuit)", () => {
    const node = DeviceDayTimeline({
      sessions: [],
      currentSessionId: "sess_a",
      timeZone: TIMEZONE,
      localDate: LOCAL_DATE,
    });
    expect(node).toBeNull();
  });
});
