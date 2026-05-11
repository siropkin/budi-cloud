import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { fmtCost } from "@/lib/format";
import {
  type SessionCostDistribution,
  sessionCostBucketIndex,
} from "@/lib/session-cost-distribution";

/**
 * Cost-percentile distribution strip on the session-detail page (#217).
 *
 * Renders a horizontal bank of bars — one per log-spaced cost bucket from
 * `$0.01` to the period max — with the bar containing the current session's
 * `total_cost_cents` highlighted. A label above the strip ("This session is in
 * the top X%" / "bottom X%") collapses the empirical CDF down to a single
 * number so a viewer answers "is this session abnormally expensive?" at a
 * glance, without mentally diffing against the team's typical session.
 *
 * Empty-state contract (#217 acceptance): the strip hides entirely when the
 * team has fewer than 10 sessions in the period — the percentile is
 * statistically meaningless on a tiny sample and the bar bank would mostly
 * read as noise.
 *
 * Privacy (ADR-0083 §1): only numeric session metadata reaches this
 * component. No prompt / response / file path content is rendered.
 */

/** Sample size below which the percentile call-out is suppressed (#217). */
export const SESSION_COST_DISTRIBUTION_MIN_SAMPLES = 10;

export function SessionCostDistributionStrip({
  distribution,
  currentCostCents,
}: {
  distribution: SessionCostDistribution;
  currentCostCents: number;
}) {
  if (distribution.total_sessions < SESSION_COST_DISTRIBUTION_MIN_SAMPLES) {
    return null;
  }
  if (distribution.buckets.length === 0) return null;

  const currentIdx = sessionCostBucketIndex(
    distribution.buckets,
    currentCostCents
  );
  const label = percentileLabel(
    distribution.buckets,
    distribution.total_sessions,
    currentIdx
  );

  const maxBucketCount = Math.max(
    1,
    ...distribution.buckets.map((b) => b.count)
  );

  return (
    <Card>
      <CardHeader>
        <CardTitle>Cost vs team</CardTitle>
      </CardHeader>
      <CardContent>
        <div
          className="mb-2 text-sm text-zinc-200"
          data-testid="session-cost-percentile-label"
        >
          {label}
        </div>
        <div
          className="flex h-12 w-full items-end gap-[2px] rounded-md bg-white/[0.03] p-1"
          role="list"
          aria-label="Session cost distribution across the team"
          data-testid="session-cost-distribution-bars"
        >
          {distribution.buckets.map((bucket, i) => {
            const isCurrent = i === currentIdx;
            const heightPct =
              bucket.count === 0
                ? 4
                : Math.max(8, (bucket.count / maxBucketCount) * 100);
            const tooltip = `${fmtCost(bucket.lower_cents)}–${fmtCost(
              bucket.upper_cents
            )} · ${bucket.count} session${bucket.count === 1 ? "" : "s"}`;
            return (
              <div
                key={i}
                role="listitem"
                title={tooltip}
                aria-label={tooltip}
                aria-current={isCurrent ? "true" : undefined}
                data-current={isCurrent ? "true" : undefined}
                data-bucket-index={i}
                className={
                  "flex-1 rounded-sm transition-opacity " +
                  (isCurrent ? "bg-amber-300" : "bg-blue-500/70")
                }
                style={{ height: `${heightPct}%` }}
              />
            );
          })}
        </div>
        <div
          className="mt-1 flex justify-between text-[10px] text-zinc-500"
          aria-hidden="true"
        >
          <span>{fmtCost(distribution.buckets[0]!.lower_cents)}</span>
          <span>
            {fmtCost(
              distribution.buckets[distribution.buckets.length - 1]!.upper_cents
            )}
          </span>
        </div>
      </CardContent>
    </Card>
  );
}

/**
 * Build the "top X%" / "bottom X%" call-out. Uses a midpoint rank within the
 * current bucket — the histogram is bucket-level so we don't know the exact
 * intra-bucket position; midpoint is the unbiased estimator. Clamps the
 * rendered percent to `[1, 99]` so "top 0%" / "bottom 0%" can never read as a
 * formatting glitch.
 */
function percentileLabel(
  buckets: { count: number }[],
  totalSessions: number,
  currentIdx: number
): string {
  if (currentIdx < 0 || totalSessions <= 0) {
    return "This session is in the team distribution.";
  }
  let cumBelow = 0;
  for (let i = 0; i < currentIdx; i++) cumBelow += buckets[i]!.count;
  const currCount = buckets[currentIdx]!.count;
  const rank = cumBelow + currCount / 2;
  const cdf = rank / totalSessions;
  const topPct = Math.round((1 - cdf) * 100);
  if (topPct <= 50) {
    return `This session is in the top ${clampPct(topPct)}% by cost.`;
  }
  const bottomPct = Math.round(cdf * 100);
  return `This session is in the bottom ${clampPct(bottomPct)}% by cost.`;
}

function clampPct(p: number): number {
  if (!Number.isFinite(p)) return 50;
  return Math.min(99, Math.max(1, p));
}
