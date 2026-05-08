"use client";

import { useRouter, useSearchParams } from "next/navigation";

const ALL_SURFACE_VALUE = "";
const ALL_SURFACE_LABEL = "All surfaces";

/**
 * Parse the URL-shaped `?surface=` value into the canonical CSV list. Mirrors
 * the wire shape from siropkin/budi#702: `?surface=vscode,cursor` →
 * `["vscode", "cursor"]`. Empty / missing → `[]` (the all-surfaces default).
 *
 * Exported so server-side page code can use the same parser without dragging
 * the `"use client"` chip into a server component.
 */
export function parseSurfaceParam(raw: string | null | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/**
 * Header chip that scopes the rest of the dashboard to a single surface
 * (#187). Mirrors `<UserFilter />` and `<PeriodSelector />`: lifts the URL
 * into the source of truth so the breakdown queries can read it on the
 * server without prop drilling.
 *
 * The DAL filter accepts a CSV (`?surface=vscode,cursor`) so future
 * multi-select UIs can ship without a wire-shape change. For v1 the chip
 * surfaces a single-select dropdown — that covers the "filter to one
 * surface" use case and matches the existing `<UserFilter />` ergonomics; a
 * multi-select expansion is a follow-up if the data tells us users want it.
 *
 * Hidden when `surfaces` has 0 or 1 entries — a chip that can only filter
 * to "everything" or "the only thing" adds noise. Once a second surface
 * appears in the org's data the chip starts rendering automatically.
 */
export function SurfaceFilter({ surfaces }: { surfaces: string[] }) {
  const router = useRouter();
  const searchParams = useSearchParams();

  if (surfaces.length < 2) return null;

  const raw = searchParams.get("surface");
  // The CSV may carry multiple ids from a future multi-select UI; for the v1
  // single-select chip we display the first match and treat anything else as
  // "All surfaces" so the dropdown's selection stays in sync with the URL.
  const parsed = parseSurfaceParam(raw);
  const current =
    parsed.length === 1 && surfaces.includes(parsed[0])
      ? parsed[0]
      : ALL_SURFACE_VALUE;

  function selectSurface(value: string) {
    const params = new URLSearchParams(searchParams.toString());
    if (value === ALL_SURFACE_VALUE) {
      params.delete("surface");
    } else {
      params.set("surface", value);
    }
    const qs = params.toString();
    router.push(qs ? `?${qs}` : "?");
  }

  return (
    <label
      className="flex items-center gap-2 text-sm"
      data-testid="surface-filter"
    >
      <span className="sr-only">Filter by surface</span>
      <select
        value={current}
        onChange={(e) => selectSurface(e.target.value)}
        className="rounded-lg border border-white/10 bg-white/[0.02] px-3 py-2.5 text-sm font-medium text-zinc-200 transition-colors hover:bg-white/[0.04] focus:outline-none focus:ring-1 focus:ring-white/20"
      >
        <option value={ALL_SURFACE_VALUE}>{ALL_SURFACE_LABEL}</option>
        {surfaces.map((s) => (
          <option key={s} value={s}>
            {formatSurface(s)}
          </option>
        ))}
      </select>
    </label>
  );
}

/**
 * Friendly display label for a surface id. Matches what the daemon sends on
 * the wire (`vscode`, `jetbrains`, …) but title-cased for the chip. Falls
 * back to the raw id for surfaces we don't have a hand-tuned label for so
 * a never-before-seen surface still renders rather than a blank entry.
 */
export function formatSurface(surface: string | null | undefined): string {
  // Tolerate the null/undefined seam: pre-#187 daemons didn't emit a surface
  // and every other code path that consumes a session/rollup has its own
  // null-fallback. Centralizing the coalesce here means callers never have
  // to remember to coerce before passing through (and matches the
  // dashboard's "missing surface displays as Unknown" rule).
  if (!surface) return "Unknown";
  switch (surface) {
    case "vscode":
      return "VS Code";
    case "cursor":
      return "Cursor";
    case "jetbrains":
      return "JetBrains";
    case "terminal":
      return "Terminal";
    case "unknown":
      return "Unknown";
    default:
      return surface.charAt(0).toUpperCase() + surface.slice(1);
  }
}
