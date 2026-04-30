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

  seed(name: string, rows: Row[]) {
    this.tables.set(name, [...rows]);
  }
}

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
      { id: "usr_jane", name: "Jane", cost_cents: 1500_00 },
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
        return rollup(
          i % 2 === 0 ? "dev_laptop" : "dev_desktop",
          day,
          100,
          {
            model: `model-${i % 50}`,
            repo_id: `repo-${i % 25}`,
            git_branch: `branch-${i}`,
            ticket: `TICKET-${i % 40}`,
          }
        );
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
