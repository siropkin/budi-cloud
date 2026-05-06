import Link from "next/link";
import { Card } from "@/components/ui/card";

/**
 * Mini "leader card" for the Overview top-breakdowns row (#150 slice 2).
 *
 * Each card answers a single "who/what dominates this period?" question — top
 * model, top contributor, top repo — and links to the page where the full
 * breakdown lives. The sparkline reuses the period's daily totals so we don't
 * issue a second per-leader query just to render a six-pixel decoration.
 */
export function TopBreakdownCard({
  title,
  name,
  sharePct,
  sparkline,
  href,
  emptyLabel = "No data",
}: {
  title: string;
  /** Leader display name; `null` when the period has no data. */
  name: string | null;
  sharePct: number | null;
  /** Period daily totals, ascending. Empty array hides the sparkline. */
  sparkline: number[];
  href: string;
  emptyLabel?: string;
}) {
  const isEmpty = name === null;
  return (
    <Link
      href={href}
      className="block transition hover:bg-white/[0.04] rounded-xl"
    >
      <Card className="h-full">
        <p className="text-sm font-medium text-zinc-400">{title}</p>
        {isEmpty ? (
          <p className="mt-2 text-2xl font-semibold text-zinc-500">
            {emptyLabel}
          </p>
        ) : (
          <>
            <p
              className="mt-2 truncate text-2xl font-semibold text-white"
              title={name}
            >
              {name}
            </p>
            <div className="mt-1 flex items-end justify-between gap-3">
              <p className="text-sm text-zinc-500">
                {sharePct !== null ? `${sharePct.toFixed(1)}% of period` : ""}
              </p>
              {sparkline.length >= 2 && <Sparkline values={sparkline} />}
            </div>
          </>
        )}
      </Card>
    </Link>
  );
}

/**
 * Inline SVG sparkline. Stays self-contained so the card doesn't pull in
 * recharts for what is effectively a single polyline — recharts already
 * renders the full-width Daily Activity chart on the same page.
 */
function Sparkline({ values }: { values: number[] }) {
  const width = 80;
  const height = 24;
  const max = Math.max(...values);
  const min = Math.min(...values);
  const range = max - min || 1;
  const stepX = values.length > 1 ? width / (values.length - 1) : 0;
  const points = values
    .map((v, i) => {
      const x = i * stepX;
      const y = height - ((v - min) / range) * height;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");
  return (
    <svg
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      className="shrink-0"
      aria-hidden
    >
      <polyline
        points={points}
        fill="none"
        stroke="#3b82f6"
        strokeWidth={1.5}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
