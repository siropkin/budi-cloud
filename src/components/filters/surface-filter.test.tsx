import { describe, it, expect, vi } from "vitest";

/**
 * Unit tests for the Surface filter chip's empty-state guards (#227).
 *
 * The chip is a `"use client"` component that pulls the URL via
 * `useRouter` / `useSearchParams`. The hooks fire before the visibility
 * guard, so we mock `next/navigation` to a no-op router with an empty
 * query string. That keeps the test focused on the *guard contract* —
 * does the chip render, or does it return `null`? — without pulling
 * in `@testing-library/react`, which the repo doesn't depend on.
 */

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: () => {} }),
  useSearchParams: () => new URLSearchParams(""),
}));

import { SurfaceFilter } from "@/components/filters/surface-filter";

describe("SurfaceFilter empty-state guards (#227)", () => {
  it("renders nothing when `surfaces` is empty (no rollups visible to viewer)", () => {
    // Pre-existing contract from #187: an empty surface list means the workspace
    // hasn't shipped any usage yet, so the dropdown has no signal to offer.
    expect(SurfaceFilter({ surfaces: [] })).toBeNull();
  });

  it("renders nothing when the only known surface is `unknown` (today's deployments)", () => {
    // Acceptance: orgs whose only surface is the migration-014 default
    // `unknown` should not see the chip — the dropdown would otherwise read
    // as "All surfaces / Unknown", which carries zero filtering signal but
    // still steals header real estate next to Teammate / Period / Units.
    expect(SurfaceFilter({ surfaces: ["unknown"] })).toBeNull();
  });

  it("renders the chip once a real surface joins `unknown`", () => {
    // Acceptance: the day the first daemon ships a real `surface` value,
    // the chip reappears so viewers can scope the dashboard to it. The
    // guard must trip *only* on the single-`unknown` case, not on any list
    // that happens to contain `unknown`.
    const node = SurfaceFilter({ surfaces: ["unknown", "vscode"] });
    expect(node).not.toBeNull();
  });

  it("renders the chip for a single non-`unknown` surface", () => {
    // Symmetric defense: a list of length 1 only collapses to `null` for
    // the literal `'unknown'` string. Any other single surface (e.g. an
    // org that has only ever talked to one daemon) is a valid filter.
    const node = SurfaceFilter({ surfaces: ["vscode"] });
    expect(node).not.toBeNull();
  });
});
