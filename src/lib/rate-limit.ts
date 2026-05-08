import { createHash } from "node:crypto";
import { type NextRequest } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";

/**
 * Per-route rate-limit configuration. Thresholds match the first-pass table
 * from issue #179; tune by editing the route's `RATE_LIMIT` constant rather
 * than threading new args through `rateLimit()` so the limit lives next to
 * the handler that enforces it.
 */
export type RateLimitConfig = {
  /** Max requests permitted in the window. */
  limit: number;
  /** Window length in seconds. */
  windowSeconds: number;
};

export type RateLimitResult = {
  /** True if the caller is under the limit. */
  success: boolean;
  /** Seconds until the window rolls over. Stamped into `Retry-After`. */
  retryAfterSeconds: number;
};

/**
 * Atomically increment the counter for `bucket` and return whether the caller
 * is still under the configured limit. Backed by `rate_limit_check` (migration
 * 017): a single UPSERT keeps the read-and-increment atomic across instances.
 *
 * Fail-open: if the RPC fails (network, schema drift, etc.) the request is
 * allowed through and the error is logged. Rate limiting is defense in depth
 * — auth, payload caps, schema validation, and per-org device caps all still
 * apply — so a brief limiter outage should not pause every daemon in the
 * fleet via 429 → ADR-0083 §7 backoff.
 */
export async function rateLimit(
  bucket: string,
  config: RateLimitConfig
): Promise<RateLimitResult> {
  const supabase = createAdminClient();
  const { data, error } = await supabase.rpc("rate_limit_check", {
    p_bucket: bucket,
    p_limit: config.limit,
    p_window_seconds: config.windowSeconds,
  });

  if (error || !data || !Array.isArray(data) || data.length === 0) {
    if (error) console.error("rate_limit_check RPC failed:", error);
    return { success: true, retryAfterSeconds: 0 };
  }

  const row = data[0] as {
    allowed: boolean;
    current_count: number;
    retry_after_seconds: number;
  };
  return {
    success: row.allowed,
    retryAfterSeconds: row.retry_after_seconds,
  };
}

/**
 * Build a 429 response with the headers ADR-0083 §7 asks the daemon to
 * inspect. Use the same shape on every rate-limited route so clients see a
 * uniform contract.
 */
export function rateLimitResponse(retryAfterSeconds: number): Response {
  return Response.json(
    { error: "Rate limit exceeded" },
    {
      status: 429,
      headers: { "Retry-After": String(Math.max(1, retryAfterSeconds)) },
    }
  );
}

/**
 * Best-effort client IP extraction. Vercel sets `x-forwarded-for` and
 * `x-real-ip`; the leftmost entry of `x-forwarded-for` is the client. Falls
 * back to `"unknown"` so a missing header still produces a deterministic
 * bucket (one shared bucket across opaque clients is preferable to no limit
 * at all when the proxy didn't tag the request).
 */
export function clientIp(request: NextRequest): string {
  const xff = request.headers.get("x-forwarded-for");
  if (xff) {
    const first = xff.split(",")[0]?.trim();
    if (first) return first;
  }
  const xri = request.headers.get("x-real-ip");
  if (xri) return xri.trim();
  return "unknown";
}

/**
 * Hash a Bearer-style API key into a short, stable bucket suffix so the raw
 * key never appears as a row id in `rate_limits`. The full SHA-256 is
 * truncated to 16 hex chars — collisions among ~10^9 keys are still
 * astronomically rare for the tiny set in flight at once, and the bucket
 * scope (`route + key-hash`) means a collision would only let two specific
 * keys share a counter for one window.
 */
export function hashKey(apiKey: string): string {
  return createHash("sha256").update(apiKey).digest("hex").slice(0, 16);
}
