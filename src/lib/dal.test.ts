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

class FakeQuery {
  private filters: Array<(r: Row) => boolean> = [];
  private _orderKey: string | null = null;
  private _orderAsc = true;
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
  });

  it("reports the most recent rollup synced_at across visible devices", async () => {
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
    const range = { from: "2026-04-01", to: "2026-04-30" };

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
    const range = { from: "2026-04-01", to: "2026-04-30" };

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
