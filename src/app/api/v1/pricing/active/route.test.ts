import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * #234: `GET /v1/pricing/active` — hands the daemon the org's active price
 * list so local recalc stays in lockstep with cloud math.
 *
 * Tests drive the real route handler against a per-table fake Supabase that
 * implements just enough of the postgrest fluent API to satisfy the queries
 * the handler issues (.select, .eq, .in, .lte, .single, .maybeSingle).
 */

type Row = Record<string, unknown>;
type Filter = (r: Row) => boolean;

class FakeSupabase {
  private byTable: Record<string, Row[]> = {};

  seed(table: string, rows: Row[]) {
    this.byTable[table] = [...rows];
  }

  reset() {
    this.byTable = {};
  }

  from(table: string) {
    return new FakeQuery(this.byTable[table] ?? []);
  }

  // Rate-limit RPC — return "allowed".
  async rpc(_name: string, _args: unknown) {
    void _name;
    void _args;
    return {
      data: [{ allowed: true, current_count: 1, retry_after_seconds: 60 }],
      error: null,
    };
  }
}

class FakeQuery {
  private filters: Filter[] = [];

  constructor(private readonly rows: Row[]) {}

  select(_cols?: string) {
    void _cols;
    return this;
  }

  eq(col: string, value: unknown) {
    this.filters.push((r) => r[col] === value);
    return this;
  }

  in(col: string, values: unknown[]) {
    this.filters.push((r) => values.includes(r[col]));
    return this;
  }

  lte(col: string, value: unknown) {
    this.filters.push((r) => {
      const v = r[col];
      if (typeof v !== "string" || typeof value !== "string") return false;
      return v <= value;
    });
    return this;
  }

  private matched() {
    return this.rows.filter((r) => this.filters.every((f) => f(r)));
  }

  async single() {
    const m = this.matched();
    if (m.length !== 1) return { data: null, error: { message: "not found" } };
    return { data: m[0], error: null };
  }

  async maybeSingle() {
    const m = this.matched();
    if (m.length === 0) return { data: null, error: null };
    return { data: m[0], error: null };
  }

  // Awaiting the chain without a terminator should resolve to the matched set —
  // mirrors postgrest, which lets `await supabase.from(...).select(...)` return
  // an array.
  then<TResult1 = { data: Row[]; error: null }, TResult2 = never>(
    onFulfilled?:
      | ((value: {
          data: Row[];
          error: null;
        }) => TResult1 | PromiseLike<TResult1>)
      | null,
    onRejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null
  ): Promise<TResult1 | TResult2> {
    const result = { data: this.matched(), error: null as null };
    return Promise.resolve(result).then(onFulfilled, onRejected);
  }
}

const fake = new FakeSupabase();

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => fake,
}));

const USER = {
  id: "usr_test",
  org_id: "org_acme",
  api_key: "budi_testkey",
};

const PAST = "2020-01-01";
const FUTURE = "2099-12-31";

beforeEach(() => {
  fake.reset();
  fake.seed("users", [USER]);
});

async function call(opts: { since?: string; ifNoneMatch?: string } = {}) {
  const { GET } = await import("./route");
  const url = new URL("http://localhost/v1/pricing/active");
  if (opts.since !== undefined)
    url.searchParams.set("since_version", opts.since);
  const headers: Record<string, string> = {
    authorization: "Bearer budi_testkey",
  };
  if (opts.ifNoneMatch) headers["if-none-match"] = opts.ifNoneMatch;
  const req = new Request(url, { method: "GET", headers });
  return GET(req as unknown as Parameters<typeof GET>[0]);
}

describe("GET /v1/pricing/active (#234)", () => {
  it("401s when the Authorization header is missing", async () => {
    const { GET } = await import("./route");
    const req = new Request("http://localhost/v1/pricing/active");
    const res = await GET(req as unknown as Parameters<typeof GET>[0]);
    expect(res.status).toBe(401);
  });

  it("401s for a key that doesn't start with budi_", async () => {
    const { GET } = await import("./route");
    const req = new Request("http://localhost/v1/pricing/active", {
      headers: { authorization: "Bearer sk-openai-abc" },
    });
    const res = await GET(req as unknown as Parameters<typeof GET>[0]);
    expect(res.status).toBe(401);
  });

  it("404s when the org has no active price list", async () => {
    fake.seed("org_price_lists", []);
    const res = await call();
    expect(res.status).toBe(404);
    expect((await res.json()).error).toBe("No active price list");
  });

  it("404s when the only lists are draft / archived / future / past", async () => {
    fake.seed("org_price_lists", [
      {
        id: 1,
        org_id: "org_acme",
        status: "draft",
        effective_from: PAST,
        effective_to: FUTURE,
      },
      {
        id: 2,
        org_id: "org_acme",
        status: "archived",
        effective_from: PAST,
        effective_to: FUTURE,
      },
      {
        id: 3,
        org_id: "org_acme",
        status: "active",
        effective_from: FUTURE,
        effective_to: null,
      },
      {
        id: 4,
        org_id: "org_acme",
        status: "active",
        effective_from: "2010-01-01",
        effective_to: "2010-12-31",
      },
    ]);
    const res = await call();
    expect(res.status).toBe(404);
  });

  it("returns 200 with privacy-safe rows + list_version + ETag", async () => {
    fake.seed("org_price_lists", [
      {
        id: 7,
        org_id: "org_acme",
        status: "active",
        effective_from: PAST,
        effective_to: null,
      },
    ]);
    fake.seed("org_price_list_rows", [
      {
        list_id: 7,
        platform: "bedrock",
        model_pattern: "claude-sonnet-4-5-*",
        region: "global",
        token_type: "input",
        sale_usd_per_mtok: 2.91,
        // Defense-in-depth: even if a row carries `list_usd_per_mtok`, the
        // endpoint must not leak it.
        list_usd_per_mtok: 9.99,
      },
      {
        list_id: 7,
        platform: "bedrock",
        model_pattern: "claude-sonnet-4-5-*",
        region: "global",
        token_type: "output",
        sale_usd_per_mtok: 14.55,
        list_usd_per_mtok: 30,
      },
    ]);
    fake.seed("org_pricing_defaults", [
      {
        org_id: "org_acme",
        default_platform: "bedrock",
        default_region: "global",
      },
    ]);

    const res = await call();
    expect(res.status).toBe(200);
    expect(res.headers.get("etag")).toBe('"7"');
    expect(res.headers.get("cache-control")).toMatch(/max-age=300/);

    const body = (await res.json()) as {
      org_id: string;
      list_version: number;
      effective_from: string;
      effective_to: string | null;
      defaults: { platform: string | null; region: string | null };
      rows: Array<Record<string, unknown>>;
      generated_at: string;
    };

    expect(body.org_id).toBe("org_acme");
    expect(body.list_version).toBe(7);
    expect(body.effective_from).toBe(PAST);
    expect(body.effective_to).toBeNull();
    expect(body.defaults).toEqual({ platform: "bedrock", region: "global" });
    expect(body.rows).toHaveLength(2);
    for (const row of body.rows) {
      expect(row).not.toHaveProperty("list_usd_per_mtok");
      expect(row).toHaveProperty("sale_usd_per_mtok");
    }
    expect(typeof body.generated_at).toBe("string");
  });

  it("never echoes the api_key in the response", async () => {
    fake.seed("org_price_lists", [
      {
        id: 7,
        org_id: "org_acme",
        status: "active",
        effective_from: PAST,
        effective_to: null,
      },
    ]);
    fake.seed("org_price_list_rows", []);
    const res = await call();
    const text = await res.text();
    expect(text).not.toContain("budi_testkey");
    expect(text).not.toContain("api_key");
  });

  it("returns 304 when since_version matches current list_version", async () => {
    fake.seed("org_price_lists", [
      {
        id: 42,
        org_id: "org_acme",
        status: "active",
        effective_from: PAST,
        effective_to: null,
      },
    ]);
    fake.seed("org_price_list_rows", [
      {
        list_id: 42,
        platform: "anthropic",
        model_pattern: "claude-haiku-4-5",
        region: null,
        token_type: "input",
        sale_usd_per_mtok: 1,
      },
    ]);

    const res = await call({ since: "42" });
    expect(res.status).toBe(304);
    expect(res.headers.get("etag")).toBe('"42"');
    expect(await res.text()).toBe("");
  });

  it("returns full body when since_version is stale", async () => {
    fake.seed("org_price_lists", [
      {
        id: 42,
        org_id: "org_acme",
        status: "active",
        effective_from: PAST,
        effective_to: null,
      },
    ]);
    fake.seed("org_price_list_rows", []);

    const res = await call({ since: "41" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { list_version: number };
    expect(body.list_version).toBe(42);
  });

  it('honours If-None-Match: "<list_version>"', async () => {
    fake.seed("org_price_lists", [
      {
        id: 13,
        org_id: "org_acme",
        status: "active",
        effective_from: PAST,
        effective_to: null,
      },
    ]);
    fake.seed("org_price_list_rows", []);

    const res = await call({ ifNoneMatch: '"13"' });
    expect(res.status).toBe(304);
  });

  it("scopes results to the authenticated user's org (cannot see other orgs)", async () => {
    fake.seed("org_price_lists", [
      // Foreign org's list — must be invisible.
      {
        id: 99,
        org_id: "org_other",
        status: "active",
        effective_from: PAST,
        effective_to: null,
      },
    ]);
    const res = await call();
    expect(res.status).toBe(404);
  });

  it("returns null defaults when org_pricing_defaults is empty", async () => {
    fake.seed("org_price_lists", [
      {
        id: 1,
        org_id: "org_acme",
        status: "active",
        effective_from: PAST,
        effective_to: null,
      },
    ]);
    fake.seed("org_price_list_rows", []);
    fake.seed("org_pricing_defaults", []);

    const res = await call();
    const body = (await res.json()) as {
      defaults: { platform: string | null; region: string | null };
    };
    expect(body.defaults).toEqual({ platform: null, region: null });
  });

  it("merges multiple active lists into one envelope (union of rows, MAX(id) as list_version)", async () => {
    fake.seed("org_price_lists", [
      {
        id: 10,
        org_id: "org_acme",
        status: "active",
        effective_from: "2026-01-01",
        effective_to: "2026-12-31",
      },
      {
        id: 12,
        org_id: "org_acme",
        status: "active",
        effective_from: "2026-03-01",
        effective_to: null,
      },
    ]);
    fake.seed("org_price_list_rows", [
      {
        list_id: 10,
        platform: "anthropic",
        model_pattern: "claude-haiku-4-5",
        region: null,
        token_type: "input",
        sale_usd_per_mtok: 1,
      },
      {
        list_id: 12,
        platform: "bedrock",
        model_pattern: "claude-sonnet-4-5-*",
        region: "global",
        token_type: "input",
        sale_usd_per_mtok: 2.91,
      },
    ]);

    const res = await call();
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      list_version: number;
      effective_from: string;
      effective_to: string | null;
      rows: Array<{ platform: string }>;
    };
    expect(body.list_version).toBe(12);
    expect(body.effective_from).toBe("2026-01-01");
    // One open-ended list wins — union end is "still in effect".
    expect(body.effective_to).toBeNull();
    expect(body.rows.map((r) => r.platform).sort()).toEqual([
      "anthropic",
      "bedrock",
    ]);
  });
});
