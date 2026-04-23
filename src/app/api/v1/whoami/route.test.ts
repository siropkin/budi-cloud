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

  seed(rows: Row[]) {
    this.rows = [...rows];
  }

  from(_table: string) {
    void _table;
    return new FakeQuery(this.rows);
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
