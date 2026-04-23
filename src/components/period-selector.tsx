"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { clsx } from "clsx";
import {
  DEFAULT_PERIOD_DAYS,
  PERIODS,
  formatPeriodCaption,
} from "@/lib/periods";

export function PeriodSelector() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const current = searchParams.get("days") ?? String(DEFAULT_PERIOD_DAYS);

  function selectPeriod(days: string) {
    const params = new URLSearchParams(searchParams.toString());
    params.set("days", days);
    router.push(`?${params.toString()}`);
  }

  return (
    <div className="flex items-center gap-3">
      <span
        className="hidden text-xs text-zinc-400 sm:inline"
        data-testid="period-caption"
      >
        {formatPeriodCaption(current)}
      </span>
      <div className="flex gap-1 rounded-lg border border-white/10 bg-white/[0.02] p-1">
        {PERIODS.map((p) => (
          <button
            key={p.value}
            onClick={() => selectPeriod(p.value)}
            className={clsx(
              "rounded-md px-3 py-1.5 text-sm font-medium transition-colors",
              current === p.value
                ? "bg-white/10 text-white"
                : "text-zinc-400 hover:text-zinc-200"
            )}
          >
            {p.label}
          </button>
        ))}
      </div>
    </div>
  );
}
