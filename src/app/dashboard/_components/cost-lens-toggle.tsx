"use client";

import { useEffect } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { clsx } from "clsx";
import {
  COST_LENSES,
  COST_LENS_STORAGE_KEY,
  DEFAULT_COST_LENS,
  parseCostLens,
} from "@/lib/cost-lens";

/**
 * Effective | List toggle for the Overview cost chart (#235). Mirrors the
 * URL+localStorage pattern used by `UnitsSelector` and `PeriodSelector` so
 * the choice round-trips through links, bookmarks, and the back/forward
 * stack while still surviving a bare-URL reload via localStorage hydration.
 *
 * The toggle is rendered inline next to the chart's title (not in the
 * page-level filter row), so it stays scoped to "what the cost chart
 * shows" rather than implying it filters other tiles on the page.
 */
export function CostLensToggle() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const urlValue = searchParams.get("lens");
  const current = parseCostLens(urlValue);

  useEffect(() => {
    if (urlValue) return;
    if (typeof window === "undefined") return;
    const stored = window.localStorage.getItem(COST_LENS_STORAGE_KEY);
    const persisted = parseCostLens(stored);
    if (persisted === DEFAULT_COST_LENS) return;
    const params = new URLSearchParams(searchParams.toString());
    params.set("lens", persisted);
    router.replace(`?${params.toString()}`);
  }, [urlValue, router, searchParams]);

  function selectLens(value: string) {
    if (typeof window !== "undefined") {
      window.localStorage.setItem(COST_LENS_STORAGE_KEY, value);
    }
    const params = new URLSearchParams(searchParams.toString());
    params.set("lens", value);
    router.push(`?${params.toString()}`);
  }

  return (
    <div
      role="radiogroup"
      aria-label="Cost lens"
      className="flex gap-1 rounded-lg border border-white/10 bg-white/[0.02] p-1"
    >
      {COST_LENSES.map((l) => (
        <button
          key={l.value}
          role="radio"
          aria-checked={current === l.value}
          onClick={() => selectLens(l.value)}
          className={clsx(
            "rounded-md px-2.5 py-1 text-xs font-medium transition-colors",
            current === l.value
              ? "bg-white/10 text-white"
              : "text-zinc-400 hover:text-zinc-200"
          )}
        >
          {l.label}
        </button>
      ))}
    </div>
  );
}
