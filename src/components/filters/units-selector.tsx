"use client";

import { useEffect } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { clsx } from "clsx";
import { DEFAULT_UNIT, UNITS, UNITS_STORAGE_KEY, parseUnit } from "@/lib/units";

/**
 * Display-unit toggle for the dashboard (#128). Mirrors the URL-driven shape
 * of `PeriodSelector` (`?units=tokens|dollars`) so the choice round-trips
 * through links, bookmarks, and the back/forward stack.
 *
 * On mount, if the URL has no `?units=` param, we hydrate the URL from the
 * last value in `localStorage` (using `router.replace` so the navigation
 * stack doesn't grow). That makes the choice survive reloads even when the
 * user lands on a bare `/dashboard/...` link, while still keeping
 * server-rendered output a pure function of the URL.
 */
export function UnitsSelector() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const urlValue = searchParams.get("units");
  const current = parseUnit(urlValue);

  useEffect(() => {
    if (urlValue) return;
    if (typeof window === "undefined") return;
    const stored = window.localStorage.getItem(UNITS_STORAGE_KEY);
    const persisted = parseUnit(stored);
    if (persisted === DEFAULT_UNIT) return;
    const params = new URLSearchParams(searchParams.toString());
    params.set("units", persisted);
    router.replace(`?${params.toString()}`);
    // We deliberately depend on `urlValue` so this only fires while the URL
    // is missing the param — once it's set (either by us or by a click) the
    // effect short-circuits on the very first line.
  }, [urlValue, router, searchParams]);

  function selectUnit(value: string) {
    if (typeof window !== "undefined") {
      window.localStorage.setItem(UNITS_STORAGE_KEY, value);
    }
    const params = new URLSearchParams(searchParams.toString());
    params.set("units", value);
    router.push(`?${params.toString()}`);
  }

  return (
    <div
      role="radiogroup"
      aria-label="Display units"
      className="flex gap-1 rounded-lg border border-white/10 bg-white/[0.02] p-1"
    >
      {UNITS.map((u) => (
        <button
          key={u.value}
          role="radio"
          aria-checked={current === u.value}
          onClick={() => selectUnit(u.value)}
          className={clsx(
            "rounded-md px-3 py-1.5 text-sm font-medium transition-colors",
            current === u.value
              ? "bg-white/10 text-white"
              : "text-zinc-400 hover:text-zinc-200"
          )}
        >
          {u.label}
        </button>
      ))}
    </div>
  );
}
