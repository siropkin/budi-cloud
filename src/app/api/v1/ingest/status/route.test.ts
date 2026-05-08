import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * #182: `/v1/ingest/status` must not leak whether a device_id exists
 * in another org. Both "no such device anywhere" and "device belongs
 * to another org" must return identical responses (status + body).
 */

type Row = Record<string, unknown>;

class FakeSupabase {
  tables = new Map<string, Row[]>();

  seed(table: string, rows: Row[]) {
    this.tables.set(table, [...rows]);
  }

  from(table: string) {
    if (!this.tables.has(table)) this.tables.set(table, []);
    return new FakeQuery(this.tables.get(table)!);
  }
}

class FakeQuery {
  private filters: Array<(r: Row) => boolean> = [];
  private orderKey: string | null = null;
  private orderAsc = true;
  private limitN: number | null = null;
  private isCount = false;

  constructor(private readonly rows: Row[]) {}

  select(_cols?: string, opts?: { count?: string; head?: boolean }) {
    void _cols;
    if (opts?.count) this.isCount = true;
    return this;
  }

  eq(col: string, value: unknown) {
    this.filters.push((r) => r[col] === value);
    return this;
  }

  order(col: string, opts?: { ascending?: boolean }) {
    this.orderKey = col;
    this.orderAsc = opts?.ascending ?? true;
    return this;
  }

  limit(n: number) {
    this.limitN = n;
    return this;
  }

  private matched() {
    let out = this.rows.filter((r) => this.filters.every((f) => f(r)));
    if (this.orderKey) {
      const k = this.orderKey;
      out = [...out].sort((a, b) => {
        const av = String(a[k] ?? "");
        const bv = String(b[k] ?? "");
        return this.orderAsc ? av.localeCompare(bv) : bv.localeCompare(av);
      });
    }
    if (this.limitN != null) out = out.slice(0, this.limitN);
    return out;
  }

  async single() {
    const matched = this.matched();
    if (matched.length !== 1) {
      return { data: null, error: { message: "not found" } };
    }
    return { data: matched[0], error: null };
  }

  // For `.select("*", { count: "exact", head: true }).eq(...)` chains
  // we resolve as a thenable returning { count, error }.
  then(resolve: (v: { count: number | null; error: null }) => void) {
    if (!this.isCount) {
      throw new Error("FakeQuery.then() only supports count queries");
    }
    resolve({ count: this.matched().length, error: null });
  }
}

const fake = new FakeSupabase();

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => fake,
}));

beforeEach(() => {
  fake.tables.clear();
});

const callerKey = "budi_caller";
const callerOrg = "org_caller";
const callerUserId = "usr_caller";

function seedCaller() {
  fake.seed("users", [
    { id: callerUserId, org_id: callerOrg, api_key: callerKey },
  ]);
}

async function callStatus(deviceId: string | null, key = callerKey) {
  const { GET } = await import("./route");
  const url = deviceId
    ? `http://localhost/v1/ingest/status?device_id=${encodeURIComponent(deviceId)}`
    : "http://localhost/v1/ingest/status";
  const req = new Request(url, {
    method: "GET",
    headers: { authorization: `Bearer ${key}` },
  });
  // The route handler reads `request.nextUrl.searchParams`; in tests we're
  // calling it with a plain Request, so attach a minimal nextUrl shim.
  Object.defineProperty(req, "nextUrl", {
    value: new URL(url),
  });
  return GET(req as unknown as Parameters<typeof GET>[0]);
}

describe("GET /v1/ingest/status (#182)", () => {
  it("returns 401 without a Bearer token", async () => {
    const { GET } = await import("./route");
    const req = new Request("http://localhost/v1/ingest/status");
    const res = await GET(req as unknown as Parameters<typeof GET>[0]);
    expect(res.status).toBe(401);
  });

  it("returns 401 when the api key has no matching user", async () => {
    seedCaller();
    const res = await callStatus("dev_anything", "budi_unknown");
    expect(res.status).toBe(401);
  });

  it("returns 400 when device_id is missing", async () => {
    seedCaller();
    const res = await callStatus(null);
    expect(res.status).toBe(400);
  });

  it("returns 200 with watermark for a device in the caller's org", async () => {
    seedCaller();
    fake.seed("devices", [
      {
        id: "dev_mine",
        user_id: callerUserId,
        last_seen: "2026-05-01T00:00:00Z",
      },
    ]);
    fake.seed("daily_rollups", [
      { device_id: "dev_mine", bucket_day: "2026-04-30" },
      { device_id: "dev_mine", bucket_day: "2026-05-01" },
    ]);
    fake.seed("session_summaries", [{ device_id: "dev_mine" }]);

    const res = await callStatus("dev_mine");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      device_id: string;
      watermark: string | null;
      total_rollup_records: number;
      total_session_records: number;
    };
    expect(body.device_id).toBe("dev_mine");
    expect(body.watermark).toBe("2026-05-01");
    expect(body.total_rollup_records).toBe(2);
    expect(body.total_session_records).toBe(1);
  });

  it("returns identical 404 for unknown device and foreign-org device", async () => {
    // Regression for #182: distinguishing these two cases lets a holder
    // of any valid API key probe the global devices table for existence.
    seedCaller();
    fake.seed("users", [
      { id: callerUserId, org_id: callerOrg, api_key: callerKey },
      { id: "usr_other", org_id: "org_other", api_key: "budi_other" },
    ]);
    fake.seed("devices", [
      {
        id: "dev_foreign",
        user_id: "usr_other",
        last_seen: "2026-05-01T00:00:00Z",
      },
    ]);

    const unknownRes = await callStatus("dev_does_not_exist");
    const foreignRes = await callStatus("dev_foreign");

    expect(unknownRes.status).toBe(404);
    expect(foreignRes.status).toBe(404);

    const unknownBody = await unknownRes.json();
    const foreignBody = await foreignRes.json();
    expect(unknownBody).toEqual(foreignBody);
  });
});
