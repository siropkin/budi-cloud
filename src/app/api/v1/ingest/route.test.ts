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
    if (name !== "dashboard_overview_stats") {
      return Promise.resolve({
        data: null,
        error: { message: `unsupported rpc: ${name}` },
      });
    }
    const deviceIds = new Set(args.p_device_ids as string[]);
    const from = args.p_bucket_from as string;
    const to = args.p_bucket_to as string;
    const startedFrom = args.p_started_from as string;
    const startedTo = args.p_started_to as string;
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
        total_cost_cents: acc.total_cost_cents + Number(r.cost_cents),
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
      (s) =>
        deviceIds.has(s.device_id as string) &&
        String(s.started_at ?? "") >= startedFrom &&
        String(s.started_at ?? "") <= startedTo
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
      device_id: "dev_test",
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
      device_id: "dev_test",
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
    device_id: "dev_test",
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
        id: "dev_test",
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
        id: "dev_test",
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
        id: "dev_test",
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
