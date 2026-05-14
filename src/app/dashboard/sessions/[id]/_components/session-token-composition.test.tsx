import { describe, it, expect } from "vitest";
import type { ReactElement } from "react";
import { SessionTokenComposition } from "@/app/dashboard/sessions/[id]/_components/session-token-composition";

/**
 * Unit tests for the per-session input-vs-output bar (#215). Pins the three
 * acceptance behaviors:
 *   1. Normal session — both segments render with widths proportional to the
 *      input/output split.
 *   2. Output-only session — the bar collapses to a single full-width Output
 *      segment annotated `(output-only)` (matches the May-2026+ Copilot Chat
 *      shape from ADR-0092 §2.3 v3).
 *   3. Empty session — both halves zero → the component returns null rather
 *      than emitting a 0-width bar that reads as a broken UI element.
 */

interface CapturedSegment {
  segment: string;
  widthPct: number;
  title: string;
}

function collectSegments(node: unknown): CapturedSegment[] {
  const out: CapturedSegment[] = [];
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
    if (props && typeof props["data-segment"] === "string") {
      const style = (props.style as { width?: string } | undefined) ?? {};
      const widthPct = Number(String(style.width ?? "0%").replace("%", ""));
      out.push({
        segment: String(props["data-segment"]),
        widthPct,
        title: String((props as { title?: string }).title ?? ""),
      });
    }
    walk(el.props?.children);
  }
  walk(node);
  return out;
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

describe("SessionTokenComposition (#215)", () => {
  it("renders both segments for a normal mixed-token session with proportional widths and per-segment tooltips", () => {
    // 75% input / 25% output — values picked so rounding is unambiguous and
    // the percent labels in the tooltips read 75% / 25% exactly.
    const node = SessionTokenComposition({
      inputTokens: 3000,
      outputTokens: 1000,
    });
    const segs = collectSegments(node);
    expect(segs.map((s) => s.segment).sort()).toEqual(["input", "output"]);
    const input = segs.find((s) => s.segment === "input")!;
    const output = segs.find((s) => s.segment === "output")!;
    expect(input.widthPct).toBeCloseTo(75, 5);
    expect(output.widthPct).toBeCloseTo(25, 5);
    // The hover-tooltip contract from the ticket: absolute count and percent
    // on each segment so the breakdown is readable without external math.
    expect(input.title).toMatch(/Input:/);
    expect(input.title).toContain("75%");
    expect(output.title).toMatch(/Output:/);
    expect(output.title).toContain("25%");
    // The bar should not carry the output-only suffix when input > 0.
    expect(output.title).not.toContain("output-only");
    expect(textOf(node)).not.toContain("output-only");
  });

  it("collapses to a single full-width Output segment for output-only sessions and reuses the `(output-only)` annotation", () => {
    // May-2026+ VS Code Copilot Chat shape — input lost on disk so the
    // daemon's output-only fallback ships input_tokens=0, output_tokens>0.
    // The bar must surface that state, not silently render a 100% Output
    // segment indistinguishable from "the viewer scrolled past the input".
    const node = SessionTokenComposition({
      inputTokens: 0,
      outputTokens: 1500,
    });
    const segs = collectSegments(node);
    expect(segs).toHaveLength(1);
    expect(segs[0]!.segment).toBe("output");
    expect(segs[0]!.widthPct).toBeCloseTo(100, 5);
    expect(segs[0]!.title).toContain("output-only");
    // The visible legend reuses the same annotation the Tokens field uses
    // on the parent page so the two reads agree.
    expect(textOf(node)).toContain("output-only");
  });

  it("hides entirely when both halves are zero (no 0-width bar)", () => {
    // The acceptance criterion forbids emitting a 0-width bar — an empty
    // session must read as "no chart", not "broken chart". Returning null
    // is the contract the page relies on so the Activity card doesn't
    // grow a hairline strip on empty rows.
    const node = SessionTokenComposition({ inputTokens: 0, outputTokens: 0 });
    expect(node).toBeNull();
  });

  it("renders only the input segment when the session has input tokens but no output (defensive — rare but possible for aborted sessions)", () => {
    // An aborted run can land with prompt tokens recorded but no model
    // response — pin that the bar still renders rather than collapsing back
    // to the empty-state null. Symmetric with the output-only case.
    const node = SessionTokenComposition({
      inputTokens: 500,
      outputTokens: 0,
    });
    const segs = collectSegments(node);
    expect(segs).toHaveLength(1);
    expect(segs[0]!.segment).toBe("input");
    expect(segs[0]!.widthPct).toBeCloseTo(100, 5);
    // Output-only annotation is *not* applied when output is the zero side —
    // the daemon's output-only contract is specifically input=0/output>0.
    expect(textOf(node)).not.toContain("output-only");
  });
});
