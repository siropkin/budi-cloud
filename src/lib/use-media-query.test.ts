import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * #282: smoke test the `useMediaQuery` wiring without pulling in a DOM
 * environment. The hook is small enough that mocking React's `useState` /
 * `useEffect` exercises the contract that matters:
 *
 *   - it subscribes to `window.matchMedia(query)` once per query
 *   - it pushes the initial `mql.matches` value through the setter
 *   - it registers (and cleans up) a `change` listener
 *
 * Vitest runs in the `node` environment per `vitest.config.ts`, so we
 * synthesize a `window.matchMedia` and mock `react` rather than installing
 * `jsdom` / `happy-dom` for one hook.
 */

const setStateCalls: unknown[] = [];
const effectCleanups: Array<() => void> = [];

vi.mock("react", () => ({
  useState<T>(initial: T) {
    return [initial, (v: unknown) => setStateCalls.push(v)] as const;
  },
  useEffect(fn: () => void | (() => void)) {
    const cleanup = fn();
    if (typeof cleanup === "function") effectCleanups.push(cleanup);
  },
}));

type Listener = () => void;

function installMatchMedia(matches: boolean) {
  const listeners: Listener[] = [];
  const mql = {
    matches,
    addEventListener: vi.fn((_evt: string, cb: Listener) => listeners.push(cb)),
    removeEventListener: vi.fn((_evt: string, cb: Listener) => {
      const i = listeners.indexOf(cb);
      if (i >= 0) listeners.splice(i, 1);
    }),
  };
  const matchMedia = vi.fn((query: string) => {
    void query;
    return mql;
  });
  // The hook touches `window.matchMedia`. We attach to globalThis so the
  // import-time `"use client"` directive is the only thing standing between
  // this node-env test and the real browser API.
  (
    globalThis as unknown as { window: { matchMedia: typeof matchMedia } }
  ).window = { matchMedia };
  return { mql, matchMedia, listeners };
}

beforeEach(() => {
  setStateCalls.length = 0;
  effectCleanups.length = 0;
});

describe("useMediaQuery", () => {
  it("queries matchMedia with the provided string and pushes the initial value", async () => {
    const { matchMedia, mql } = installMatchMedia(true);
    const { useMediaQuery } = await import("./use-media-query");

    const initial = useMediaQuery("(min-width: 768px)");

    // First render is SSR-safe — returns `false` until the effect runs.
    expect(initial).toBe(false);
    expect(matchMedia).toHaveBeenCalledWith("(min-width: 768px)");
    // The effect pushed the real value through the setter.
    expect(setStateCalls).toContain(true);
    expect(mql.addEventListener).toHaveBeenCalledWith(
      "change",
      expect.any(Function)
    );
  });

  it("re-syncs when the media query starts unmatched", async () => {
    const { matchMedia } = installMatchMedia(false);
    const { useMediaQuery } = await import("./use-media-query");

    useMediaQuery("(max-width: 480px)");

    expect(matchMedia).toHaveBeenCalledWith("(max-width: 480px)");
    expect(setStateCalls).toContain(false);
  });

  it("returns a cleanup that removes the change listener", async () => {
    const { mql } = installMatchMedia(true);
    const { useMediaQuery } = await import("./use-media-query");

    useMediaQuery("(prefers-reduced-motion: reduce)");

    expect(effectCleanups).toHaveLength(1);
    effectCleanups[0]!();
    expect(mql.removeEventListener).toHaveBeenCalledWith(
      "change",
      expect.any(Function)
    );
  });
});
