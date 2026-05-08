import { createAdminClient } from "@/lib/supabase/admin";

/**
 * Per-key / per-IP rate limiting (#179).
 *
 * The four public route handlers under `src/app/api/` accept unbounded
 * request rates by default — Vercel applies a platform-level cap, but
 * nothing route-specific. A leaked API key, a misbehaving daemon under a
 * legitimate key, or a compromised dashboard session can flood any of them
 * with no backoff signal.
 *
 * This module wraps the `check_rate_limit` Postgres RPC (migration 016) in
 * a small TS helper. Every call is one RPC round-trip; the table schema is
 * a fixed-window counter — see the migration for the trade-off rationale.
 *
 * Keys are scoped per-route to keep one chatty endpoint from starving
 * another (`ingest:<key>` vs `whoami:<key>`). The helper does not infer the
 * route — callers pass a stable namespace explicitly so a future split
 * (e.g. ingest-status growing its own thresholds) doesn't quietly inherit
 * an unrelated bucket.
 *
 * On the dashboard's `/api/freshness` path we don't have an API key, so the
 * caller passes the Supabase user id (already authenticated by the route)
 * as the bucket identifier. On all four routes the bucket key is server-
 * trusted: no part of it comes from a header an attacker controls.
 */

export type RateLimitConfig = {
  /** Stable per-route namespace, e.g. "ingest", "ingest_status". */
  namespace: string;
  /**
   * Server-trusted identifier for the caller — API key, user id, etc.
   * Never an arbitrary header value. Empty / missing identifiers are
   * rejected by `enforceRateLimit`; the caller would otherwise be sharing
   * a single global bucket with every other unauthenticated request.
   */
  identifier: string;
  /** Maximum requests permitted per window. */
  limit: number;
  /** Window length in seconds. */
  windowSeconds: number;
};

export type RateLimitResult = {
  /** Whether the increment kept the bucket within `limit`. */
  allowed: boolean;
  /** `limit` minus post-increment count, clamped at 0. */
  remaining: number;
  /** When the current window rolls over and the bucket resets. */
  resetAt: Date;
  /** Echo of `limit` for response-header convenience. */
  limit: number;
};

/**
 * Standard rate-limit thresholds. First-pass values from #179 — tune in
 * the route handler if a real-world abuse pattern shows up.
 *
 * These match the table in the issue verbatim so a future reader can grep
 * either side. Don't relax them silently; document the reason in the route
 * if you do.
 */
export const RATE_LIMITS = {
  ingest: { limit: 60, windowSeconds: 60 },
  ingest_status: { limit: 30, windowSeconds: 60 },
  whoami: { limit: 20, windowSeconds: 60 },
  freshness: { limit: 60, windowSeconds: 60 },
} as const;

/**
 * Increment the rate-limit counter for `namespace:identifier` and return
 * the post-increment status.
 *
 * Returns an `allowed: true` result on RPC failure (fail-open). Rationale:
 * a transient DB hiccup must not block legitimate ingest under a
 * defense-in-depth layer. The platform cap remains as a backstop.
 */
export async function checkRateLimit(
  cfg: RateLimitConfig
): Promise<RateLimitResult> {
  const supabase = createAdminClient();
  const bucketKey = `${cfg.namespace}:${cfg.identifier}`;

  const { data, error } = await supabase.rpc("check_rate_limit", {
    p_bucket_key: bucketKey,
    p_limit: cfg.limit,
    p_window_seconds: cfg.windowSeconds,
  });

  if (error || !data) {
    // Fail open — see rationale above.
    console.error("rate-limit RPC failed; failing open:", error);
    return {
      allowed: true,
      remaining: cfg.limit,
      resetAt: new Date(Date.now() + cfg.windowSeconds * 1000),
      limit: cfg.limit,
    };
  }

  const row = Array.isArray(data) ? data[0] : data;
  return {
    allowed: Boolean(row?.allowed),
    remaining: Number(row?.remaining ?? 0),
    resetAt: row?.reset_at ? new Date(row.reset_at) : new Date(),
    limit: cfg.limit,
  };
}

/**
 * Apply rate-limit headers to a successful response so callers can
 * self-pace before they hit a 429.
 */
export function withRateLimitHeaders<T extends Response>(
  res: T,
  result: RateLimitResult
): T {
  res.headers.set("X-RateLimit-Limit", String(result.limit));
  res.headers.set("X-RateLimit-Remaining", String(result.remaining));
  res.headers.set(
    "X-RateLimit-Reset",
    String(Math.floor(result.resetAt.getTime() / 1000))
  );
  return res;
}

/**
 * Convenience wrapper: returns a 429 `Response` if blocked, or `null` to
 * let the caller continue. The caller is expected to apply
 * `withRateLimitHeaders` to its successful response when this returns
 * `null` so the 429 path and 200 path share the same accounting headers.
 */
export async function enforceRateLimit(
  cfg: RateLimitConfig
): Promise<{ blocked: Response | null; result: RateLimitResult }> {
  if (!cfg.identifier) {
    // Should never happen — calling with an empty identifier is a bug at
    // the route layer (auth must have run first). 401 the caller rather
    // than collapsing every anonymous request into one shared bucket.
    return {
      blocked: Response.json({ error: "Unauthorized" }, { status: 401 }),
      result: {
        allowed: false,
        remaining: 0,
        resetAt: new Date(),
        limit: cfg.limit,
      },
    };
  }

  const result = await checkRateLimit(cfg);
  if (result.allowed) return { blocked: null, result };

  const retryAfterSeconds = Math.max(
    1,
    Math.ceil((result.resetAt.getTime() - Date.now()) / 1000)
  );
  const blocked = Response.json(
    { error: "Rate limit exceeded" },
    {
      status: 429,
      headers: {
        "Retry-After": String(retryAfterSeconds),
        "X-RateLimit-Limit": String(result.limit),
        "X-RateLimit-Remaining": "0",
        "X-RateLimit-Reset": String(
          Math.floor(result.resetAt.getTime() / 1000)
        ),
      },
    }
  );
  return { blocked, result };
}
