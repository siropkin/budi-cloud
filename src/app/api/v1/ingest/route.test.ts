import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * Integration test for the ingest write path + dashboard read path.
 *
 * Regression coverage for #14: POST an envelope with daily_rollups +
 * session_summaries (some without `started_at`), then assert that both the
 * Overview DAL and the Sessions DAL see every row.
 *
 * The whole test runs against an in-memory fake that implements just enough
 * of the Supabase query builder (select/insert/upsert/update + the chained
 * filter methods actually used by ingest + dal).
 */

type Row = Record<string, unknown>;

class FakeSupabase {
  tables = new Map<string, Row[]>();

  constructor() {
    this.tables.set("orgs", []);
    this.tables.set("users", []);
    this.tables.set("devices", []);
    this.tables.set("daily_rollups", []);
    this.tables.set("session_summaries", []);
  }

  from(name: string) {
    if (!this.tables.has(name)) this.tables.set(name, []);
    return new FakeQuery(this.tables.get(name)!);
  }

  /**
   * Mirrors `dashboard_overview_stats` from `004_dashboard_aggregates.sql`
   * (#92). The full RPC suite lives next to the dal tests; this test only
   * exercises the overview path on the read side, so we keep the shim minimal
   * — extend if a future ingest test calls another breakdown.
   */
  rpc(name: string, args: Record<string, unknown>) {
    // #179: route now calls rate_limit_check on every request — return a
    // permissive stub so existing assertions keep exercising the handler
    // body rather than the 429 short-circuit.
    if (name === "rate_limit_check") {
      return Promise.resolve({
        data: [{ allowed: true, current_count: 1, retry_after_seconds: 60 }],
        error: null,
      });
    }
    if (name !== "dashboard_overview_stats") {
      return Promise.resolve({
        data: null,
        error: { message: `unsupported rpc: ${name}` },
      });
    }
    const deviceIds = new Set(args.p_device_ids as string[]);
    const from = args.p_bucket_from as string;
    const to = args.p_bucket_to as string;
    const rollups = (this.tables.get("daily_rollups") ?? []).filter(
      (r) =>
        deviceIds.has(r.device_id as string) &&
        String(r.bucket_day ?? "") >= from &&
        String(r.bucket_day ?? "") <= to
    );
    const totals = rollups.reduce<{
      total_cost_cents: number;
      total_input_tokens: number;
      total_output_tokens: number;
      total_messages: number;
    }>(
      (acc, r) => ({
        // #231: mirror the real `dashboard_overview_stats` RPC, which sums
        // `cost_cents_effective` (the post-recalc value the dashboard shows).
        total_cost_cents: acc.total_cost_cents + Number(r.cost_cents_effective),
        total_input_tokens: acc.total_input_tokens + Number(r.input_tokens),
        total_output_tokens: acc.total_output_tokens + Number(r.output_tokens),
        total_messages: acc.total_messages + Number(r.message_count),
      }),
      {
        total_cost_cents: 0,
        total_input_tokens: 0,
        total_output_tokens: 0,
        total_messages: 0,
      }
    );
    const total_sessions = (this.tables.get("session_summaries") ?? []).filter(
      (s) => {
        if (!deviceIds.has(s.device_id as string)) return false;
        // Mirrors `COALESCE(started_at, ended_at, synced_at)::date` (#155).
        const anchor = (s.started_at ?? s.ended_at ?? s.synced_at ?? "") as
          | string
          | null;
        const date = anchor ? String(anchor).slice(0, 10) : "";
        return date !== "" && date >= from && date <= to;
      }
    ).length;
    return Promise.resolve({
      data: [{ ...totals, total_sessions }],
      error: null,
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

  gte(col: string, value: string) {
    this.filters.push((r) => String(r[col] ?? "") >= value);
    return this;
  }

  lte(col: string, value: string) {
    this.filters.push((r) => String(r[col] ?? "") <= value);
    return this;
  }

  not(col: string, op: string, value: unknown) {
    if (op === "is" && value === null) {
      this.filters.push((r) => r[col] != null);
    }
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
    // If there's a pending `.update(patch)`, apply it before returning.
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
    // Supabase allows `.update(patch).eq(...)` — collect the patch, then
    // apply it when the query resolves (via .then() or await on .eq()).
    this._pendingPatch = patch;
    return this;
  }

  private _pendingPatch: Row | null = null;

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

// dal.ts also imports createClient from @/lib/supabase/server; stub it out so
// server-only imports don't explode in vitest. getSessions + getOverviewStats
// use the admin client, not this one.
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    auth: { getUser: async () => ({ data: { user: null } }) },
  }),
}));

// server-only is a no-op at runtime; stub so it doesn't throw under vitest.
vi.mock("server-only", () => ({}));

beforeEach(() => {
  for (const t of [
    "orgs",
    "users",
    "devices",
    "daily_rollups",
    "session_summaries",
  ]) {
    fake.seed(t, []);
  }
});

describe("POST /v1/ingest + dashboard read path (#14)", () => {
  it("persists session_summaries and both dashboards see all rows", async () => {
    fake.seed("orgs", [{ id: "org_test", name: "test" }]);
    fake.seed("users", [
      {
        id: "usr_test",
        org_id: "org_test",
        role: "manager",
        api_key: "budi_testkey",
        display_name: "Test User",
        email: "test@example.com",
      },
    ]);

    const { POST } = await import("./route");
    const { getOverviewStats, getSessions } = await import("@/lib/dal");

    const envelope = {
      schema_version: 1,
      device_id: "11111111-1111-4111-8111-111111111111",
      org_id: "org_test",
      synced_at: "2026-04-15T12:00:00Z",
      payload: {
        daily_rollups: [
          {
            bucket_day: "2026-04-14",
            role: "assistant",
            provider: "claude_code",
            model: "claude-sonnet-4-5",
            repo_id: "repo_x",
            git_branch: "refs/heads/main",
            ticket: null,
            message_count: 42,
            input_tokens: 1000,
            output_tokens: 500,
            cache_creation_tokens: 0,
            cache_read_tokens: 0,
            cost_cents: 1234,
          },
        ],
        session_summaries: [
          {
            session_id: "sess-with-started",
            provider: "cursor",
            started_at: "2026-04-14T10:00:00Z",
            ended_at: "2026-04-14T11:00:00Z",
            duration_ms: 3_600_000,
            repo_id: "repo_x",
            git_branch: "refs/heads/main",
            ticket: null,
            message_count: 5,
            total_input_tokens: 100,
            total_output_tokens: 50,
            total_cost_cents: 50,
          },
          {
            // This is the case that silently disappeared in #14: the daemon
            // legitimately ships a session with no `started_at` (claude_code
            // does this for every session). The dashboard filters on
            // `started_at`, so NULL rows vanish. The ingest-side fallback
            // to `ended_at ?? synced_at` restores visibility.
            session_id: "sess-without-started",
            provider: "claude_code",
            started_at: null,
            ended_at: "2026-04-14T13:00:00Z",
            duration_ms: null,
            repo_id: "repo_x",
            git_branch: "refs/heads/main",
            ticket: null,
            message_count: 3,
            total_input_tokens: 30,
            total_output_tokens: 15,
            total_cost_cents: 20,
          },
        ],
      },
    };

    const req = new Request("http://localhost/v1/ingest", {
      method: "POST",
      headers: {
        authorization: "Bearer budi_testkey",
        "content-type": "application/json",
      },
      body: JSON.stringify(envelope),
    });

    // POST handler accepts NextRequest, but our shape is compatible for the
    // fields actually read (headers + text()).
    const res = await POST(req as unknown as Parameters<typeof POST>[0]);
    const body = (await res.json()) as {
      accepted: boolean;
      daily_rollups_upserted: number;
      session_summaries_upserted: number;
      records_upserted: number;
    };

    expect(res.status).toBe(200);
    expect(body.accepted).toBe(true);
    expect(body.daily_rollups_upserted).toBe(1);
    expect(body.session_summaries_upserted).toBe(2);
    expect(body.records_upserted).toBe(3);

    // Device was auto-registered against the authenticated user.
    expect(fake.rows("devices")).toHaveLength(1);
    expect(fake.rows("devices")[0].user_id).toBe("usr_test");

    // Both session rows landed in the table with a non-null `started_at`.
    const sessions = fake.rows("session_summaries");
    expect(sessions).toHaveLength(2);
    for (const s of sessions) {
      expect(s.started_at).toBeTruthy();
    }
    const noStart = sessions.find(
      (s) => s.session_id === "sess-without-started"
    )!;
    // Fallback to ended_at (preferred) rather than synced_at.
    expect(noStart.started_at).toBe("2026-04-14T13:00:00Z");

    const user = {
      id: "usr_test",
      org_id: "org_test",
      role: "manager",
      api_key: "budi_testkey",
      display_name: "Test User",
      email: "test@example.com",
    };
    const range = {
      from: "2026-04-01",
      to: "2026-04-16",
      bucketFrom: "2026-04-01",
      bucketTo: "2026-04-16",
      startedAtFrom: "2026-04-01T00:00:00.000Z",
      startedAtTo: "2026-04-16T23:59:59.999Z",
    };

    const overview = await getOverviewStats(user, range);
    expect(overview.totalCostCents).toBe(1234);
    expect(overview.totalSessions).toBe(2);

    const listed = await getSessions(user, range);
    expect(listed.rows).toHaveLength(2);
    const ids = listed.rows.map((s) => s.session_id).sort();
    expect(ids).toEqual(["sess-with-started", "sess-without-started"]);
  });

  it("second ingest of the same session with null started_at does not clobber", async () => {
    fake.seed("orgs", [{ id: "org_test", name: "test" }]);
    fake.seed("users", [
      {
        id: "usr_test",
        org_id: "org_test",
        role: "manager",
        api_key: "budi_testkey",
        display_name: "Test",
        email: "t@example.com",
      },
    ]);

    const { POST } = await import("./route");

    type SessionSummary = {
      session_id: string;
      provider: string;
      started_at: string | null;
      ended_at: string;
      duration_ms: number;
      repo_id: string | null;
      git_branch: string | null;
      ticket: string | null;
      message_count: number;
      total_input_tokens: number;
      total_output_tokens: number;
      total_cost_cents: number;
    };
    type Envelope = {
      schema_version: number;
      device_id: string;
      org_id: string;
      synced_at: string;
      payload: {
        daily_rollups: never[];
        session_summaries: SessionSummary[];
      };
    };
    const baseEnvelope: Envelope = {
      schema_version: 1,
      device_id: "11111111-1111-4111-8111-111111111111",
      org_id: "org_test",
      synced_at: "2026-04-15T12:00:00Z",
      payload: {
        daily_rollups: [],
        session_summaries: [
          {
            session_id: "sess-a",
            provider: "cursor",
            started_at: "2026-04-14T10:00:00Z",
            ended_at: "2026-04-14T11:00:00Z",
            duration_ms: 3_600_000,
            repo_id: null,
            git_branch: null,
            ticket: null,
            message_count: 1,
            total_input_tokens: 1,
            total_output_tokens: 1,
            total_cost_cents: 1,
          },
        ],
      },
    };

    const mkReq = (env: typeof baseEnvelope) =>
      new Request("http://localhost/v1/ingest", {
        method: "POST",
        headers: {
          authorization: "Bearer budi_testkey",
          "content-type": "application/json",
        },
        body: JSON.stringify(env),
      });

    await POST(mkReq(baseEnvelope) as unknown as Parameters<typeof POST>[0]);

    // Second envelope for the same session with started_at omitted.
    const second = {
      ...baseEnvelope,
      synced_at: "2026-04-15T13:00:00Z",
      payload: {
        daily_rollups: [],
        session_summaries: [
          {
            ...baseEnvelope.payload.session_summaries[0],
            started_at: null,
            ended_at: "2026-04-14T12:00:00Z",
            message_count: 2,
          },
        ],
      },
    };
    await POST(mkReq(second) as unknown as Parameters<typeof POST>[0]);

    const sessions = fake.rows("session_summaries");
    expect(sessions).toHaveLength(1);
    // Fallback kicked in: the row keeps a valid `started_at` (= ended_at from
    // the second envelope) instead of NULL. Either the original started_at
    // being preserved, or the ended_at fallback, is acceptable — what matters
    // is that the column is non-null so the dashboard query still matches.
    expect(sessions[0].started_at).toBeTruthy();
    expect(sessions[0].message_count).toBe(2);
  });
});

describe("POST /v1/ingest — device label persistence (#60)", () => {
  function seedUser() {
    fake.seed("orgs", [{ id: "org_test", name: "test" }]);
    fake.seed("users", [
      {
        id: "usr_test",
        org_id: "org_test",
        role: "manager",
        api_key: "budi_testkey",
        display_name: "Test",
        email: "t@example.com",
      },
    ]);
  }

  function mkReq(body: Record<string, unknown>): Request {
    return new Request("http://localhost/v1/ingest", {
      method: "POST",
      headers: {
        authorization: "Bearer budi_testkey",
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    });
  }

  const baseEnvelope = {
    schema_version: 1,
    device_id: "11111111-1111-4111-8111-111111111111",
    org_id: "org_test",
    synced_at: "2026-04-15T12:00:00Z",
    payload: { daily_rollups: [], session_summaries: [] },
  };

  it("persists label on auto-register when the envelope carries one", async () => {
    seedUser();
    const { POST } = await import("./route");

    await POST(
      mkReq({ ...baseEnvelope, label: "ivan-mbp" }) as unknown as Parameters<
        typeof POST
      >[0]
    );

    const [device] = fake.rows("devices");
    expect(device.label).toBe("ivan-mbp");
  });

  it("auto-registers with label=null when the envelope omits the field (old daemon)", async () => {
    seedUser();
    const { POST } = await import("./route");

    await POST(mkReq(baseEnvelope) as unknown as Parameters<typeof POST>[0]);

    const [device] = fake.rows("devices");
    expect(device.label).toBeNull();
  });

  it("updates the label when a subsequent ingest carries a new one", async () => {
    seedUser();
    fake.seed("devices", [
      {
        id: "11111111-1111-4111-8111-111111111111",
        user_id: "usr_test",
        label: "old-name",
        last_seen: "2026-04-14T00:00:00Z",
      },
    ]);
    const { POST } = await import("./route");

    await POST(
      mkReq({
        ...baseEnvelope,
        label: "  new-name  ",
      }) as unknown as Parameters<typeof POST>[0]
    );

    const [device] = fake.rows("devices");
    // Trimmed, case preserved, length within cap.
    expect(device.label).toBe("new-name");
  });

  it("leaves an existing label untouched when the envelope omits the field", async () => {
    seedUser();
    fake.seed("devices", [
      {
        id: "11111111-1111-4111-8111-111111111111",
        user_id: "usr_test",
        label: "already-set",
        last_seen: "2026-04-14T00:00:00Z",
      },
    ]);
    const { POST } = await import("./route");

    // No `label` key → old daemon. Must not clobber what a newer daemon set.
    await POST(mkReq(baseEnvelope) as unknown as Parameters<typeof POST>[0]);

    const [device] = fake.rows("devices");
    expect(device.label).toBe("already-set");
  });

  it("clears a stale label when the envelope explicitly sends empty string", async () => {
    seedUser();
    fake.seed("devices", [
      {
        id: "11111111-1111-4111-8111-111111111111",
        user_id: "usr_test",
        label: "going-away",
        last_seen: "2026-04-14T00:00:00Z",
      },
    ]);
    const { POST } = await import("./route");

    // Explicit opt-out: user set `label = ""` in cloud.toml. Cloud must honour
    // that and wipe the stored label, not treat it as "no update".
    await POST(
      mkReq({ ...baseEnvelope, label: "" }) as unknown as Parameters<
        typeof POST
      >[0]
    );

    const [device] = fake.rows("devices");
    expect(device.label).toBeNull();
  });

  it("caps over-long labels at 128 chars so a bad envelope can't flood the column", async () => {
    seedUser();
    const { POST } = await import("./route");

    const longLabel = "a".repeat(500);
    await POST(
      mkReq({ ...baseEnvelope, label: longLabel }) as unknown as Parameters<
        typeof POST
      >[0]
    );

    const [device] = fake.rows("devices");
    expect((device.label as string).length).toBe(128);
  });
});

describe("POST /v1/ingest — device_id squatting protections (#181)", () => {
  function seedUser() {
    fake.seed("orgs", [{ id: "org_test", name: "test" }]);
    fake.seed("users", [
      {
        id: "usr_test",
        org_id: "org_test",
        role: "manager",
        api_key: "budi_testkey",
        display_name: "Test",
        email: "t@example.com",
      },
    ]);
  }

  function mkReq(body: Record<string, unknown>): Request {
    return new Request("http://localhost/v1/ingest", {
      method: "POST",
      headers: {
        authorization: "Bearer budi_testkey",
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    });
  }

  const baseEnvelope = {
    schema_version: 1,
    device_id: "11111111-1111-4111-8111-111111111111",
    org_id: "org_test",
    synced_at: "2026-04-15T12:00:00Z",
    payload: { daily_rollups: [], session_summaries: [] },
  };

  it("rejects non-UUID device_ids with 422 so callers can't squat predictable ids", async () => {
    seedUser();
    const { POST } = await import("./route");

    const res = await POST(
      mkReq({
        ...baseEnvelope,
        device_id: "victim-org-laptop",
      }) as unknown as Parameters<typeof POST>[0]
    );

    expect(res.status).toBe(422);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/device_id must be a UUID/i);
    // No row was inserted on the way out.
    expect(fake.rows("devices")).toHaveLength(0);
  });

  it("accepts a well-formed UUID device_id and auto-registers it", async () => {
    seedUser();
    const { POST } = await import("./route");

    const res = await POST(
      mkReq(baseEnvelope) as unknown as Parameters<typeof POST>[0]
    );

    expect(res.status).toBe(200);
    expect(fake.rows("devices")).toHaveLength(1);
  });

  it("returns 429 once the org hits the auto-register cap", async () => {
    seedUser();
    // Pre-seed 50 devices already owned by this org's user — the cap is
    // exclusive, so the 51st auto-register attempt must be rejected.
    const seed = Array.from({ length: 50 }, (_, i) => ({
      id: `aaaaaaaa-aaaa-4aaa-8aaa-${String(i).padStart(12, "0")}`,
      user_id: "usr_test",
      label: null,
      first_seen: "2026-04-14T00:00:00Z",
      last_seen: "2026-04-14T00:00:00Z",
    }));
    fake.seed("devices", seed);

    const { POST } = await import("./route");
    const res = await POST(
      mkReq({
        ...baseEnvelope,
        device_id: "22222222-2222-4222-8222-222222222222",
      }) as unknown as Parameters<typeof POST>[0]
    );

    expect(res.status).toBe(429);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/device cap/i);
    // 51st row was not inserted.
    expect(fake.rows("devices")).toHaveLength(50);
  });

  it("does not apply the cap to ingest against an existing device row", async () => {
    seedUser();
    // 50 devices already, but one of them is the device the daemon is now
    // syncing against — this is the "existing device" branch, which must not
    // be blocked by the auto-register cap.
    const existingId = "11111111-1111-4111-8111-111111111111";
    const seed = Array.from({ length: 49 }, (_, i) => ({
      id: `aaaaaaaa-aaaa-4aaa-8aaa-${String(i).padStart(12, "0")}`,
      user_id: "usr_test",
      label: null,
      first_seen: "2026-04-14T00:00:00Z",
      last_seen: "2026-04-14T00:00:00Z",
    }));
    seed.push({
      id: existingId,
      user_id: "usr_test",
      label: null,
      first_seen: "2026-04-14T00:00:00Z",
      last_seen: "2026-04-14T00:00:00Z",
    });
    fake.seed("devices", seed);

    const { POST } = await import("./route");
    const res = await POST(
      mkReq(baseEnvelope) as unknown as Parameters<typeof POST>[0]
    );

    expect(res.status).toBe(200);
  });
});

describe("POST /v1/ingest — numeric metric range guards (#178)", () => {
  function seedUser() {
    fake.seed("orgs", [{ id: "org_test", name: "test" }]);
    fake.seed("users", [
      {
        id: "usr_test",
        org_id: "org_test",
        role: "manager",
        api_key: "budi_testkey",
        display_name: "Test",
        email: "t@example.com",
      },
    ]);
  }

  function mkReq(body: Record<string, unknown>): Request {
    return new Request("http://localhost/v1/ingest", {
      method: "POST",
      headers: {
        authorization: "Bearer budi_testkey",
        "content-type": "application/json",
      },
      // JSON.stringify drops NaN / Infinity to `null`, which our validator
      // catches anyway — but to exercise the *runtime* guard (not just the
      // wire-format guard) we also test via the row-builder unit cases below.
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
    input_tokens: 1,
    output_tokens: 1,
    cache_creation_tokens: 0,
    cache_read_tokens: 0,
    cost_cents: 1,
  };

  const baseEnvelope = {
    schema_version: 1,
    device_id: "11111111-1111-4111-8111-111111111111",
    org_id: "org_test",
    synced_at: "2026-04-15T12:00:00Z",
    payload: {
      daily_rollups: [baseRollup],
      session_summaries: [],
    },
  };

  it("rejects a rollup with negative cost_cents with 422", async () => {
    seedUser();
    const { POST } = await import("./route");

    const res = await POST(
      mkReq({
        ...baseEnvelope,
        payload: {
          daily_rollups: [{ ...baseRollup, cost_cents: -1 }],
          session_summaries: [],
        },
      }) as unknown as Parameters<typeof POST>[0]
    );

    expect(res.status).toBe(422);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/daily_rollups\[0\]\.cost_cents/);
    // No row landed in either table — the envelope was rejected outright.
    expect(fake.rows("daily_rollups")).toHaveLength(0);
  });

  it("rejects a rollup with non-finite token counts (Infinity)", async () => {
    seedUser();
    const { POST } = await import("./route");

    // JSON can't carry Infinity literally; build the body string manually so
    // JSON.parse sees the bare token and the validator runs against the
    // resulting `Infinity` numeric value.
    const raw = JSON.stringify({
      ...baseEnvelope,
      payload: {
        daily_rollups: [{ ...baseRollup, input_tokens: 0 }],
        session_summaries: [],
      },
    }).replace('"input_tokens":0', '"input_tokens":1e999');

    const req = new Request("http://localhost/v1/ingest", {
      method: "POST",
      headers: {
        authorization: "Bearer budi_testkey",
        "content-type": "application/json",
      },
      body: raw,
    });

    const res = await POST(req as unknown as Parameters<typeof POST>[0]);
    expect(res.status).toBe(422);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/input_tokens/);
    expect(fake.rows("daily_rollups")).toHaveLength(0);
  });

  it("rejects a session summary with a negative total_cost_cents", async () => {
    seedUser();
    const { POST } = await import("./route");

    const res = await POST(
      mkReq({
        ...baseEnvelope,
        payload: {
          daily_rollups: [],
          session_summaries: [
            {
              session_id: "s1",
              provider: "cursor",
              started_at: "2026-04-14T10:00:00Z",
              ended_at: "2026-04-14T11:00:00Z",
              duration_ms: 1,
              repo_id: null,
              git_branch: null,
              ticket: null,
              message_count: 1,
              total_input_tokens: 1,
              total_output_tokens: 1,
              total_cost_cents: -50,
            },
          ],
        },
      }) as unknown as Parameters<typeof POST>[0]
    );

    expect(res.status).toBe(422);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/session_summaries\[0\]\.total_cost_cents/);
    expect(fake.rows("session_summaries")).toHaveLength(0);
  });

  it("caps over-large token counts in stored rollups (defense-in-depth)", async () => {
    // Direct unit test against the row-builder rather than the route, so we
    // don't have to fight the route's envelope validator (which would 422
    // anything implausible). This proves the cap runs even if a future caller
    // ever skips validation — the database never sees > METRIC_CAPS values.
    const { buildRollupRows, METRIC_CAPS } = await import("./rows");

    const huge = Number.MAX_SAFE_INTEGER;
    const rows = buildRollupRows("dev_x", "2026-04-15T12:00:00Z", [
      { ...baseRollup, input_tokens: huge, cost_cents: huge },
    ]);
    expect(rows[0].input_tokens).toBe(METRIC_CAPS.input_tokens);
    // #231: ingest writes both cost columns; the cap runs identically on each.
    expect(rows[0].cost_cents_effective).toBe(METRIC_CAPS.cost_cents);
    expect(rows[0].cost_cents_ingested).toBe(METRIC_CAPS.cost_cents);
  });

  it("coerces NaN / negative metrics to 0 in the row-builder", async () => {
    const { buildRollupRows, buildSessionRows } = await import("./rows");

    const rollupRows = buildRollupRows("dev_x", "2026-04-15T12:00:00Z", [
      {
        ...baseRollup,
        message_count: Number.NaN,
        input_tokens: -1,
        output_tokens: -Infinity,
      },
    ]);
    expect(rollupRows[0].message_count).toBe(0);
    expect(rollupRows[0].input_tokens).toBe(0);
    expect(rollupRows[0].output_tokens).toBe(0);

    const sessionRows = buildSessionRows("dev_x", "2026-04-15T12:00:00Z", [
      {
        session_id: "s1",
        provider: "cursor",
        message_count: Number.NaN,
        total_input_tokens: -1,
        total_output_tokens: 0,
        total_cost_cents: Number.NaN,
      },
    ]);
    expect(sessionRows[0].message_count).toBe(0);
    expect(sessionRows[0].total_input_tokens).toBe(0);
    // #231: NaN coerces to 0 on both the daemon-ingested column and the
    // dashboard-facing effective column.
    expect(sessionRows[0].total_cost_cents_effective).toBe(0);
    expect(sessionRows[0].total_cost_cents_ingested).toBe(0);
  });

  it("truncates over-long string fields on rollups (#177)", async () => {
    const { buildRollupRows, STRING_CAPS } = await import("./rows");

    const huge = "A".repeat(50_000);
    const rows = buildRollupRows("dev_x", "2026-04-15T12:00:00Z", [
      {
        ...baseRollup,
        role: huge,
        provider: huge,
        model: huge,
        repo_id: huge,
        git_branch: huge,
        ticket: huge,
      },
    ]);

    expect(rows[0].role.length).toBe(STRING_CAPS.role);
    expect(rows[0].provider.length).toBe(STRING_CAPS.provider);
    expect(rows[0].model.length).toBe(STRING_CAPS.model);
    expect(rows[0].repo_id.length).toBe(STRING_CAPS.repo_id);
    expect(rows[0].git_branch.length).toBe(STRING_CAPS.git_branch);
    expect((rows[0].ticket as string).length).toBe(STRING_CAPS.ticket);
  });

  it("truncates over-long string fields on session summaries (#177)", async () => {
    const { buildSessionRows, STRING_CAPS } = await import("./rows");

    const huge = "B".repeat(50_000);
    const rows = buildSessionRows("dev_x", "2026-04-15T12:00:00Z", [
      {
        session_id: huge,
        provider: huge,
        repo_id: huge,
        git_branch: huge,
        ticket: huge,
        primary_model: huge,
        message_count: 1,
        total_input_tokens: 1,
        total_output_tokens: 1,
        total_cost_cents: 1,
      },
    ]);

    expect(rows[0].session_id.length).toBe(STRING_CAPS.session_id);
    expect(rows[0].provider.length).toBe(STRING_CAPS.provider);
    expect((rows[0].repo_id as string).length).toBe(STRING_CAPS.repo_id);
    expect((rows[0].git_branch as string).length).toBe(STRING_CAPS.git_branch);
    expect((rows[0].ticket as string).length).toBe(STRING_CAPS.ticket);
    expect((rows[0].main_model as string).length).toBe(STRING_CAPS.model);
  });

  it("preserves null on nullable string columns when the envelope omits them (#177)", async () => {
    const { buildRollupRows, buildSessionRows } = await import("./rows");

    const rollup = buildRollupRows("dev_x", "2026-04-15T12:00:00Z", [
      { ...baseRollup, ticket: null },
    ]);
    expect(rollup[0].ticket).toBeNull();

    const session = buildSessionRows("dev_x", "2026-04-15T12:00:00Z", [
      {
        session_id: "s1",
        provider: "cursor",
        message_count: 0,
        total_input_tokens: 0,
        total_output_tokens: 0,
        total_cost_cents: 0,
      },
    ]);
    expect(session[0].repo_id).toBeNull();
    expect(session[0].git_branch).toBeNull();
    expect(session[0].ticket).toBeNull();
    expect(session[0].main_model).toBeNull();
  });

  it("end-to-end: 50 KiB strings on every session field land truncated (#177)", async () => {
    seedUser();
    const { POST } = await import("./route");
    const { STRING_CAPS } = await import("./rows");

    const huge = "X".repeat(50_000);
    const res = await POST(
      mkReq({
        ...baseEnvelope,
        payload: {
          daily_rollups: [],
          session_summaries: [
            {
              session_id: huge,
              provider: huge,
              started_at: "2026-04-14T10:00:00Z",
              ended_at: "2026-04-14T11:00:00Z",
              duration_ms: 1,
              repo_id: huge,
              git_branch: huge,
              ticket: huge,
              message_count: 1,
              total_input_tokens: 1,
              total_output_tokens: 1,
              total_cost_cents: 1,
              primary_model: huge,
            },
          ],
        },
      }) as unknown as Parameters<typeof POST>[0]
    );

    expect(res.status).toBe(200);
    const [stored] = fake.rows("session_summaries");
    expect((stored.session_id as string).length).toBe(STRING_CAPS.session_id);
    expect((stored.provider as string).length).toBe(STRING_CAPS.provider);
    expect((stored.repo_id as string).length).toBe(STRING_CAPS.repo_id);
    expect((stored.git_branch as string).length).toBe(STRING_CAPS.git_branch);
    expect((stored.ticket as string).length).toBe(STRING_CAPS.ticket);
    expect((stored.main_model as string).length).toBe(STRING_CAPS.model);
  });

  it("accepts valid metrics at the upper plausible end", async () => {
    seedUser();
    const { POST } = await import("./route");

    const res = await POST(
      mkReq({
        ...baseEnvelope,
        payload: {
          daily_rollups: [
            {
              ...baseRollup,
              input_tokens: 1_000_000,
              output_tokens: 500_000,
              cost_cents: 12_345,
            },
          ],
          session_summaries: [],
        },
      }) as unknown as Parameters<typeof POST>[0]
    );

    expect(res.status).toBe(200);
    expect(fake.rows("daily_rollups")).toHaveLength(1);
  });
});

// Regression coverage for #204: "Spend by Surface" chart was rendering every
// dollar as Unknown because rollup rows in production all had
// `surface='unknown'`. The default kicks in only when the ingest path either
// strips the field or the daemon never serializes it. These tests pin the
// cloud's contract that envelope-supplied surfaces *do* round-trip from
// payload to row, on both the rollup and session paths, so a future
// regression (e.g. forgetting `surface` in the row-builder spread, narrowing
// `normalizeSurface`, or shrinking the upsert column list) would fail loud.
describe("POST /v1/ingest — surface round-trip (#204)", () => {
  function seedUser() {
    fake.seed("orgs", [{ id: "org_test", name: "test" }]);
    fake.seed("users", [
      {
        id: "usr_test",
        org_id: "org_test",
        role: "manager",
        api_key: "budi_testkey",
        display_name: "Test",
        email: "t@example.com",
      },
    ]);
  }

  function mkReq(body: Record<string, unknown>): Request {
    return new Request("http://localhost/v1/ingest", {
      method: "POST",
      headers: {
        authorization: "Bearer budi_testkey",
        "content-type": "application/json",
      },
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
    input_tokens: 1,
    output_tokens: 1,
    cache_creation_tokens: 0,
    cache_read_tokens: 0,
    cost_cents: 100,
  };

  const baseEnvelope = {
    schema_version: 1,
    device_id: "11111111-1111-4111-8111-111111111111",
    org_id: "org_test",
    synced_at: "2026-04-15T12:00:00Z",
  };

  it("persists each canonical surface as a distinct rollup row (#204)", async () => {
    seedUser();
    const { POST } = await import("./route");

    // Five surfaces from the daemon's `/health` advertised list (`vscode`,
    // `cursor`, `jetbrains`, `terminal`, `unknown`). Each varies only on
    // surface so the new PK (014) lets them coexist; if surface were dropped
    // they'd UPSERT-collide into a single row and #204 would re-occur.
    const surfaces = [
      "vscode",
      "cursor",
      "jetbrains",
      "terminal",
      "unknown",
    ] as const;
    const res = await POST(
      mkReq({
        ...baseEnvelope,
        payload: {
          daily_rollups: surfaces.map((s, i) => ({
            ...baseRollup,
            surface: s,
            cost_cents: 100 * (i + 1),
          })),
          session_summaries: [],
        },
      }) as unknown as Parameters<typeof POST>[0]
    );

    expect(res.status).toBe(200);
    const stored = fake.rows("daily_rollups");
    expect(stored).toHaveLength(surfaces.length);
    const storedSurfaces = stored.map((r) => r.surface as string).sort();
    expect(storedSurfaces).toEqual([...surfaces].sort());
    for (const s of surfaces) {
      expect(stored.some((r) => r.surface === s)).toBe(true);
    }
  });

  it("persists surface on session summaries (#204)", async () => {
    seedUser();
    const { POST } = await import("./route");

    const res = await POST(
      mkReq({
        ...baseEnvelope,
        payload: {
          daily_rollups: [],
          session_summaries: [
            {
              session_id: "sess-vscode",
              provider: "copilot_chat",
              started_at: "2026-04-14T10:00:00Z",
              ended_at: "2026-04-14T11:00:00Z",
              duration_ms: 3_600_000,
              repo_id: null,
              git_branch: null,
              ticket: null,
              message_count: 1,
              total_input_tokens: 1,
              total_output_tokens: 1,
              total_cost_cents: 1,
              surface: "vscode",
            },
            {
              session_id: "sess-cursor",
              provider: "copilot_chat",
              started_at: "2026-04-14T10:00:00Z",
              ended_at: "2026-04-14T11:00:00Z",
              duration_ms: 3_600_000,
              repo_id: null,
              git_branch: null,
              ticket: null,
              message_count: 1,
              total_input_tokens: 1,
              total_output_tokens: 1,
              total_cost_cents: 1,
              surface: "cursor",
            },
          ],
        },
      }) as unknown as Parameters<typeof POST>[0]
    );

    expect(res.status).toBe(200);
    const sessions = fake.rows("session_summaries");
    const bySession = Object.fromEntries(
      sessions.map((s) => [s.session_id as string, s.surface as string])
    );
    expect(bySession["sess-vscode"]).toBe("vscode");
    expect(bySession["sess-cursor"]).toBe("cursor");
  });

  it("falls back to 'unknown' when surface is omitted (forward compat with pre-#701 daemons)", async () => {
    seedUser();
    const { POST } = await import("./route");

    // Envelope with no `surface` key at all on either record — the literal
    // shape an older daemon (pre siropkin/budi#701) would send.
    const res = await POST(
      mkReq({
        ...baseEnvelope,
        payload: {
          daily_rollups: [{ ...baseRollup }],
          session_summaries: [
            {
              session_id: "sess-nosurface",
              provider: "claude_code",
              started_at: "2026-04-14T10:00:00Z",
              ended_at: "2026-04-14T11:00:00Z",
              duration_ms: 1,
              repo_id: null,
              git_branch: null,
              ticket: null,
              message_count: 1,
              total_input_tokens: 1,
              total_output_tokens: 1,
              total_cost_cents: 1,
            },
          ],
        },
      }) as unknown as Parameters<typeof POST>[0]
    );

    expect(res.status).toBe(200);
    expect(fake.rows("daily_rollups")[0].surface).toBe("unknown");
    expect(fake.rows("session_summaries")[0].surface).toBe("unknown");
  });

  it("response echoes the persisted surfaces/providers so operators can verify what the cloud actually saw (#204)", async () => {
    seedUser();
    const { POST } = await import("./route");

    const res = await POST(
      mkReq({
        ...baseEnvelope,
        payload: {
          daily_rollups: [
            { ...baseRollup, surface: "terminal", provider: "claude_code" },
            { ...baseRollup, surface: "cursor", provider: "claude_code" },
            { ...baseRollup, surface: "vscode", provider: "copilot_chat" },
          ],
          session_summaries: [
            {
              session_id: "sess-vscode",
              provider: "copilot_chat",
              started_at: "2026-04-14T10:00:00Z",
              ended_at: "2026-04-14T11:00:00Z",
              duration_ms: 1,
              repo_id: null,
              git_branch: null,
              ticket: null,
              message_count: 1,
              total_input_tokens: 1,
              total_output_tokens: 1,
              total_cost_cents: 1,
              surface: "vscode",
            },
          ],
        },
      }) as unknown as Parameters<typeof POST>[0]
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      surfaces_seen: string[];
      providers_seen: string[];
    };
    // Sorted, deduped union across both row sets.
    expect(body.surfaces_seen).toEqual(["cursor", "terminal", "vscode"]);
    expect(body.providers_seen).toEqual(["claude_code", "copilot_chat"]);
  });

  it("response collapses to ['unknown'] when no envelope row carries a surface — the receipt that confirms the bug is daemon-side, not cloud-side (#204)", async () => {
    seedUser();
    const { POST } = await import("./route");

    const res = await POST(
      mkReq({
        ...baseEnvelope,
        payload: {
          daily_rollups: [{ ...baseRollup }, { ...baseRollup, role: "user" }],
          session_summaries: [],
        },
      }) as unknown as Parameters<typeof POST>[0]
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as { surfaces_seen: string[] };
    expect(body.surfaces_seen).toEqual(["unknown"]);
  });

  it("trims whitespace and caps the stored surface at MAX_SURFACE_LENGTH", async () => {
    seedUser();
    const { POST } = await import("./route");

    const huge = "z".repeat(500);
    const res = await POST(
      mkReq({
        ...baseEnvelope,
        payload: {
          daily_rollups: [
            { ...baseRollup, surface: "  terminal  " },
            {
              ...baseRollup,
              role: "user",
              surface: huge,
            },
          ],
          session_summaries: [],
        },
      }) as unknown as Parameters<typeof POST>[0]
    );

    expect(res.status).toBe(200);
    const stored = fake.rows("daily_rollups");
    const trimmed = stored.find((r) => r.role === "assistant")!;
    expect(trimmed.surface).toBe("terminal");
    const capped = stored.find((r) => r.role === "user")!;
    // 64 is the MAX_SURFACE_LENGTH literal in rows.ts — keep this in sync if
    // that constant is ever bumped (justify in the same PR per the comment
    // above the constant).
    expect((capped.surface as string).length).toBe(64);
  });
});

// Regression for siropkin/budi#749: the daemon bumped schema_version from 1
// to 2 in #741 (to signal that `surface` is part of the wire). The cloud was
// still hard-coded to expect v1, so every v8.4.3 daemon's sync was rejected
// with HTTP 422. Both versions must round-trip; v3+ must still be rejected so
// that a future genuine wire break is caught loudly.
describe("POST /v1/ingest — schema_version compatibility (#749)", () => {
  function seedUser() {
    fake.seed("orgs", [{ id: "org_test", name: "test" }]);
    fake.seed("users", [
      {
        id: "usr_test",
        org_id: "org_test",
        role: "manager",
        api_key: "budi_testkey",
        display_name: "Test",
        email: "t@example.com",
      },
    ]);
  }

  function mkReq(body: Record<string, unknown>): Request {
    return new Request("http://localhost/v1/ingest", {
      method: "POST",
      headers: {
        authorization: "Bearer budi_testkey",
        "content-type": "application/json",
      },
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
    input_tokens: 1,
    output_tokens: 1,
    cache_creation_tokens: 0,
    cache_read_tokens: 0,
    cost_cents: 100,
  };

  const envelopeShell = {
    device_id: "11111111-1111-4111-8111-111111111111",
    org_id: "org_test",
    synced_at: "2026-04-15T12:00:00Z",
  };

  it("accepts a v1 envelope (pre-#741 daemon, no surface field)", async () => {
    seedUser();
    const { POST } = await import("./route");

    const res = await POST(
      mkReq({
        ...envelopeShell,
        schema_version: 1,
        payload: {
          daily_rollups: [baseRollup],
          session_summaries: [],
        },
      }) as unknown as Parameters<typeof POST>[0]
    );

    expect(res.status).toBe(200);
    const stored = fake.rows("daily_rollups");
    expect(stored).toHaveLength(1);
  });

  it("accepts a v2 envelope (v8.4.3+ daemon) and round-trips surface", async () => {
    seedUser();
    const { POST } = await import("./route");

    const res = await POST(
      mkReq({
        ...envelopeShell,
        schema_version: 2,
        payload: {
          daily_rollups: [{ ...baseRollup, surface: "jetbrains" }],
          session_summaries: [],
        },
      }) as unknown as Parameters<typeof POST>[0]
    );

    expect(res.status).toBe(200);
    const stored = fake.rows("daily_rollups");
    expect(stored).toHaveLength(1);
    expect(stored[0].surface).toBe("jetbrains");
  });

  it("rejects an unknown schema_version with 422", async () => {
    seedUser();
    const { POST } = await import("./route");

    const res = await POST(
      mkReq({
        ...envelopeShell,
        schema_version: 99,
        payload: {
          daily_rollups: [baseRollup],
          session_summaries: [],
        },
      }) as unknown as Parameters<typeof POST>[0]
    );

    expect(res.status).toBe(422);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toMatch(/Unsupported schema_version: 99/);
    expect(body.error).toMatch(/1, 2/);
  });
});
