import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * Coverage for the destructive org-lifecycle actions added in #39.
 *
 * The server re-validates role + confirmation independently of the UI, so
 * the test focuses on the gating and the cascade order rather than on the
 * React components that call it.
 */

type Row = Record<string, unknown>;

class FakeSupabase {
  tables = new Map<string, Row[]>();

  from(name: string) {
    if (!this.tables.has(name)) this.tables.set(name, []);
    return new FakeQuery(this.tables, name);
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
  private _op: "select" | "delete" | "update" = "select";
  private _patch: Row | null = null;

  constructor(
    private readonly tables: Map<string, Row[]>,
    private readonly table: string
  ) {}

  private get rows(): Row[] {
    return this.tables.get(this.table) ?? [];
  }

  select(cols?: string) {
    void cols;
    this._op = "select";
    return this;
  }

  delete() {
    this._op = "delete";
    return this;
  }

  update(patch: Row) {
    this._op = "update";
    this._patch = patch;
    return this;
  }

  eq(col: string, value: unknown) {
    this.filters.push((r) => r[col] === value);
    return this.maybeFlushMutating();
  }

  in(col: string, values: unknown[]) {
    const set = new Set(values);
    this.filters.push((r) => set.has(r[col]));
    return this.maybeFlushMutating();
  }

  async single() {
    const matched = this.rows.filter((r) => this.filters.every((f) => f(r)));
    if (matched.length === 1) return { data: matched[0], error: null };
    return {
      data: null,
      error: { message: `expected 1 row, got ${matched.length}` },
    };
  }

  then<T>(onFulfilled: (r: { data: Row[]; error: null }) => T) {
    const matched = this.rows.filter((r) => this.filters.every((f) => f(r)));
    return Promise.resolve(onFulfilled({ data: matched, error: null }));
  }

  // `delete()` and `update()` need to resolve even without a chained select —
  // Supabase JS returns a PostgrestBuilder that awaits to `{ error }`. We
  // mutate the table as soon as the first filter arrives so the outer
  // `await admin.from(..).delete().in(..)` works.
  private maybeFlushMutating(): this {
    if (this._op === "delete") this.applyDelete();
    else if (this._op === "update") this.applyUpdate();
    return this;
  }

  private applyDelete() {
    const kept = this.rows.filter((r) => !this.filters.every((f) => f(r)));
    this.tables.set(this.table, kept);
  }

  private applyUpdate() {
    if (!this._patch) return;
    const patch = this._patch;
    const next = this.rows.map((r) =>
      this.filters.every((f) => f(r)) ? { ...r, ...patch } : r
    );
    this.tables.set(this.table, next);
  }
}

const fake = new FakeSupabase();
let authUserId: string | null = null;
const signOut = vi.fn(async () => {});
const redirectMock = vi.fn((to: string) => {
  void to;
  throw new Error("__REDIRECT__");
});

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => fake,
}));

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    auth: {
      getUser: async () => ({
        data: { user: authUserId ? { id: authUserId } : null },
      }),
      signOut,
    },
  }),
}));

vi.mock("next/navigation", () => ({
  redirect: (to: string) => redirectMock(to),
}));

beforeEach(() => {
  for (const t of [
    "orgs",
    "users",
    "devices",
    "daily_rollups",
    "session_summaries",
    "invite_tokens",
  ]) {
    fake.seed(t, []);
  }
  authUserId = null;
  signOut.mockClear();
  redirectMock.mockClear();
});

function seedSoloManagerWithData() {
  fake.seed("orgs", [{ id: "org_acme", name: "Acme Co" }]);
  fake.seed("users", [
    {
      id: "usr_ivan",
      org_id: "org_acme",
      role: "manager",
      api_key: "budi_x",
    },
    {
      id: "usr_pat",
      org_id: "org_acme",
      role: "member",
      api_key: "budi_y",
    },
  ]);
  fake.seed("devices", [
    { id: "dev_laptop", user_id: "usr_ivan" },
    { id: "dev_pat", user_id: "usr_pat" },
  ]);
  fake.seed("daily_rollups", [
    { device_id: "dev_laptop", bucket_day: "2026-04-20", cost_cents: 100 },
    { device_id: "dev_pat", bucket_day: "2026-04-20", cost_cents: 50 },
  ]);
  fake.seed("session_summaries", [
    { device_id: "dev_laptop", session_id: "s1" },
    { device_id: "dev_pat", session_id: "s2" },
  ]);
  fake.seed("invite_tokens", [
    { id: "tok_1", org_id: "org_acme", created_by: "usr_ivan" },
  ]);
  authUserId = "usr_ivan";
}

async function loadActions() {
  return await import("@/app/actions/org");
}

describe("deleteOrganization", () => {
  it("cascades through session summaries, rollups, devices, invites, users, then the org itself", async () => {
    seedSoloManagerWithData();
    const { deleteOrganization, ORG_CASCADE_ORDER } = await loadActions();

    // Snapshot the declared order alongside the test so a change to one
    // without the other fails loudly.
    expect(ORG_CASCADE_ORDER).toEqual([
      "session_summaries",
      "daily_rollups",
      "devices",
      "invite_tokens",
      "users",
      "orgs",
    ]);

    const fd = new FormData();
    fd.set("confirm", "Acme Co");

    await expect(deleteOrganization(undefined, fd)).rejects.toThrow(
      "__REDIRECT__"
    );

    expect(fake.rows("session_summaries")).toHaveLength(0);
    expect(fake.rows("daily_rollups")).toHaveLength(0);
    expect(fake.rows("devices")).toHaveLength(0);
    expect(fake.rows("invite_tokens")).toHaveLength(0);
    expect(fake.rows("users")).toHaveLength(0);
    expect(fake.rows("orgs")).toHaveLength(0);
    expect(signOut).toHaveBeenCalledOnce();
    expect(redirectMock).toHaveBeenCalledWith("/login");
  });

  it("rejects a non-manager caller without touching any data", async () => {
    seedSoloManagerWithData();
    authUserId = "usr_pat"; // member

    const { deleteOrganization } = await loadActions();
    const fd = new FormData();
    fd.set("confirm", "Acme Co");

    const result = await deleteOrganization(undefined, fd);
    expect(result).toEqual({ error: "Only managers can delete the organization" });
    expect(fake.rows("orgs")).toHaveLength(1);
    expect(fake.rows("users")).toHaveLength(2);
    expect(signOut).not.toHaveBeenCalled();
  });

  it("rejects when the typed confirmation does not match the org name", async () => {
    seedSoloManagerWithData();
    const { deleteOrganization } = await loadActions();

    const fd = new FormData();
    fd.set("confirm", "acme co"); // wrong case

    const result = await deleteOrganization(undefined, fd);
    expect(result).toEqual({
      error: "Type the organization name exactly to confirm",
    });
    expect(fake.rows("orgs")).toHaveLength(1);
    expect(fake.rows("daily_rollups")).toHaveLength(2);
    expect(signOut).not.toHaveBeenCalled();
  });

  it("rejects an unauthenticated caller", async () => {
    seedSoloManagerWithData();
    authUserId = null;

    const { deleteOrganization } = await loadActions();
    const fd = new FormData();
    fd.set("confirm", "Acme Co");

    const result = await deleteOrganization(undefined, fd);
    expect(result).toEqual({ error: "Not authenticated" });
    expect(fake.rows("orgs")).toHaveLength(1);
  });
});

describe("leaveOrganization", () => {
  it("wipes the caller's devices and data, nulls their org_id, and signs them out", async () => {
    seedSoloManagerWithData();
    authUserId = "usr_pat"; // member

    const { leaveOrganization } = await loadActions();

    await expect(leaveOrganization()).rejects.toThrow("__REDIRECT__");

    const users = fake.rows("users");
    const pat = users.find((u) => u.id === "usr_pat");
    const ivan = users.find((u) => u.id === "usr_ivan");

    expect(pat?.org_id).toBeNull();
    expect(pat?.role).toBe("member");
    // The org and its other members must be untouched.
    expect(ivan?.org_id).toBe("org_acme");
    expect(fake.rows("orgs")).toHaveLength(1);

    // Only Pat's devices / data should be gone.
    const remainingDevices = fake.rows("devices");
    expect(remainingDevices.map((d) => d.id)).toEqual(["dev_laptop"]);
    const rollups = fake.rows("daily_rollups");
    expect(rollups.map((r) => r.device_id)).toEqual(["dev_laptop"]);
    const sessions = fake.rows("session_summaries");
    expect(sessions.map((s) => s.device_id)).toEqual(["dev_laptop"]);

    expect(signOut).toHaveBeenCalledOnce();
    expect(redirectMock).toHaveBeenCalledWith("/login");
  });

  it("refuses to let a manager leave (to avoid an orphaned org)", async () => {
    seedSoloManagerWithData();
    authUserId = "usr_ivan"; // manager

    const { leaveOrganization } = await loadActions();

    const result = await leaveOrganization();
    expect(result?.error).toMatch(/can't leave/i);
    expect(fake.rows("devices")).toHaveLength(2);
    expect(signOut).not.toHaveBeenCalled();
  });

  it("rejects a caller who isn't in any org", async () => {
    fake.seed("users", [
      { id: "usr_nobody", org_id: null, role: "member", api_key: "budi_z" },
    ]);
    authUserId = "usr_nobody";

    const { leaveOrganization } = await loadActions();
    const result = await leaveOrganization();
    expect(result).toEqual({ error: "Not a member of any organization" });
  });
});
