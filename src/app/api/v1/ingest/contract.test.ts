import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * Daemon contract matrix for POST /v1/ingest.
 *
 * The status codes the daemon switches on are spelled out in ADR-0083 §7
 * ("Cloud ingest identity and privacy contract"). They are not arbitrary —
 * each one steers the daemon into a specific state:
 *
 *   - 200  → success, daemon advances its local watermark.
 *   - 401  → auth failure, daemon flips to AuthFailure and stops syncing
 *            until the user re-pastes a key.
 *   - 422  → schema mismatch / malformed envelope, daemon pauses until the
 *            user updates the daemon binary.
 *   - 429  → cloud is asking for backoff, daemon retries with exponential
 *            jitter and obeys `Retry-After`.
 *
 * Other tests in this directory cover the individual branches that fall under
 * each code. This file is the single, focused matrix a reviewer can read in
 * one sitting to confirm the wire contract is intact, plus the two extra
 * invariants the daemon depends on:
 *
 *   - Idempotency: a re-POSTed envelope produces the same row set, not
 *     duplicates. This is what lets the daemon retry safely on transport
 *     errors without double-counting cost.
 *   - Watermark advancement: the 200 response carries the latest
 *     `bucket_day` the cloud has on file for this device. The daemon uses
 *     this value as the cursor for the next sync.
 */

type Row = Record<string, unknown>;

class FakeSupabase {
  tables = new Map<string, Row[]>();
  /**
   * Overridable so a single test can flip the rate limiter to "denied" without
   * touching the others. Default mirrors production-healthy: always allowed.
   */
  rateLimitAllowed = true;
  rateLimitRetryAfter = 30;

  constructor() {
    for (const t of [
      "workspaces",
      "users",
      "devices",
      "daily_rollups",
      "session_summaries",
    ]) {
      this.tables.set(t, []);
    }
  }

  from(name: string) {
    if (!this.tables.has(name)) this.tables.set(name, []);
    return new FakeQuery(this.tables.get(name)!);
  }

  rpc(name: string) {
    if (name === "rate_limit_check") {
      return Promise.resolve({
        data: [
          {
            allowed: this.rateLimitAllowed,
            current_count: this.rateLimitAllowed ? 1 : 999,
            retry_after_seconds: this.rateLimitRetryAfter,
          },
        ],
        error: null,
      });
    }
    return Promise.resolve({
      data: null,
      error: { message: `unsupported rpc: ${name}` },
    });
  }

  seed(name: string, rows: Row[]) {
    this.tables.set(name, [...rows]);
  }

  rows(name: string): Row[] {
    return this.tables.get(name) ?? [];
  }
}

class FakeQuery {
  private filters: Array<(r: Row) => boolean> = [];
  private _orderKey: string | null = null;
  private _orderAsc = true;
  private _limit: number | null = null;
  private _head = false;
  private _countMode: "exact" | null = null;
  private _pendingPatch: Row | null = null;

  constructor(private readonly rows: Row[]) {}

  select(_cols?: string, opts?: { count?: "exact"; head?: boolean }) {
    this._countMode = opts?.count ?? null;
    this._head = opts?.head ?? false;
    return this;
  }

  eq(col: string, value: unknown) {
    this.filters.push((r) => r[col] === value);
    return this;
  }

  in(col: string, values: unknown[]) {
    const set = new Set(values);
    this.filters.push((r) => set.has(r[col]));
    return this;
  }

  order(col: string, opts?: { ascending?: boolean }) {
    this._orderKey = col;
    this._orderAsc = opts?.ascending ?? true;
    return this;
  }

  limit(n: number) {
    this._limit = n;
    return this;
  }

  private materialize(): Row[] {
    let rows = this.rows.filter((r) => this.filters.every((f) => f(r)));
    if (this._orderKey) {
      const key = this._orderKey;
      const asc = this._orderAsc;
      rows = [...rows].sort((a, b) => {
        const av = String(a[key] ?? "");
        const bv = String(b[key] ?? "");
        if (av === bv) return 0;
        return (av < bv ? -1 : 1) * (asc ? 1 : -1);
      });
    }
    if (this._limit != null) rows = rows.slice(0, this._limit);
    return rows;
  }

  async single() {
    const rows = this.materialize();
    if (rows.length === 1) return { data: rows[0], error: null };
    return {
      data: null,
      error: { message: `expected 1 row, got ${rows.length}` },
    };
  }

  then<T>(
    onFulfilled: (r: { data: Row[]; error: null; count: number | null }) => T
  ) {
    this.applyPendingUpdateIfAny();
    const rows = this.materialize();
    const count = this._countMode === "exact" ? rows.length : null;
    const data = this._head ? [] : rows;
    return Promise.resolve(onFulfilled({ data, error: null, count }));
  }

  async insert(row: Row | Row[]) {
    const list = Array.isArray(row) ? row : [row];
    for (const r of list) this.rows.push({ ...r });
    return { data: null, error: null };
  }

  update(patch: Row) {
    this._pendingPatch = patch;
    return this;
  }

  private applyPendingUpdateIfAny() {
    if (!this._pendingPatch) return;
    const matches = this.rows.filter((r) => this.filters.every((f) => f(r)));
    for (const r of matches) Object.assign(r, this._pendingPatch);
    this._pendingPatch = null;
  }

  async upsert(
    rowOrRows: Row | Row[],
    opts?: { onConflict?: string; count?: "exact" }
  ) {
    const list = Array.isArray(rowOrRows) ? rowOrRows : [rowOrRows];
    const conflictCols = (opts?.onConflict ?? "")
      .split(",")
      .map((c) => c.trim());
    for (const incoming of list) {
      const existingIdx = this.rows.findIndex((r) =>
        conflictCols.every((c) => r[c] === incoming[c])
      );
      if (existingIdx >= 0) {
        this.rows[existingIdx] = { ...this.rows[existingIdx], ...incoming };
      } else {
        this.rows.push({ ...incoming });
      }
    }
    return {
      data: null,
      error: null,
      count: opts?.count === "exact" ? list.length : null,
    };
  }
}

const fake = new FakeSupabase();

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => fake,
}));

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    auth: { getUser: async () => ({ data: { user: null } }) },
  }),
}));

vi.mock("server-only", () => ({}));

const DEVICE_ID = "11111111-1111-4111-8111-111111111111";
const API_KEY = "budi_contracttestkey";

function seedAuthedUser() {
  fake.seed("workspaces", [{ id: "org_test", name: "test" }]);
  fake.seed("users", [
    {
      id: "usr_test",
      workspace_id: "org_test",
      role: "manager",
      api_key: API_KEY,
      display_name: "Test User",
      email: "test@example.com",
    },
  ]);
}

function mkReq(
  body: Record<string, unknown>,
  opts?: { authorization?: string | null }
): Request {
  const headers: Record<string, string> = {
    "content-type": "application/json",
  };
  const auth =
    opts && "authorization" in opts ? opts.authorization : `Bearer ${API_KEY}`;
  if (auth) headers.authorization = auth;
  return new Request("http://localhost/v1/ingest", {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
}

const baseRollup = {
  bucket_day: "2026-04-14",
  role: "assistant",
  provider: "claude_code",
  model: "claude-sonnet-4-5",
  repo_id: "repo_x",
  git_branch: "refs/heads/main",
  ticket: null,
  message_count: 1,
  input_tokens: 100,
  output_tokens: 50,
  cache_creation_tokens: 0,
  cache_read_tokens: 0,
  cost_cents: 12,
};

function envelopeWith(overrides: Record<string, unknown> = {}) {
  return {
    schema_version: 1,
    device_id: DEVICE_ID,
    workspace_id: "org_test",
    synced_at: "2026-04-15T12:00:00Z",
    payload: {
      daily_rollups: [baseRollup],
      session_summaries: [],
    },
    ...overrides,
  };
}

beforeEach(() => {
  fake.rateLimitAllowed = true;
  fake.rateLimitRetryAfter = 30;
  for (const t of [
    "workspaces",
    "users",
    "devices",
    "daily_rollups",
    "session_summaries",
  ]) {
    fake.seed(t, []);
  }
});

describe("POST /v1/ingest — daemon contract matrix (ADR-0083 §7)", () => {
  describe("200 — daemon advances watermark", () => {
    it("returns 200 and a watermark equal to the latest bucket_day in the envelope", async () => {
      seedAuthedUser();
      const { POST } = await import("./route");

      // Two bucket_days in one envelope; the watermark must report the
      // *latest* one because the daemon's next-sync cursor is "everything
      // after this date".
      const envelope = envelopeWith({
        payload: {
          daily_rollups: [
            { ...baseRollup, bucket_day: "2026-04-12" },
            { ...baseRollup, bucket_day: "2026-04-14" },
            { ...baseRollup, bucket_day: "2026-04-13" },
          ],
          session_summaries: [],
        },
      });

      const res = await POST(
        mkReq(envelope) as unknown as Parameters<typeof POST>[0]
      );

      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        accepted: boolean;
        watermark: string | null;
        daily_rollups_upserted: number;
      };
      expect(body.accepted).toBe(true);
      expect(body.daily_rollups_upserted).toBe(3);
      // Watermark advancement is the load-bearing field for the daemon's
      // next sync (ADR-0083 §5/§7): it must be the max bucket_day seen for
      // this device, not the synced_at, and not the first row in the array.
      expect(body.watermark).toBe("2026-04-14");
    });
  });

  describe("401 — daemon flips to AuthFailure", () => {
    it("returns 401 when the Authorization header is missing", async () => {
      seedAuthedUser();
      const { POST } = await import("./route");

      const res = await POST(
        mkReq(envelopeWith(), { authorization: null }) as unknown as Parameters<
          typeof POST
        >[0]
      );

      expect(res.status).toBe(401);
      expect((await res.json()).error).toBe("Unauthorized");
      // 401 must short-circuit before any write.
      expect(fake.rows("daily_rollups")).toHaveLength(0);
    });

    it("returns 401 when the Bearer token does not match any user", async () => {
      seedAuthedUser();
      const { POST } = await import("./route");

      const res = await POST(
        mkReq(envelopeWith(), {
          authorization: "Bearer budi_wrong",
        }) as unknown as Parameters<typeof POST>[0]
      );

      expect(res.status).toBe(401);
      expect((await res.json()).error).toBe("Unauthorized");
      expect(fake.rows("daily_rollups")).toHaveLength(0);
    });

    it("returns 401 when workspace_id in the envelope does not match the key's org", async () => {
      seedAuthedUser();
      const { POST } = await import("./route");

      const res = await POST(
        mkReq(
          envelopeWith({ workspace_id: "org_other" })
        ) as unknown as Parameters<typeof POST>[0]
      );

      expect(res.status).toBe(401);
      expect(fake.rows("daily_rollups")).toHaveLength(0);
    });
  });

  describe("422 — daemon pauses until updated", () => {
    it("returns 422 on unsupported schema_version", async () => {
      seedAuthedUser();
      const { POST } = await import("./route");

      const res = await POST(
        mkReq(envelopeWith({ schema_version: 9999 })) as unknown as Parameters<
          typeof POST
        >[0]
      );

      expect(res.status).toBe(422);
      const body = (await res.json()) as { error: string };
      expect(body.error).toMatch(/schema_version/i);
      expect(fake.rows("daily_rollups")).toHaveLength(0);
    });

    it("returns 422 on a malformed device_id (non-UUID)", async () => {
      seedAuthedUser();
      const { POST } = await import("./route");

      const res = await POST(
        mkReq(
          envelopeWith({ device_id: "not-a-uuid" })
        ) as unknown as Parameters<typeof POST>[0]
      );

      expect(res.status).toBe(422);
      expect((await res.json()).error).toMatch(/device_id/i);
    });

    it("returns 422 when a metric is non-finite or negative", async () => {
      seedAuthedUser();
      const { POST } = await import("./route");

      const res = await POST(
        mkReq(
          envelopeWith({
            payload: {
              daily_rollups: [{ ...baseRollup, cost_cents: -1 }],
              session_summaries: [],
            },
          })
        ) as unknown as Parameters<typeof POST>[0]
      );

      expect(res.status).toBe(422);
      expect((await res.json()).error).toMatch(/cost_cents/);
    });
  });

  describe("429 — daemon backs off with exponential retry", () => {
    it("returns 429 with a Retry-After header when the rate limiter denies the request", async () => {
      seedAuthedUser();
      fake.rateLimitAllowed = false;
      fake.rateLimitRetryAfter = 17;
      const { POST } = await import("./route");

      const res = await POST(
        mkReq(envelopeWith()) as unknown as Parameters<typeof POST>[0]
      );

      expect(res.status).toBe(429);
      // The daemon reads `Retry-After` to schedule its next attempt — this
      // header is the contract, not the body. Verify the actual value the
      // limiter returned rides through.
      expect(res.headers.get("retry-after")).toBe("17");
      expect((await res.json()).error).toMatch(/rate limit/i);
      // 429 must short-circuit: no writes, not even device auto-register.
      expect(fake.rows("daily_rollups")).toHaveLength(0);
      expect(fake.rows("devices")).toHaveLength(0);
    });
  });

  describe("idempotency — daemon can safely retry on transport errors", () => {
    it("re-POSTing the same envelope produces no duplicate rows and a stable watermark", async () => {
      seedAuthedUser();
      const { POST } = await import("./route");

      const envelope = envelopeWith({
        payload: {
          daily_rollups: [
            { ...baseRollup, bucket_day: "2026-04-13", cost_cents: 10 },
            { ...baseRollup, bucket_day: "2026-04-14", cost_cents: 20 },
          ],
          session_summaries: [
            {
              session_id: "sess-1",
              provider: "claude_code",
              started_at: "2026-04-14T10:00:00Z",
              ended_at: "2026-04-14T11:00:00Z",
              duration_ms: 3_600_000,
              repo_id: null,
              git_branch: null,
              ticket: null,
              message_count: 3,
              total_input_tokens: 30,
              total_output_tokens: 15,
              total_cost_cents: 5,
            },
          ],
        },
      });

      const first = await POST(
        mkReq(envelope) as unknown as Parameters<typeof POST>[0]
      );
      expect(first.status).toBe(200);
      const firstBody = (await first.json()) as { watermark: string };

      // Re-POST the *exact same* envelope. The UPSERT semantics in ADR-0083
      // §5 must collapse it back onto the existing rows — no duplicates.
      const second = await POST(
        mkReq(envelope) as unknown as Parameters<typeof POST>[0]
      );
      expect(second.status).toBe(200);
      const secondBody = (await second.json()) as { watermark: string };

      expect(fake.rows("daily_rollups")).toHaveLength(2);
      expect(fake.rows("session_summaries")).toHaveLength(1);
      // Watermark is stable across the retry — the daemon's cursor doesn't
      // jump backwards or forwards just because it retried.
      expect(secondBody.watermark).toBe(firstBody.watermark);
      expect(secondBody.watermark).toBe("2026-04-14");
    });
  });
});
