import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * #179: rate-limit unit tests. The Postgres counter itself is exercised in
 * the migration (017), so here we verify the JS wrapper:
 *   - delegates atomically to the `rate_limit_check` RPC
 *   - propagates the `allowed` flag and `retry_after_seconds` value
 *   - fails open when the RPC errors (so a limiter outage doesn't pause the
 *     fleet via 429 → ADR-0083 §7 daemon backoff)
 *   - never lands a raw API key in the bucket id
 */

type RpcArgs = {
  p_bucket: string;
  p_limit: number;
  p_window_seconds: number;
};

type RpcResult = {
  data: Array<{
    allowed: boolean;
    current_count: number;
    retry_after_seconds: number;
  }> | null;
  error: unknown;
};

let lastRpc: { name: string; args: RpcArgs } | null = null;
let nextRpcResult: RpcResult = {
  data: [{ allowed: true, current_count: 1, retry_after_seconds: 60 }],
  error: null,
};

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    rpc: (name: string, args: RpcArgs) => {
      lastRpc = { name, args };
      return Promise.resolve(nextRpcResult);
    },
  }),
}));

beforeEach(() => {
  lastRpc = null;
  nextRpcResult = {
    data: [{ allowed: true, current_count: 1, retry_after_seconds: 60 }],
    error: null,
  };
});

describe("rateLimit", () => {
  it("calls rate_limit_check with the bucket and config", async () => {
    const { rateLimit } = await import("./rate-limit");
    const result = await rateLimit("ingest:key:abc123", {
      limit: 60,
      windowSeconds: 60,
    });

    expect(lastRpc?.name).toBe("rate_limit_check");
    expect(lastRpc?.args).toEqual({
      p_bucket: "ingest:key:abc123",
      p_limit: 60,
      p_window_seconds: 60,
    });
    expect(result.success).toBe(true);
  });

  it("returns success=false when the RPC reports the cap is exceeded", async () => {
    nextRpcResult = {
      data: [{ allowed: false, current_count: 61, retry_after_seconds: 42 }],
      error: null,
    };
    const { rateLimit } = await import("./rate-limit");
    const result = await rateLimit("ingest:ip:1.2.3.4", {
      limit: 60,
      windowSeconds: 60,
    });
    expect(result.success).toBe(false);
    expect(result.retryAfterSeconds).toBe(42);
  });

  it("fails open when the RPC errors so a limiter outage does not pause ingest", async () => {
    nextRpcResult = { data: null, error: new Error("rpc unreachable") };
    const { rateLimit } = await import("./rate-limit");
    const result = await rateLimit("ingest:ip:1.2.3.4", {
      limit: 60,
      windowSeconds: 60,
    });
    expect(result.success).toBe(true);
  });

  it("fails open on an empty result row (defensive)", async () => {
    nextRpcResult = { data: [], error: null };
    const { rateLimit } = await import("./rate-limit");
    const result = await rateLimit("freshness:user:xyz", {
      limit: 60,
      windowSeconds: 60,
    });
    expect(result.success).toBe(true);
  });
});

describe("rateLimitResponse", () => {
  it("returns a 429 with Retry-After at least 1 second", async () => {
    const { rateLimitResponse } = await import("./rate-limit");
    const res = rateLimitResponse(0);
    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBe("1");
  });

  it("propagates the retry_after value when above the floor", async () => {
    const { rateLimitResponse } = await import("./rate-limit");
    const res = rateLimitResponse(42);
    expect(res.headers.get("retry-after")).toBe("42");
  });
});

describe("hashKey", () => {
  it("produces a deterministic 16-hex-char hash that is not the input", async () => {
    const { hashKey } = await import("./rate-limit");
    const a = hashKey("budi_secret_token");
    const b = hashKey("budi_secret_token");
    expect(a).toBe(b);
    expect(a).toHaveLength(16);
    expect(a).toMatch(/^[0-9a-f]{16}$/);
    expect(a).not.toContain("secret");
    expect(a).not.toContain("budi_");
  });
});

describe("clientIp", () => {
  it("prefers the leftmost x-forwarded-for entry", async () => {
    const { clientIp } = await import("./rate-limit");
    const req = {
      headers: new Headers({
        "x-forwarded-for": "203.0.113.7, 10.0.0.1",
        "x-real-ip": "10.0.0.1",
      }),
    };
    expect(clientIp(req as never)).toBe("203.0.113.7");
  });

  it("falls back to x-real-ip", async () => {
    const { clientIp } = await import("./rate-limit");
    const req = {
      headers: new Headers({ "x-real-ip": "198.51.100.4" }),
    };
    expect(clientIp(req as never)).toBe("198.51.100.4");
  });

  it("returns 'unknown' when no proxy headers are set", async () => {
    const { clientIp } = await import("./rate-limit");
    const req = { headers: new Headers() };
    expect(clientIp(req as never)).toBe("unknown");
  });
});
