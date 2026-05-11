/**
 * Shared types + pure helpers for the session cost-percentile distribution
 * strip (#217). Lives in its own module — separate from `@/lib/dal` — because
 * the strip component renders on the client/page boundary and `dal.ts` is
 * marked `server-only`. Importing the histogram-building math from a neutral
 * module keeps the strip free of an accidental server-only barrier.
 */

/** One bin in the cost-distribution histogram. */
export interface SessionCostBucket {
  /** Inclusive lower edge in cents. */
  lower_cents: number;
  /** Exclusive upper edge in cents (the top bucket treats it as inclusive). */
  upper_cents: number;
  /** Number of sessions in this bucket. */
  count: number;
}

export interface SessionCostDistribution {
  buckets: SessionCostBucket[];
  /** Total sessions in the period — drives the < 10 empty state. */
  total_sessions: number;
  /** Period max in cents; useful for axis labels on the consumer. */
  max_cost_cents: number;
}

/** Number of log-spaced bins used by `getSessionCostDistribution`. */
export const SESSION_COST_BUCKET_COUNT = 20;
/** Lower edge of the first bucket: $0.01. */
export const SESSION_COST_MIN_CENTS = 1;

/**
 * Build a fixed bank of log-spaced buckets between `$0.01` and `maxCostCents`.
 *
 * Returns an empty array when the period's max cost is below the first
 * bucket's lower edge — the consumer should then render the empty state.
 */
export function buildSessionCostBuckets(
  maxCostCents: number,
  bucketCount: number = SESSION_COST_BUCKET_COUNT
): SessionCostBucket[] {
  if (
    !Number.isFinite(maxCostCents) ||
    maxCostCents < SESSION_COST_MIN_CENTS ||
    bucketCount < 1
  ) {
    return [];
  }
  // `+1` so the row at exactly `maxCostCents` lands inside the top bin rather
  // than at the boundary (where exp/log floating-point drift can drop it).
  const logMin = Math.log(SESSION_COST_MIN_CENTS);
  const logMax = Math.log(maxCostCents + 1);
  const step = (logMax - logMin) / bucketCount;
  const buckets: SessionCostBucket[] = [];
  for (let i = 0; i < bucketCount; i++) {
    buckets.push({
      lower_cents: Math.exp(logMin + i * step),
      upper_cents: Math.exp(logMin + (i + 1) * step),
      count: 0,
    });
  }
  return buckets;
}

/**
 * Resolve which bucket index a given cost lands in. Costs below the first
 * lower edge clamp into bucket 0 (the "near-zero" bin); costs above the top
 * edge clamp into the last bucket. Returns `-1` when there are no buckets.
 */
export function sessionCostBucketIndex(
  buckets: SessionCostBucket[],
  costCents: number
): number {
  if (buckets.length === 0) return -1;
  const c = Number(costCents);
  if (!Number.isFinite(c) || c <= buckets[0]!.lower_cents) return 0;
  for (let i = 0; i < buckets.length; i++) {
    if (c < buckets[i]!.upper_cents) return i;
  }
  return buckets.length - 1;
}
