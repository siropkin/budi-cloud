"use client";

import { useRouter, useSearchParams } from "next/navigation";

import { formatSurface, parseSurfaceParam } from "@/lib/surface";

const ALL_SURFACE_VALUE = "";
const ALL_SURFACE_LABEL = "All surfaces";

/**
 * Header chip that scopes the rest of the dashboard to a single surface
 * (#187). Mirrors `<UserFilter />` and `<PeriodSelector />`: lifts the URL
 * into the source of truth so the breakdown queries can read it on the
 * server without prop drilling.
 *
 * The DAL filter accepts a CSV (`?surface=vscode,cursor`) so future
 * multi-select UIs can ship without a wire-shape change. For v1 the chip
 * surfaces a single-select dropdown.
 *
 * Hidden only when `surfaces` is empty — i.e. the org has no rollups yet,
 * so a dropdown that would only offer "All surfaces" carries zero signal.
 * Once any surface is known (even just `unknown` from pre-bump daemons)
 * the chip renders so the dimension is discoverable: #203 explicitly asks
 * the filter to land alongside Teammate / time-range / $/Tokens
 * regardless of the number of distinct surfaces in the data.
 */
export function SurfaceFilter({ surfaces }: { surfaces: string[] }) {
  const router = useRouter();
  const searchParams = useSearchParams();

  if (surfaces.length === 0) return null;

  const raw = searchParams.get("surface");
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
