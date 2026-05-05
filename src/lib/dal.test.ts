import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * Reconciliation test for #15.
 *
 * `getCostByUser` must sum to the same total as `getOverviewStats` for the
 * same (user, range). Any rollup whose device owner isn't in the viewer's
 * visible user set surfaces as an `Unassigned` row rather than silently
 * vanishing from the Team page while still being counted on Overview.
 */

type Row = Record<string, unknown>;

/**
 * Tests in this file pre-date the TZ-aware `DateRange` (#78). They construct
 * ranges in UTC for clarity, so we synthesize the SQL-side fields from the
 * local-TZ `from`/`to` rather than threading a real `Intl` timezone through
 * each fixture.
 */
function utcRange(from: string, to: string) {
  return {
    from,
    to,
    bucketFrom: from,
    bucketTo: to,
    startedAtFrom: `${from}T00:00:00.000Z`,
    startedAtTo: `${to}T23:59:59.999Z`,
  };
}

class FakeSupabase {
  tables = new Map<string, Row[]>();

  from(name: string) {
    if (!this.tables.has(name)) this.tables.set(name, []);
    return new FakeQuery(this.tables.get(name)!);
  }

  /**
   * Mirrors the SQL aggregate functions added in `004_dashboard_aggregates.sql`
   * (#92). Each handler reproduces the WHERE / GROUP BY shape of its Postgres
   * counterpart over the in-memory tables so the test contract is what the
   * server contract is — no row cap, full aggregation. A handler that drifts
   * from its SQL definition will silently mask the bug class #92 was created
   * to prevent, so both should be edited together.
   */
  rpc(name: string, args: Record<string, unknown>) {
    const handler = RPC_HANDLERS[name];
    if (!handler) {
      return Promise.resolve({
        data: null,
        error: { message: `unsupported rpc: ${name}` },
      });
    }
    return Promise.resolve({ data: handler(this.tables, args), error: null });
  }

  seed(name: string, rows: Row[]) {
    this.tables.set(name, [...rows]);
  }
}

type RpcHandler = (
  tables: Map<string, Row[]>,
  args: Record<string, unknown>
) => Row[];

function rollupsForRange(
  tables: Map<string, Row[]>,
  args: Record<string, unknown>
): Row[] {
  const deviceIds = new Set(args.p_device_ids as string[]);
  const from = args.p_bucket_from as string;
  const to = args.p_bucket_to as string;
  return (tables.get("daily_rollups") ?? []).filter(
    (r) =>
      deviceIds.has(r.device_id as string) &&
      String(r.bucket_day ?? "") >= from &&
      String(r.bucket_day ?? "") <= to
  );
}

const RPC_HANDLERS: Record<string, RpcHandler> = {
  dashboard_overview_stats(tables, args) {
    const rows = rollupsForRange(tables, args);
    const totals = rows.reduce<{
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

    const deviceIds = new Set(args.p_device_ids as string[]);
    const startedFrom = args.p_started_from as string;
    const startedTo = args.p_started_to as string;
    const total_sessions = (tables.get("session_summaries") ?? []).filter(
      (s) =>
        deviceIds.has(s.device_id as string) &&
        String(s.started_at ?? "") >= startedFrom &&
        String(s.started_at ?? "") <= startedTo
    ).length;

    return [{ ...totals, total_sessions }];
  },
  dashboard_daily_activity(tables, args) {
    const rows = rollupsForRange(tables, args);
    const byDay = new Map<
      string,
      {
        bucket_day: string;
        input_tokens: number;
        output_tokens: number;
        cost_cents: number;
        message_count: number;
      }
    >();
    for (const r of rows) {
      const day = r.bucket_day as string;
      const existing = byDay.get(day) ?? {
        bucket_day: day,
        input_tokens: 0,
        output_tokens: 0,
        cost_cents: 0,
        message_count: 0,
      };
      existing.input_tokens += Number(r.input_tokens);
      existing.output_tokens += Number(r.output_tokens);
      existing.cost_cents += Number(r.cost_cents);
      existing.message_count += Number(r.message_count);
      byDay.set(day, existing);
    }
    return Array.from(byDay.values()).sort((a, b) =>
      a.bucket_day.localeCompare(b.bucket_day)
    );
  },
  dashboard_cost_by_device(tables, args) {
    const rows = rollupsForRange(tables, args);
    const byDevice = new Map<string, number>();
    for (const r of rows) {
      const id = r.device_id as string;
      byDevice.set(id, (byDevice.get(id) ?? 0) + Number(r.cost_cents));
    }
    return Array.from(byDevice.entries()).map(([device_id, cost_cents]) => ({
      device_id,
      cost_cents,
    }));
  },
  dashboard_cost_by_model(tables, args) {
    const rows = rollupsForRange(tables, args);
    const byModel = new Map<
      string,
      { provider: string; model: string; cost_cents: number }
    >();
    for (const r of rows) {
      const provider = r.provider as string;
      const model = r.model as string;
      const key = `${provider}:${model}`;
      const existing = byModel.get(key) ?? {
        provider,
        model,
        cost_cents: 0,
      };
      existing.cost_cents += Number(r.cost_cents);
      byModel.set(key, existing);
    }
    return Array.from(byModel.values());
  },
  dashboard_cost_by_repo(tables, args) {
    const rows = rollupsForRange(tables, args);
    const byRepo = new Map<string, number>();
    for (const r of rows) {
      const id = r.repo_id as string;
      byRepo.set(id, (byRepo.get(id) ?? 0) + Number(r.cost_cents));
    }
    return Array.from(byRepo.entries()).map(([repo_id, cost_cents]) => ({
      repo_id,
      cost_cents,
    }));
  },
  dashboard_cost_by_branch(tables, args) {
    const rows = rollupsForRange(tables, args);
    const byBranch = new Map<
      string,
      { repo_id: string; git_branch: string; cost_cents: number }
    >();
    for (const r of rows) {
      const repo_id = r.repo_id as string;
      const git_branch = r.git_branch as string;
      const key = `${repo_id}:${git_branch}`;
      const existing = byBranch.get(key) ?? {
        repo_id,
        git_branch,
        cost_cents: 0,
      };
      existing.cost_cents += Number(r.cost_cents);
      byBranch.set(key, existing);
    }
    return Array.from(byBranch.values());
  },
  dashboard_cost_by_ticket(tables, args) {
    const rows = rollupsForRange(tables, args);
    const byTicket = new Map<string, number>();
    for (const r of rows) {
      const ticket = r.ticket as string | null | undefined;
      if (ticket == null) continue;
      byTicket.set(ticket, (byTicket.get(ticket) ?? 0) + Number(r.cost_cents));
    }
    return Array.from(byTicket.entries()).map(([ticket, cost_cents]) => ({
      ticket,
      cost_cents,
    }));
  },
};

/**
 * Mirrors PostgREST's default `db-max-rows` cap of 1000. Production code that
 * needs the complete row set must call `.limit(100_000)` explicitly — the same
 * defense the live API requires (#15, #90). Tests that don't seed > 1000 rows
 * are unaffected.
 */
const POSTGREST_DEFAULT_MAX_ROWS = 1000;

class FakeQuery {
  private filters: Array<(r: Row) => boolean> = [];
  private _orderKeys: Array<{ col: string; asc: boolean }> = [];
  private _limit: number | null = null;
  private _head = false;
  private _countMode: "exact" | null = null;

  constructor(private readonly rows: Row[]) {}

  select(cols?: string, opts?: { count?: "exact"; head?: boolean }) {
    void cols;
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
    if (op !== "is" || value !== null) {
      throw new Error(`unsupported not(): ${col}.${op}.${String(value)}`);
    }
    this.filters.push((r) => r[col] !== null && r[col] !== undefined);
    return this;
  }

  /**
   * Minimal PostgREST `or()` parser — supports the exact composite-cursor
   * shape `getSessions` emits: a top-level disjunction whose terms are either
   * `column.op.value` leaves or a single nested `and(...)` group of leaves.
   * Anything else throws so the test never silently accepts an unsupported
   * filter shape.
   */
  or(expr: string) {
    const predicate = parseOrExpr(expr);
    this.filters.push(predicate);
    return this;
  }

  order(col: string, opts?: { ascending?: boolean }) {
    this._orderKeys.push({ col, asc: opts?.ascending ?? true });
    return this;
  }

  limit(n: number) {
    this._limit = n;
    return this;
  }

  private materialize(): Row[] {
    let rows = this.rows.filter((r) => this.filters.every((f) => f(r)));
    if (this._orderKeys.length > 0) {
      const keys = this._orderKeys;
      rows = [...rows].sort((a, b) => {
        for (const { col, asc } of keys) {
          const av = String(a[col] ?? "");
          const bv = String(b[col] ?? "");
          if (av === bv) continue;
          return (av < bv ? -1 : 1) * (asc ? 1 : -1);
        }
        return 0;
      });
    }
    const cap = this._limit ?? POSTGREST_DEFAULT_MAX_ROWS;
    if (rows.length > cap) rows = rows.slice(0, cap);
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

  async maybeSingle() {
    const rows = this.materialize();
    if (rows.length === 0) return { data: null, error: null };
    if (rows.length === 1) return { data: rows[0], error: null };
    return {
      data: null,
      error: { message: `expected 0 or 1 row, got ${rows.length}` },
    };
  }

  then<T>(
    onFulfilled: (r: { data: Row[]; error: null; count: number | null }) => T
  ) {
    const rows = this.materialize();
    const count = this._countMode === "exact" ? rows.length : null;
    const data = this._head ? [] : rows;
    return Promise.resolve(onFulfilled({ data, error: null, count }));
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

async function loadDal() {
  return await import("@/lib/dal");
}

describe("getSyncFreshness (linking / freshness snapshot)", () => {
  const baseUser = {
    id: "usr_ivan",
    org_id: "org_solo",
    role: "manager" as const,
    api_key: "budi_x",
    display_name: "Ivan",
    email: "ivan@example.com",
  };

  it("reports not-linked when the account has no devices", async () => {
    fake.seed("orgs", [{ id: "org_solo", name: "solo" }]);
    fake.seed("users", [{ ...baseUser }]);
    fake.seed("devices", []);
    fake.seed("daily_rollups", []);

    const { getSyncFreshness } = await loadDal();
    const snap = await getSyncFreshness(baseUser);
    expect(snap).toEqual({
      deviceCount: 0,
      lastSeenAt: null,
      lastRollupAt: null,
      lastSessionAt: null,
    });
  });

  it("reports linked-but-no-rollups when devices exist but nothing has been ingested", async () => {
    fake.seed("orgs", [{ id: "org_solo", name: "solo" }]);
    fake.seed("users", [{ ...baseUser }]);
    fake.seed("devices", [
      {
        id: "dev_laptop",
        user_id: "usr_ivan",
        last_seen: "2026-04-18T11:00:00Z",
      },
    ]);
    fake.seed("daily_rollups", []);

    const { getSyncFreshness } = await loadDal();
    const snap = await getSyncFreshness(baseUser);
    expect(snap.deviceCount).toBe(1);
    expect(snap.lastSeenAt).toBe("2026-04-18T11:00:00Z");
    expect(snap.lastRollupAt).toBeNull();
    expect(snap.lastSessionAt).toBeNull();
  });

  it("reports the most recent rollup synced_at across the viewer's own devices", async () => {
    fake.seed("orgs", [{ id: "org_solo", name: "solo" }]);
    fake.seed("users", [{ ...baseUser }]);
    fake.seed("devices", [
      {
        id: "dev_laptop",
        user_id: "usr_ivan",
        last_seen: "2026-04-18T11:00:00Z",
      },
      {
        id: "dev_desktop",
        user_id: "usr_ivan",
        last_seen: "2026-04-17T11:00:00Z",
      },
    ]);
    fake.seed("daily_rollups", [
      rollup("dev_laptop", "2026-04-18", 100, {
        synced_at: "2026-04-18T10:30:00Z",
      }),
      rollup("dev_desktop", "2026-04-17", 50, {
        synced_at: "2026-04-17T09:00:00Z",
      }),
    ]);

    const { getSyncFreshness } = await loadDal();
    const snap = await getSyncFreshness(baseUser);
    expect(snap.deviceCount).toBe(2);
    expect(snap.lastSeenAt).toBe("2026-04-18T11:00:00Z");
    expect(snap.lastRollupAt).toBe("2026-04-18T10:30:00Z");
  });

  it("(#84) probes the most recent session_summaries.started_at across the viewer's own devices", async () => {
    // Reproduces the bug: rollups keep landing (synced_at = today) while
    // sessions stop ingesting (started_at frozen 3 days ago). Without the
    // session probe the header showed "Synced 2m ago" while the Sessions
    // page silently returned zero rows.
    fake.seed("orgs", [{ id: "org_solo", name: "solo" }]);
    fake.seed("users", [{ ...baseUser }]);
    fake.seed("devices", [
      {
        id: "dev_laptop",
        user_id: "usr_ivan",
        last_seen: "2026-04-29T15:00:00Z",
      },
    ]);
    fake.seed("daily_rollups", [
      rollup("dev_laptop", "2026-04-29", 100, {
        synced_at: "2026-04-29T14:55:00Z",
      }),
    ]);
    fake.seed("session_summaries", [
      {
        device_id: "dev_laptop",
        session_id: "sess_old",
        started_at: "2026-04-26T17:07:00Z",
      },
      {
        device_id: "dev_laptop",
        session_id: "sess_older",
        started_at: "2026-04-17T21:11:00Z",
      },
    ]);

    const { getSyncFreshness } = await loadDal();
    const snap = await getSyncFreshness(baseUser);
    expect(snap.lastRollupAt).toBe("2026-04-29T14:55:00Z");
    expect(snap.lastSessionAt).toBe("2026-04-26T17:07:00Z");
  });

  it("(#84) lastSessionAt is scoped to the viewer's own devices, not the org", async () => {
    // Same self-trust contract as #74 for rollups: a manager whose own
    // daemon stopped sending sessions should see the divergence even when a
    // teammate's daemon is still pushing fresh sessions.
    fake.seed("orgs", [{ id: "org_team", name: "team" }]);
    fake.seed("users", [
      { ...baseUser, org_id: "org_team" },
      {
        id: "usr_teammate",
        org_id: "org_team",
        role: "member",
        api_key: "budi_t",
        display_name: "Teammate",
        email: "teammate@example.com",
      },
    ]);
    fake.seed("devices", [
      {
        id: "dev_my_mac",
        user_id: "usr_ivan",
        last_seen: "2026-04-29T15:00:00Z",
      },
      {
        id: "dev_teammate_mac",
        user_id: "usr_teammate",
        last_seen: "2026-04-29T15:00:00Z",
      },
    ]);
    fake.seed("session_summaries", [
      {
        device_id: "dev_my_mac",
        session_id: "sess_mine_old",
        started_at: "2026-04-26T17:00:00Z",
      },
      {
        device_id: "dev_teammate_mac",
        session_id: "sess_teammate_fresh",
        started_at: "2026-04-29T14:55:00Z",
      },
    ]);

    const { getSyncFreshness } = await loadDal();
    const snap = await getSyncFreshness({ ...baseUser, org_id: "org_team" });
    expect(snap.lastSessionAt).toBe("2026-04-26T17:00:00Z");
  });

  it("(#74) badge ignores teammates' devices for a manager — own daemon stale, teammate daemon fresh", async () => {
    // Regression for the bug surfaced 2026-04-27: a manager's header badge
    // showed "Synced 3m ago" because a teammate's daemon had just pushed,
    // masking the fact that the manager's own daemon hadn't synced in 2h.
    // The freshness signal is read as self-trust ("is *my* daemon healthy");
    // teammate state belongs on /dashboard/devices, not in the header.
    fake.seed("orgs", [{ id: "org_team", name: "team" }]);
    fake.seed("users", [
      { ...baseUser, org_id: "org_team" },
      {
        id: "usr_teammate",
        org_id: "org_team",
        role: "member",
        api_key: "budi_t",
        display_name: "Teammate",
        email: "teammate@example.com",
      },
    ]);
    fake.seed("devices", [
      {
        id: "dev_my_mac",
        user_id: "usr_ivan",
        last_seen: "2026-04-18T10:00:00Z", // 2h ago
      },
      {
        id: "dev_teammate_mac",
        user_id: "usr_teammate",
        last_seen: "2026-04-18T11:57:00Z", // 3m ago — would win an org-wide MAX
      },
    ]);
    fake.seed("daily_rollups", [
      rollup("dev_my_mac", "2026-04-18", 100, {
        synced_at: "2026-04-18T10:00:00Z",
      }),
      rollup("dev_teammate_mac", "2026-04-18", 50, {
        synced_at: "2026-04-18T11:57:00Z",
      }),
    ]);

    const { getSyncFreshness } = await loadDal();
    const snap = await getSyncFreshness({ ...baseUser, org_id: "org_team" });

    expect(snap.deviceCount).toBe(1); // own devices only — teammate's doesn't count
    expect(snap.lastSeenAt).toBe("2026-04-18T10:00:00Z"); // mine, not teammate's
    expect(snap.lastRollupAt).toBe("2026-04-18T10:00:00Z");
  });

  it("(#74) reports not-linked for a manager whose org has teammate devices but no own daemon", async () => {
    // The LinkDaemonBanner gating keys off deviceCount===0; previously a
    // manager who hadn't run `budi cloud init` themselves wouldn't see the
    // prompt because teammates had linked, masking their own missing setup.
    fake.seed("orgs", [{ id: "org_team", name: "team" }]);
    fake.seed("users", [
      { ...baseUser, org_id: "org_team" },
      {
        id: "usr_teammate",
        org_id: "org_team",
        role: "member",
        api_key: "budi_t",
        display_name: "Teammate",
        email: "teammate@example.com",
      },
    ]);
    fake.seed("devices", [
      {
        id: "dev_teammate_mac",
        user_id: "usr_teammate",
        last_seen: "2026-04-18T11:57:00Z",
      },
    ]);

    const { getSyncFreshness } = await loadDal();
    const snap = await getSyncFreshness({ ...baseUser, org_id: "org_team" });
    expect(snap).toEqual({
      deviceCount: 0,
      lastSeenAt: null,
      lastRollupAt: null,
      lastSessionAt: null,
    });
  });
});

describe("Overview ↔ Team reconciliation (#15)", () => {
  it("single-member org: org_total === sum(member_totals)", async () => {
    fake.seed("orgs", [{ id: "org_solo", name: "solo" }]);
    fake.seed("users", [
      {
        id: "usr_ivan",
        org_id: "org_solo",
        role: "manager",
        api_key: "budi_x",
        display_name: "Ivan",
        email: "ivan@example.com",
      },
    ]);
    fake.seed("devices", [
      { id: "dev_laptop", user_id: "usr_ivan" },
      { id: "dev_desktop", user_id: "usr_ivan" },
    ]);
    fake.seed(
      "daily_rollups",
      // Over 30 days * a handful of dimensions we generate 1200 rows, which
      // exceeds the default PostgREST max-rows cap (1000) — the cap was a
      // plausible cause of the Overview vs Team drift in #15. The explicit
      // `.limit(100_000)` in `getOverviewStats` / `getCostByUser` should
      // keep both queries summing the identical complete row set.
      Array.from({ length: 1200 }, (_, i) =>
        rollup(i % 2 === 0 ? "dev_laptop" : "dev_desktop", "2026-04-10", 100, {
          model: `model-${i}`,
          git_branch: `branch-${i}`,
        })
      )
    );

    const { getOverviewStats, getCostByUser } = await loadDal();

    const user = {
      id: "usr_ivan",
      org_id: "org_solo",
      role: "manager",
      api_key: "budi_x",
      display_name: "Ivan",
      email: "ivan@example.com",
    };
    const range = utcRange("2026-04-01", "2026-04-30");

    const overview = await getOverviewStats(user, range);
    const byUser = await getCostByUser(user, range);

    const byUserTotal = byUser.reduce((s, u) => s + u.cost_cents, 0);

    expect(overview.totalCostCents).toBe(1200 * 100);
    expect(byUserTotal).toBe(overview.totalCostCents);

    // Single member: one named row, no Unassigned surfaces.
    expect(byUser).toHaveLength(1);
    expect(byUser[0].name).toBe("Ivan");
  });

  it("multi-member org still reconciles and keeps Unassigned (when present) last", async () => {
    fake.seed("orgs", [{ id: "org_team", name: "team" }]);
    fake.seed("users", [
      {
        id: "usr_ivan",
        org_id: "org_team",
        role: "manager",
        api_key: "budi_i",
        display_name: "Ivan",
        email: "ivan@example.com",
      },
      {
        id: "usr_jane",
        org_id: "org_team",
        role: "member",
        api_key: "budi_j",
        display_name: "Jane",
        email: "jane@example.com",
      },
    ]);
    fake.seed("devices", [
      { id: "dev_ivan", user_id: "usr_ivan" },
      { id: "dev_jane", user_id: "usr_jane" },
    ]);
    fake.seed("daily_rollups", [
      rollup("dev_ivan", "2026-04-10", 2500_00),
      rollup("dev_jane", "2026-04-10", 1500_00),
    ]);

    const { getOverviewStats, getCostByUser } = await loadDal();

    const manager = {
      id: "usr_ivan",
      org_id: "org_team",
      role: "manager",
      api_key: "budi_i",
      display_name: "Ivan",
      email: "ivan@example.com",
    };
    const range = utcRange("2026-04-01", "2026-04-30");

    const overview = await getOverviewStats(manager, range);
    const byUser = await getCostByUser(manager, range);

    expect(byUser.reduce((s, u) => s + u.cost_cents, 0)).toBe(
      overview.totalCostCents
    );
    expect(byUser.map((b) => b.name)).toEqual(["Ivan", "Jane"]);

    // And a member viewer only sees their own row, with the rest not
    // surfacing (they aren't in the member's visible device set by design).
    const jane = {
      id: "usr_jane",
      org_id: "org_team",
      role: "member",
      api_key: "budi_j",
      display_name: "Jane",
      email: "jane@example.com",
    };
    const janeOverview = await getOverviewStats(jane, range);
    const janeByUser = await getCostByUser(jane, range);
    expect(janeByUser.reduce((s, u) => s + u.cost_cents, 0)).toBe(
      janeOverview.totalCostCents
    );
    expect(janeOverview.totalCostCents).toBe(1500_00);
    expect(janeByUser).toEqual([
      {
        id: "usr_jane",
        name: "Jane",
        cost_cents: 1500_00,
        input_tokens: 0,
        output_tokens: 0,
      },
    ]);
  });
});

describe("PostgREST 1000-row cap on chart and breakdown queries (#90)", () => {
  // Same shape as the #15 fixture: > 1000 rollup rows in the window. The
  // sibling chart / breakdown queries (`getDailyActivity`, `getCostByModel`,
  // `getCostByRepo`, `getCostByBranch`, `getCostByTicket`) silently truncated
  // to the first 1000 rows ordered by `bucket_day` ascending, so the daily
  // chart's x-axis cliff-edged ~7 days short of "today" and breakdown totals
  // were understated. Each query must now match the row-set sum from
  // `getOverviewStats`.
  function seedSoloOrgWith1200Rollups() {
    fake.seed("orgs", [{ id: "org_solo", name: "solo" }]);
    fake.seed("users", [
      {
        id: "usr_ivan",
        org_id: "org_solo",
        role: "manager",
        api_key: "budi_x",
        display_name: "Ivan",
        email: "ivan@example.com",
      },
    ]);
    fake.seed("devices", [
      { id: "dev_laptop", user_id: "usr_ivan" },
      { id: "dev_desktop", user_id: "usr_ivan" },
    ]);
    fake.seed(
      "daily_rollups",
      Array.from({ length: 1200 }, (_, i) => {
        // Spread across 30 days so the daily series exposes any prefix
        // truncation at the most-recent end.
        const day = `2026-04-${String((i % 30) + 1).padStart(2, "0")}`;
        return rollup(i % 2 === 0 ? "dev_laptop" : "dev_desktop", day, 100, {
          model: `model-${i % 50}`,
          repo_id: `repo-${i % 25}`,
          git_branch: `branch-${i}`,
          ticket: `TICKET-${i % 40}`,
        });
      })
    );
  }

  const user = {
    id: "usr_ivan",
    org_id: "org_solo",
    role: "manager" as const,
    api_key: "budi_x",
    display_name: "Ivan",
    email: "ivan@example.com",
  };
  const range = utcRange("2026-04-01", "2026-04-30");

  it("getDailyActivity returns every day in the window (no most-recent cliff)", async () => {
    seedSoloOrgWith1200Rollups();

    const { getDailyActivity } = await loadDal();
    const series = await getDailyActivity(user, range);

    expect(series).toHaveLength(30);
    expect(series[0].bucket_day).toBe("2026-04-01");
    expect(series[series.length - 1].bucket_day).toBe("2026-04-30");
    const totalCost = series.reduce((s, d) => s + d.cost_cents, 0);
    expect(totalCost).toBe(1200 * 100);
  });

  it("getCostByModel sums the full row set", async () => {
    seedSoloOrgWith1200Rollups();

    const { getCostByModel } = await loadDal();
    const byModel = await getCostByModel(user, range);

    expect(byModel.reduce((s, m) => s + m.cost_cents, 0)).toBe(1200 * 100);
  });

  it("getCostByRepo sums the full row set", async () => {
    seedSoloOrgWith1200Rollups();

    const { getCostByRepo } = await loadDal();
    const byRepo = await getCostByRepo(user, range);

    expect(byRepo.reduce((s, r) => s + r.cost_cents, 0)).toBe(1200 * 100);
  });

  it("getCostByBranch sums the full row set", async () => {
    seedSoloOrgWith1200Rollups();

    const { getCostByBranch } = await loadDal();
    const byBranch = await getCostByBranch(user, range);

    expect(byBranch.reduce((s, b) => s + b.cost_cents, 0)).toBe(1200 * 100);
  });

  it("getCostByTicket sums the full row set", async () => {
    seedSoloOrgWith1200Rollups();

    const { getCostByTicket } = await loadDal();
    const byTicket = await getCostByTicket(user, range);

    expect(byTicket.reduce((s, t) => s + t.cost_cents, 0)).toBe(1200 * 100);
  });
});

describe("server-side aggregation (#92)", () => {
  // PR #90 raised the row cap from 1,000 to 100,000, but a real org with
  // `device × day × role × provider × model × repo_id × git_branch`
  // cardinality crosses 100,000 the same way it crossed 1,000. Bumping the
  // ceiling never closes the bug class — every breakdown must aggregate
  // server-side so no row count is exposed to the app at all. The fixture
  // here is sized just above the prior 100,000 ceiling so a regression that
  // reintroduces a JS-side reduce-with-`.limit(N)` would fail this test.
  const ROLLUP_COUNT = 100_500;

  // Deterministic distribution so every assertion is exact rather than
  // approximate: each user gets a fixed share of the row count, each row
  // contributes one unit of cost, and the daily spread is bounded so we can
  // assert sums per-window without re-counting the fixture.
  function seedAtScale() {
    fake.seed("orgs", [{ id: "org_team", name: "team" }]);
    fake.seed("users", [
      {
        id: "usr_ivan",
        org_id: "org_team",
        role: "manager",
        api_key: "budi_i",
        display_name: "Ivan",
        email: "ivan@example.com",
      },
      {
        id: "usr_jane",
        org_id: "org_team",
        role: "member",
        api_key: "budi_j",
        display_name: "Jane",
        email: "jane@example.com",
      },
    ]);
    fake.seed("devices", [
      { id: "dev_ivan", user_id: "usr_ivan" },
      { id: "dev_jane", user_id: "usr_jane" },
    ]);

    // Spread across 60 days (March 1 → April 29) so 7d / 30d / All cleanly
    // partition the row set and we can reason about subset relationships.
    fake.seed(
      "daily_rollups",
      Array.from({ length: ROLLUP_COUNT }, (_, i) => {
        const dayIndex = i % 60;
        const start = new Date(Date.UTC(2026, 2, 1));
        start.setUTCDate(start.getUTCDate() + dayIndex);
        const day = start.toISOString().slice(0, 10);
        return rollup(i % 2 === 0 ? "dev_ivan" : "dev_jane", day, 100, {
          // Wide cardinality on the rollup PK so a buggy reintroduction of a
          // 100k cap would truncate rather than coincidentally pass.
          model: `model-${i % 50}`,
          repo_id: `repo-${i % 25}`,
          git_branch: `branch-${i % 1000}`,
          ticket: `TICKET-${i % 40}`,
        });
      })
    );
  }

  const manager = {
    id: "usr_ivan",
    org_id: "org_team",
    role: "manager" as const,
    api_key: "budi_i",
    display_name: "Ivan",
    email: "ivan@example.com",
  };

  it("breakdown sums equal Overview total beyond the prior 100k cap", async () => {
    // Acceptance criterion (a): per-user breakdown sums equal overview total
    // for the same (user, range).
    seedAtScale();
    const range = utcRange("2026-03-01", "2026-04-30");

    const {
      getOverviewStats,
      getCostByUser,
      getCostByDevice,
      getCostByModel,
      getCostByRepo,
      getCostByBranch,
      getCostByTicket,
      getDailyActivity,
    } = await loadDal();

    const overview = await getOverviewStats(manager, range);
    const expected = ROLLUP_COUNT * 100;
    expect(overview.totalCostCents).toBe(expected);

    const byUser = await getCostByUser(manager, range);
    expect(byUser.reduce((s, u) => s + u.cost_cents, 0)).toBe(expected);

    const byDevice = await getCostByDevice(manager, range);
    expect(byDevice.reduce((s, d) => s + d.cost_cents, 0)).toBe(expected);

    const byModel = await getCostByModel(manager, range);
    expect(byModel.reduce((s, m) => s + m.cost_cents, 0)).toBe(expected);

    const byRepo = await getCostByRepo(manager, range);
    expect(byRepo.reduce((s, r) => s + r.cost_cents, 0)).toBe(expected);

    const byBranch = await getCostByBranch(manager, range);
    expect(byBranch.reduce((s, b) => s + b.cost_cents, 0)).toBe(expected);

    const byTicket = await getCostByTicket(manager, range);
    expect(byTicket.reduce((s, t) => s + t.cost_cents, 0)).toBe(expected);

    const series = await getDailyActivity(manager, range);
    expect(series.reduce((s, d) => s + d.cost_cents, 0)).toBe(expected);
  });

  it("per-user breakdowns are monotonic across 7d ⊆ 30d ⊆ All windows", async () => {
    // Acceptance criterion (b). Under the prior pull-and-reduce pattern a
    // wider window could return a *smaller* sum because which rollups
    // survived the row cap was window-dependent.
    seedAtScale();

    const { getCostByUser } = await loadDal();
    const week = await getCostByUser(
      manager,
      utcRange("2026-04-23", "2026-04-29")
    );
    const month = await getCostByUser(
      manager,
      utcRange("2026-03-31", "2026-04-29")
    );
    const all = await getCostByUser(
      manager,
      utcRange("2026-03-01", "2026-04-30")
    );

    function ivanCost(rows: Array<{ id: string; cost_cents: number }>) {
      return rows.find((r) => r.id === "usr_ivan")?.cost_cents ?? 0;
    }
    const ivanWeek = ivanCost(week);
    const ivanMonth = ivanCost(month);
    const ivanAll = ivanCost(all);

    expect(ivanWeek).toBeGreaterThan(0);
    expect(ivanMonth).toBeGreaterThanOrEqual(ivanWeek);
    expect(ivanAll).toBeGreaterThanOrEqual(ivanMonth);
  });

  it("getDailyActivity covers the full window — no leftmost-day truncation", async () => {
    // Acceptance criterion: leftmost day equals the seeded earliest day.
    // The pre-#92 `.order("bucket_day").limit(100_000)` would have silently
    // dropped the most-recent days at scale, but past 100k rollup rows
    // matching the predicate the cliff appears regardless of order direction.
    seedAtScale();

    const { getDailyActivity } = await loadDal();
    const series = await getDailyActivity(
      manager,
      utcRange("2026-03-01", "2026-04-30")
    );

    expect(series[0].bucket_day).toBe("2026-03-01");
    expect(series[series.length - 1].bucket_day).toBe("2026-04-29");
    expect(series).toHaveLength(60);
  });

  it("a single device's All-window cost equals the sum across its daily activity", async () => {
    // Acceptance criterion (c): the smoking gun in the bug report — a single
    // device's total is window/scope-dependent under truncation. Once
    // aggregation is server-side, the per-device total reconciles with the
    // per-day series for the same device, scoped or unscoped.
    seedAtScale();

    const range = utcRange("2026-03-01", "2026-04-30");
    const { getCostByDevice, getDailyActivity } = await loadDal();

    const byDevice = await getCostByDevice(manager, range);
    const ivanDeviceCost =
      byDevice.find((d) => d.id === "dev_ivan")?.cost_cents ?? 0;

    // Same device through the user-scoped path: rollups survive a different
    // device-id filter and still sum to the same number once aggregation is
    // server-side. Pre-#92 these two paths diverged because the row cap
    // truncated each query independently.
    const scopedSeries = await getDailyActivity(manager, range, {
      scopedUserId: "usr_ivan",
    });
    const scopedTotal = scopedSeries.reduce((s, d) => s + d.cost_cents, 0);

    expect(ivanDeviceCost).toBeGreaterThan(0);
    expect(ivanDeviceCost).toBe(scopedTotal);
  });
});

describe("getCostByDevice", () => {
  it("manager sees every device, annotates owner, and reconciles with Overview", async () => {
    fake.seed("orgs", [{ id: "org_team", name: "team" }]);
    fake.seed("users", [
      {
        id: "usr_ivan",
        org_id: "org_team",
        role: "manager",
        api_key: "budi_i",
        display_name: "Ivan",
        email: "ivan@example.com",
      },
      {
        id: "usr_jane",
        org_id: "org_team",
        role: "member",
        api_key: "budi_j",
        display_name: "Jane",
        email: "jane@example.com",
      },
    ]);
    fake.seed("devices", [
      {
        id: "dev_ivan_laptop",
        user_id: "usr_ivan",
        label: "laptop",
        last_seen: "2026-04-23T10:00:00Z",
      },
      {
        id: "dev_ivan_desktop",
        user_id: "usr_ivan",
        label: null,
        last_seen: "2026-04-20T09:00:00Z",
      },
      {
        id: "dev_jane_laptop",
        user_id: "usr_jane",
        label: "laptop",
        last_seen: "2026-04-22T12:00:00Z",
      },
    ]);
    fake.seed("daily_rollups", [
      rollup("dev_ivan_laptop", "2026-04-10", 800_00),
      rollup("dev_ivan_laptop", "2026-04-11", 400_00),
      rollup("dev_jane_laptop", "2026-04-10", 1500_00),
      // dev_ivan_desktop has zero rollups — it should still surface so a
      // freshly-linked daemon isn't invisible.
    ]);

    const { getOverviewStats, getCostByDevice } = await loadDal();

    const manager = {
      id: "usr_ivan",
      org_id: "org_team",
      role: "manager",
      api_key: "budi_i",
      display_name: "Ivan",
      email: "ivan@example.com",
    };
    const range = utcRange("2026-04-01", "2026-04-30");

    const byDevice = await getCostByDevice(manager, range);
    const overview = await getOverviewStats(manager, range);

    // Every org device is listed, sorted by cost desc, zero-cost rows last.
    expect(byDevice.map((d) => d.id)).toEqual([
      "dev_jane_laptop",
      "dev_ivan_laptop",
      "dev_ivan_desktop",
    ]);
    expect(byDevice.map((d) => d.cost_cents)).toEqual([1500_00, 1200_00, 0]);

    // Owner is annotated for the manager view; same-label laptops under
    // different owners stay distinguishable.
    const jane = byDevice.find((d) => d.id === "dev_jane_laptop");
    expect(jane?.owner_name).toBe("Jane");
    const ivanLaptop = byDevice.find((d) => d.id === "dev_ivan_laptop");
    expect(ivanLaptop?.owner_name).toBe("Ivan");

    // Sum of device costs matches Overview total for the same (user, range).
    expect(byDevice.reduce((s, d) => s + d.cost_cents, 0)).toBe(
      overview.totalCostCents
    );
  });

  it("member only sees their own device and leaves owner_name unset", async () => {
    fake.seed("orgs", [{ id: "org_team", name: "team" }]);
    fake.seed("users", [
      {
        id: "usr_ivan",
        org_id: "org_team",
        role: "manager",
        api_key: "budi_i",
        display_name: "Ivan",
        email: "ivan@example.com",
      },
      {
        id: "usr_jane",
        org_id: "org_team",
        role: "member",
        api_key: "budi_j",
        display_name: "Jane",
        email: "jane@example.com",
      },
    ]);
    fake.seed("devices", [
      { id: "dev_ivan", user_id: "usr_ivan", label: "ivan-mbp" },
      { id: "dev_jane", user_id: "usr_jane", label: "jane-mbp" },
    ]);
    fake.seed("daily_rollups", [
      rollup("dev_ivan", "2026-04-10", 800_00),
      rollup("dev_jane", "2026-04-10", 1500_00),
    ]);

    const { getCostByDevice } = await loadDal();

    const jane = {
      id: "usr_jane",
      org_id: "org_team",
      role: "member",
      api_key: "budi_j",
      display_name: "Jane",
      email: "jane@example.com",
    };
    const byDevice = await getCostByDevice(
      jane,
      utcRange("2026-04-01", "2026-04-30")
    );

    expect(byDevice).toEqual([
      {
        id: "dev_jane",
        label: "jane-mbp",
        owner_name: null,
        last_seen: null,
        cost_cents: 1500_00,
        input_tokens: 0,
        output_tokens: 0,
      },
    ]);
  });
});

describe("per-user scoping (#80)", () => {
  // Three-org world so we can prove that an out-of-org id silently collapses
  // to the org-wide view and never leaks the other org's data.
  function seedTwoOrgs() {
    fake.seed("orgs", [
      { id: "org_team", name: "team" },
      { id: "org_other", name: "other" },
    ]);
    fake.seed("users", [
      {
        id: "usr_ivan",
        org_id: "org_team",
        role: "manager",
        api_key: "budi_i",
        display_name: "Ivan",
        email: "ivan@example.com",
      },
      {
        id: "usr_jane",
        org_id: "org_team",
        role: "member",
        api_key: "budi_j",
        display_name: "Jane",
        email: "jane@example.com",
      },
      {
        id: "usr_outsider",
        org_id: "org_other",
        role: "manager",
        api_key: "budi_o",
        display_name: "Outsider",
        email: "outsider@example.com",
      },
    ]);
    fake.seed("devices", [
      { id: "dev_ivan", user_id: "usr_ivan", label: "ivan-mbp" },
      { id: "dev_jane", user_id: "usr_jane", label: "jane-mbp" },
      { id: "dev_outsider", user_id: "usr_outsider", label: "outsider-mbp" },
    ]);
    fake.seed("daily_rollups", [
      rollup("dev_ivan", "2026-04-10", 800_00),
      rollup("dev_jane", "2026-04-10", 1500_00),
      rollup("dev_outsider", "2026-04-10", 9000_00),
    ]);
  }

  const manager = {
    id: "usr_ivan",
    org_id: "org_team",
    role: "manager",
    api_key: "budi_i",
    display_name: "Ivan",
    email: "ivan@example.com",
  };
  const range = utcRange("2026-04-01", "2026-04-30");

  it("manager: scopedUserId narrows breakdowns to that teammate's data", async () => {
    seedTwoOrgs();
    const { getOverviewStats, getCostByDevice } = await loadDal();

    const overview = await getOverviewStats(manager, range, {
      scopedUserId: "usr_jane",
    });
    expect(overview.totalCostCents).toBe(1500_00);

    const byDevice = await getCostByDevice(manager, range, {
      scopedUserId: "usr_jane",
    });
    expect(byDevice.map((d) => d.id)).toEqual(["dev_jane"]);
    expect(byDevice[0].cost_cents).toBe(1500_00);
  });

  it("manager: scopedUserId for an out-of-org user silently falls back to org-wide", async () => {
    // Defense in depth — the URL parameter must not leak `org_other`'s 9000$
    // bucket. Falling back to org-wide preserves the manager's own visibility
    // without confirming that `usr_outsider` exists.
    seedTwoOrgs();
    const { getOverviewStats } = await loadDal();

    const scoped = await getOverviewStats(manager, range, {
      scopedUserId: "usr_outsider",
    });
    const orgWide = await getOverviewStats(manager, range);
    expect(scoped.totalCostCents).toBe(orgWide.totalCostCents);
    expect(scoped.totalCostCents).toBe(800_00 + 1500_00);
  });

  it("manager: missing/empty scopedUserId is the same as org-wide", async () => {
    seedTwoOrgs();
    const { getOverviewStats } = await loadDal();

    const noScope = await getOverviewStats(manager, range);
    const emptyScope = await getOverviewStats(manager, range, {
      scopedUserId: null,
    });
    expect(emptyScope.totalCostCents).toBe(noScope.totalCostCents);
  });

  it("member: scopedUserId is ignored — they only ever see their own devices", async () => {
    // ADR-0083 §6: members are DAL-scoped to themselves. Even if a member
    // crafts `?user=usr_ivan` they must not see Ivan's data.
    seedTwoOrgs();
    const { getOverviewStats } = await loadDal();

    const jane = {
      id: "usr_jane",
      org_id: "org_team",
      role: "member",
      api_key: "budi_j",
      display_name: "Jane",
      email: "jane@example.com",
    };
    const scoped = await getOverviewStats(jane, range, {
      scopedUserId: "usr_ivan",
    });
    expect(scoped.totalCostCents).toBe(1500_00);
  });
});

function rollup(
  deviceId: string,
  bucketDay: string,
  costCents: number,
  overrides: Partial<Row> = {}
): Row {
  return {
    device_id: deviceId,
    bucket_day: bucketDay,
    role: "assistant",
    provider: "claude_code",
    model: "claude-sonnet-4-5",
    repo_id: "repo_x",
    git_branch: "refs/heads/main",
    ticket: null,
    message_count: 1,
    input_tokens: 10,
    output_tokens: 5,
    cache_creation_tokens: 0,
    cache_read_tokens: 0,
    cost_cents: costCents,
    synced_at: "2026-04-16T00:00:00Z",
    ...overrides,
  };
}

// --- PostgREST or() parser used by FakeQuery.or() ------------------------

function parseOrExpr(expr: string): (r: Row) => boolean {
  const terms = splitTopLevel(expr, ",").map((t) => t.trim());
  const fns = terms.map(parseTerm);
  return (r) => fns.some((f) => f(r));
}

function parseTerm(term: string): (r: Row) => boolean {
  if (term.startsWith("and(") && term.endsWith(")")) {
    const inner = term.slice(4, -1);
    const leaves = splitTopLevel(inner, ",").map(parseLeaf);
    return (r) => leaves.every((f) => f(r));
  }
  return parseLeaf(term);
}

function parseLeaf(term: string): (r: Row) => boolean {
  const m = /^([^.]+)\.([^.]+)\.(.*)$/.exec(term);
  if (!m) throw new Error(`bad or() leaf: ${term}`);
  const [, col, op, valRaw] = m;
  const val =
    valRaw.startsWith('"') && valRaw.endsWith('"')
      ? valRaw.slice(1, -1)
      : valRaw;
  return (r) => {
    const cell = String(r[col] ?? "");
    if (op === "eq") return cell === val;
    if (op === "lt") return cell < val;
    if (op === "lte") return cell <= val;
    if (op === "gt") return cell > val;
    if (op === "gte") return cell >= val;
    throw new Error(`unsupported or() op: ${op}`);
  };
}

function splitTopLevel(s: string, sep: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === "(") depth++;
    else if (ch === ")") depth--;
    else if (depth === 0 && ch === sep) {
      parts.push(s.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(s.slice(start));
  return parts;
}

describe("getSessionDetail (#99)", () => {
  const manager = {
    id: "usr_ivan",
    org_id: "org_team",
    role: "manager" as const,
    api_key: "budi_i",
    display_name: "Ivan",
    email: "ivan@example.com",
  };

  function seedSession(extras: Partial<Row> = {}) {
    fake.seed("orgs", [{ id: "org_team", name: "team" }]);
    fake.seed("users", [
      { ...manager },
      {
        id: "usr_jane",
        org_id: "org_team",
        role: "member",
        api_key: "budi_j",
        display_name: "Jane",
        email: "jane@example.com",
      },
      {
        id: "usr_outsider",
        org_id: "org_other",
        role: "manager",
        api_key: "budi_o",
        display_name: "Outsider",
        email: "outsider@example.com",
      },
    ]);
    fake.seed("orgs", [
      { id: "org_team", name: "team" },
      { id: "org_other", name: "other" },
    ]);
    fake.seed("devices", [
      { id: "dev_ivan", user_id: "usr_ivan" },
      { id: "dev_jane", user_id: "usr_jane" },
      { id: "dev_outsider", user_id: "usr_outsider" },
    ]);
    fake.seed("session_summaries", [
      {
        device_id: "dev_ivan",
        session_id: "sess_v",
        provider: "claude_code",
        started_at: "2026-04-15T10:00:00.000Z",
        ended_at: "2026-04-15T11:00:00.000Z",
        duration_ms: 3_600_000,
        repo_id: "repo_x",
        git_branch: "refs/heads/main",
        ticket: null,
        message_count: 12,
        total_input_tokens: 2000,
        total_output_tokens: 800,
        total_cost_cents: 250,
        vital_context_drag_state: "yellow",
        vital_context_drag_metric: 18.2,
        vital_cache_efficiency_state: "green",
        vital_cache_efficiency_metric: 87,
        vital_thrashing_state: "red",
        vital_thrashing_metric: 0.95,
        vital_cost_acceleration_state: "yellow",
        vital_cost_acceleration_metric: 42,
        vital_overall_state: "red",
        ...extras,
      },
      {
        device_id: "dev_outsider",
        session_id: "sess_outsider",
        provider: "claude_code",
        started_at: "2026-04-15T10:00:00.000Z",
      },
    ]);
  }

  it("returns the session with vital fields when visible to the viewer", async () => {
    seedSession();
    const { getSessionDetail } = await loadDal();

    const detail = await getSessionDetail(manager, "dev_ivan", "sess_v");
    expect(detail).not.toBeNull();
    expect(detail?.vital_overall_state).toBe("red");
    expect(detail?.vital_context_drag_state).toBe("yellow");
    expect(Number(detail?.vital_context_drag_metric)).toBe(18.2);
    expect(detail?.vital_cache_efficiency_state).toBe("green");
    expect(detail?.vital_thrashing_state).toBe("red");
    expect(detail?.vital_cost_acceleration_state).toBe("yellow");
  });

  it("returns null for a foreign-org session — collapses with not-found", async () => {
    // Per ADR-0083 §6: visibility branch must not leak existence of a session
    // belonging to another org. A 404-equivalent (null) keeps that contract.
    seedSession();
    const { getSessionDetail } = await loadDal();

    const detail = await getSessionDetail(
      manager,
      "dev_outsider",
      "sess_outsider"
    );
    expect(detail).toBeNull();
  });

  it("returns null for a member viewer asking about a teammate's session", async () => {
    seedSession();
    const { getSessionDetail } = await loadDal();

    const jane = {
      id: "usr_jane",
      org_id: "org_team",
      role: "member" as const,
      api_key: "budi_j",
      display_name: "Jane",
      email: "jane@example.com",
    };
    const detail = await getSessionDetail(jane, "dev_ivan", "sess_v");
    expect(detail).toBeNull();
  });
});

describe("getSessions cursor pagination (#85)", () => {
  // Unbounded range so the per-page cursor is the only thing trimming output.
  const wideRange = utcRange("2026-01-01", "2026-12-31");

  const manager = {
    id: "usr_ivan",
    org_id: "org_team",
    role: "manager",
    api_key: "budi_i",
    display_name: "Ivan",
    email: "ivan@example.com",
  };

  function seedSessions(n: number, deviceId = "dev_ivan") {
    fake.seed("orgs", [{ id: "org_team", name: "team" }]);
    fake.seed("users", [{ ...manager }]);
    fake.seed("devices", [{ id: deviceId, user_id: manager.id }]);
    // Newest first when we paginate. Index 0 == newest.
    const rows = Array.from({ length: n }, (_, i) => ({
      device_id: deviceId,
      session_id: `sess_${String(n - i).padStart(4, "0")}`,
      provider: "claude_code",
      started_at: new Date(
        Date.UTC(2026, 3, 1, 0, 0, 0) + i * 60_000
      ).toISOString(),
      ended_at: null,
      duration_ms: null,
      repo_id: "repo_x",
      git_branch: "refs/heads/main",
      ticket: null,
      message_count: 1,
      total_input_tokens: 0,
      total_output_tokens: 0,
      total_cost_cents: 0,
    }));
    fake.seed("session_summaries", rows);
    return rows;
  }

  it("returns the first page with a cursor when more rows exist", async () => {
    seedSessions(5);
    const { getSessions } = await loadDal();
    const page = await getSessions(manager, wideRange, undefined, {
      pageSize: 2,
    });

    expect(page.rows).toHaveLength(2);
    expect(page.nextCursor).not.toBeNull();
    // Newest first: index 0 = newest started_at = "2026-04-01T00:04:00Z".
    expect(page.rows[0].started_at).toBe("2026-04-01T00:04:00.000Z");
    expect(page.rows[1].started_at).toBe("2026-04-01T00:03:00.000Z");
    expect(page.nextCursor?.startedAt).toBe("2026-04-01T00:03:00.000Z");
  });

  it("walks the entire history across pages without skipping or duplicating rows", async () => {
    // 7 rows, page size 3 → pages of 3, 3, 1. The "no skip / no duplicate"
    // contract is the whole reason we sort + cursor on (started_at, session_id)
    // instead of LIMIT/OFFSET (#85).
    seedSessions(7);
    const { getSessions } = await loadDal();

    const collected: string[] = [];
    let cursor = null as Awaited<ReturnType<typeof getSessions>>["nextCursor"];
    let pageCount = 0;
    do {
      const res = await getSessions(manager, wideRange, undefined, {
        pageSize: 3,
        cursor,
      });
      collected.push(...res.rows.map((r) => r.session_id));
      cursor = res.nextCursor;
      pageCount += 1;
      if (pageCount > 10) throw new Error("pagination did not terminate");
    } while (cursor);

    expect(collected).toHaveLength(7);
    expect(new Set(collected).size).toBe(7); // no duplicates
    // Newest → oldest. Seeded so session_id "sess_0001" has the latest
    // started_at and "sess_0007" the earliest.
    expect(collected[0]).toBe("sess_0001");
    expect(collected[6]).toBe("sess_0007");
  });

  it("returns nextCursor=null on the last partial page", async () => {
    seedSessions(2);
    const { getSessions } = await loadDal();
    const page = await getSessions(manager, wideRange, undefined, {
      pageSize: 5,
    });
    expect(page.rows).toHaveLength(2);
    expect(page.nextCursor).toBeNull();
  });

  it("breaks ties on session_id when two rows share the same started_at", async () => {
    // Composite cursor must keep tied rows in a deterministic order so the
    // walk neither skips one nor returns the same row twice.
    fake.seed("orgs", [{ id: "org_team", name: "team" }]);
    fake.seed("users", [{ ...manager }]);
    fake.seed("devices", [{ id: "dev_ivan", user_id: manager.id }]);
    const ts = "2026-04-15T10:00:00.000Z";
    fake.seed("session_summaries", [
      {
        device_id: "dev_ivan",
        session_id: "sess_a",
        provider: "claude_code",
        started_at: ts,
        ended_at: null,
        duration_ms: null,
        repo_id: "repo_x",
        git_branch: "refs/heads/main",
        ticket: null,
        message_count: 1,
        total_input_tokens: 0,
        total_output_tokens: 0,
        total_cost_cents: 0,
      },
      {
        device_id: "dev_ivan",
        session_id: "sess_b",
        provider: "claude_code",
        started_at: ts,
        ended_at: null,
        duration_ms: null,
        repo_id: "repo_x",
        git_branch: "refs/heads/main",
        ticket: null,
        message_count: 1,
        total_input_tokens: 0,
        total_output_tokens: 0,
        total_cost_cents: 0,
      },
    ]);

    const { getSessions } = await loadDal();
    const first = await getSessions(manager, wideRange, undefined, {
      pageSize: 1,
    });
    expect(first.rows.map((r) => r.session_id)).toEqual(["sess_b"]);
    expect(first.nextCursor).toEqual({
      startedAt: ts,
      sessionId: "sess_b",
    });

    const second = await getSessions(manager, wideRange, undefined, {
      pageSize: 1,
      cursor: first.nextCursor,
    });
    expect(second.rows.map((r) => r.session_id)).toEqual(["sess_a"]);
    expect(second.nextCursor).toBeNull();
  });

  it("respects the visible-device scope when paginating", async () => {
    // Member viewer must never see another teammate's sessions, regardless of
    // cursor — same self-only scope as everywhere else (ADR-0083 §6).
    fake.seed("orgs", [{ id: "org_team", name: "team" }]);
    fake.seed("users", [
      { ...manager },
      {
        id: "usr_jane",
        org_id: "org_team",
        role: "member",
        api_key: "budi_j",
        display_name: "Jane",
        email: "jane@example.com",
      },
    ]);
    fake.seed("devices", [
      { id: "dev_ivan", user_id: "usr_ivan" },
      { id: "dev_jane", user_id: "usr_jane" },
    ]);
    fake.seed("session_summaries", [
      {
        device_id: "dev_ivan",
        session_id: "sess_ivan",
        provider: "claude_code",
        started_at: "2026-04-15T10:00:00.000Z",
        ended_at: null,
        duration_ms: null,
        repo_id: "repo_x",
        git_branch: "refs/heads/main",
        ticket: null,
        message_count: 1,
        total_input_tokens: 0,
        total_output_tokens: 0,
        total_cost_cents: 0,
      },
      {
        device_id: "dev_jane",
        session_id: "sess_jane",
        provider: "claude_code",
        started_at: "2026-04-15T11:00:00.000Z",
        ended_at: null,
        duration_ms: null,
        repo_id: "repo_x",
        git_branch: "refs/heads/main",
        ticket: null,
        message_count: 1,
        total_input_tokens: 0,
        total_output_tokens: 0,
        total_cost_cents: 0,
      },
    ]);

    const { getSessions } = await loadDal();
    const jane = {
      id: "usr_jane",
      org_id: "org_team",
      role: "member",
      api_key: "budi_j",
      display_name: "Jane",
      email: "jane@example.com",
    };
    const page = await getSessions(jane, wideRange);
    expect(page.rows.map((r) => r.session_id)).toEqual(["sess_jane"]);
  });
});
