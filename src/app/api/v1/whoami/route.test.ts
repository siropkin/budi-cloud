import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * #541: `/v1/whoami` — identifies the bearer of an API key so the CLI
 * can auto-seed `org_id` in `~/.config/budi/cloud.toml`.
 *
 * Tests hit the real route handler against a minimal Supabase fake
 * that implements only the `from(tbl).select(cols).eq(col, v).single()`
 * chain the auth check uses.
 */

type Row = Record<string, unknown>;

class FakeSupabase {
  private rows: Row[] = [];
  // Per-bucket counters for the `check_rate_limit` RPC fake (#179).
  // The route hits this exactly once per request, after auth.
  rateLimitCounts = new Map<string, number>();
  rateLimitOverride: { allowed: boolean } | null = null;

  seed(rows: Row[]) {
    this.rows = [...rows];
  }

  from(_table: string) {
    void _table;
    return new FakeQuery(this.rows);
  }

  rpc(name: string, args: Record<string, unknown>) {
    if (name !== "check_rate_limit") {
      return Promise.resolve({
        data: null,
        error: { message: `unsupported rpc: ${name}` },
      });
    }
    if (this.rateLimitOverride) {
      return Promise.resolve({
        data: [
          {
            allowed: this.rateLimitOverride.allowed,
            remaining: this.rateLimitOverride.allowed ? 1 : 0,
            reset_at: new Date(Date.now() + 60_000).toISOString(),
          },
        ],
        error: null,
      });
    }
    const key = String(args.p_bucket_key);
    const limit = Number(args.p_limit);
    const next = (this.rateLimitCounts.get(key) ?? 0) + 1;
    this.rateLimitCounts.set(key, next);
    return Promise.resolve({
      data: [
        {
          allowed: next <= limit,
          remaining: Math.max(0, limit - next),
          reset_at: new Date(Date.now() + 60_000).toISOString(),
        },
      ],
      error: null,
    });
  }
}

class FakeQuery {
  private filters: Array<(r: Row) => boolean> = [];

  constructor(private readonly rows: Row[]) {}

  select(_cols?: string) {
    void _cols;
    return this;
  }

  eq(col: string, value: unknown) {
    this.filters.push((r) => r[col] === value);
    return this;
  }

  async single() {
    const matched = this.rows.filter((r) => this.filters.every((f) => f(r)));
    if (matched.length !== 1) {
      return { data: null, error: { message: "not found" } };
    }
    return { data: matched[0], error: null };
  }
}

const fake = new FakeSupabase();

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => fake,
}));

beforeEach(() => {
  fake.seed([]);
  fake.rateLimitCounts.clear();
  fake.rateLimitOverride = null;
});

describe("GET /v1/whoami (#541)", () => {
  it("returns the org_id for a valid budi_* key", async () => {
    fake.seed([
      {
        id: "usr_test",
        org_id: "org_xEvtA",
        api_key: "budi_testkey",
      },
    ]);

    const { GET } = await import("./route");
    const req = new Request("http://localhost/v1/whoami", {
      method: "GET",
      headers: { authorization: "Bearer budi_testkey" },
    });
    const res = await GET(req as unknown as Parameters<typeof GET>[0]);
    const body = (await res.json()) as { org_id: string };

    expect(res.status).toBe(200);
    expect(body.org_id).toBe("org_xEvtA");
  });

  it("401s when the Authorization header is missing", async () => {
    const { GET } = await import("./route");
    const req = new Request("http://localhost/v1/whoami");
    const res = await GET(req as unknown as Parameters<typeof GET>[0]);
    expect(res.status).toBe(401);
    expect((await res.json()).error).toBe("Unauthorized");
  });

  it("401s when the Authorization header is not a Bearer", async () => {
    const { GET } = await import("./route");
    const req = new Request("http://localhost/v1/whoami", {
      headers: { authorization: "Basic dXNlcjpwYXNz" },
    });
    const res = await GET(req as unknown as Parameters<typeof GET>[0]);
    expect(res.status).toBe(401);
  });

  it("401s for a key that doesn't start with budi_", async () => {
    // Defensive — avoids lookup-by-random-string from probing the DB.
    const { GET } = await import("./route");
    const req = new Request("http://localhost/v1/whoami", {
      headers: { authorization: "Bearer sk-openai-abc123" },
    });
    const res = await GET(req as unknown as Parameters<typeof GET>[0]);
    expect(res.status).toBe(401);
  });

  it("401s when the api_key has no matching user row", async () => {
    fake.seed([
      {
        id: "usr_other",
        org_id: "org_other",
        api_key: "budi_other",
      },
    ]);

    const { GET } = await import("./route");
    const req = new Request("http://localhost/v1/whoami", {
      headers: { authorization: "Bearer budi_nonexistent" },
    });
    const res = await GET(req as unknown as Parameters<typeof GET>[0]);
    expect(res.status).toBe(401);
    expect((await res.json()).error).toBe("Unauthorized");
  });

  it("never echoes the api_key in the response", async () => {
    // Defense-in-depth: even an authenticated response should only
    // surface `org_id`; the key itself must never come back on the wire.
    fake.seed([
      {
        id: "usr_test",
        org_id: "org_xEvtA",
        api_key: "budi_testkey",
      },
    ]);

    const { GET } = await import("./route");
    const req = new Request("http://localhost/v1/whoami", {
      headers: { authorization: "Bearer budi_testkey" },
    });
    const res = await GET(req as unknown as Parameters<typeof GET>[0]);
    const text = await res.text();

    expect(res.status).toBe(200);
    expect(text).not.toContain("budi_testkey");
    expect(text).not.toContain("api_key");
  });
});

describe("GET /v1/whoami — rate limiting (#179)", () => {
  it("returns 429 with Retry-After when the bucket is exhausted", async () => {
    fake.seed([
      { id: "usr_test", org_id: "org_xEvtA", api_key: "budi_testkey" },
    ]);
    // Force the RPC fake to report blocked regardless of count.
    fake.rateLimitOverride = { allowed: false };

    const { GET } = await import("./route");
    const req = new Request("http://localhost/v1/whoami", {
      headers: { authorization: "Bearer budi_testkey" },
    });
    const res = await GET(req as unknown as Parameters<typeof GET>[0]);

    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBeTruthy();
    expect(res.headers.get("X-RateLimit-Limit")).toBe("20");
  });

  it("emits rate-limit headers on a successful response", async () => {
    fake.seed([
      { id: "usr_test", org_id: "org_xEvtA", api_key: "budi_testkey" },
    ]);

    const { GET } = await import("./route");
    const req = new Request("http://localhost/v1/whoami", {
      headers: { authorization: "Bearer budi_testkey" },
    });
    const res = await GET(req as unknown as Parameters<typeof GET>[0]);

    expect(res.status).toBe(200);
    expect(res.headers.get("X-RateLimit-Limit")).toBe("20");
    expect(res.headers.get("X-RateLimit-Remaining")).toBe("19");
  });

  it("blocks the 21st request within the window", async () => {
    fake.seed([
      { id: "usr_test", org_id: "org_xEvtA", api_key: "budi_testkey" },
    ]);

    const { GET } = await import("./route");
    const mkReq = () =>
      new Request("http://localhost/v1/whoami", {
        headers: { authorization: "Bearer budi_testkey" },
      });

    for (let i = 0; i < 20; i += 1) {
      const ok = await GET(mkReq() as unknown as Parameters<typeof GET>[0]);
      expect(ok.status).toBe(200);
    }
    const blocked = await GET(mkReq() as unknown as Parameters<typeof GET>[0]);
    expect(blocked.status).toBe(429);
  });
});
