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
  /**
   * Captures the most recent `rpc()` invocation. The real
   * `delete_workspace_cascade` (migration 024) runs server-side as one
   * transaction; in the fake we re-implement the same delete order so the
   * test still observes the post-cascade state — but we also record the
   * call so a regression that bypasses the RPC fails the existing tests.
   */
  lastRpc: { name: string; args: Record<string, unknown> } | null = null;
  rpcErrors = new Map<string, { message: string }>();

  from(name: string) {
    if (!this.tables.has(name)) this.tables.set(name, []);
    return new FakeQuery(this.tables, name);
  }

  rpc(name: string, args: Record<string, unknown>) {
    this.lastRpc = { name, args };
    const error = this.rpcErrors.get(name);
    if (error) return Promise.resolve({ data: null, error });

    if (name === "delete_workspace_cascade") {
      const workspaceId = args.p_workspace_id as string;
      const userIds = this.rows("users")
        .filter((u) => u.workspace_id === workspaceId)
        .map((u) => u.id as string);
      const deviceIds = this.rows("devices")
        .filter((d) => userIds.includes(d.user_id as string))
        .map((d) => d.id as string);
      const listIds = this.rows("workspace_price_lists")
        .filter((l) => l.workspace_id === workspaceId)
        .map((l) => l.id as string | number);

      this.tables.set(
        "session_summaries",
        this.rows("session_summaries").filter(
          (r) => !deviceIds.includes(r.device_id as string)
        )
      );
      this.tables.set(
        "daily_rollups",
        this.rows("daily_rollups").filter(
          (r) => !deviceIds.includes(r.device_id as string)
        )
      );
      this.tables.set(
        "devices",
        this.rows("devices").filter(
          (r) => !userIds.includes(r.user_id as string)
        )
      );
      this.tables.set(
        "workspace_price_list_rows",
        this.rows("workspace_price_list_rows").filter(
          (r) => !listIds.includes(r.list_id as string | number)
        )
      );
      this.tables.set(
        "workspace_price_lists",
        this.rows("workspace_price_lists").filter(
          (r) => r.workspace_id !== workspaceId
        )
      );
      this.tables.set(
        "workspace_pricing_defaults",
        this.rows("workspace_pricing_defaults").filter(
          (r) => r.workspace_id !== workspaceId
        )
      );
      this.tables.set(
        "recalculation_runs",
        this.rows("recalculation_runs").filter(
          (r) => r.workspace_id !== workspaceId
        )
      );
      this.tables.set(
        "invite_tokens",
        this.rows("invite_tokens").filter((r) => r.workspace_id !== workspaceId)
      );
      const usersAfter = this.rows("users").filter(
        (r) => r.workspace_id !== workspaceId
      );
      const usersDeleted = this.rows("users").length - usersAfter.length;
      this.tables.set("users", usersAfter);
      this.tables.set(
        "workspaces",
        this.rows("workspaces").filter((r) => r.id !== workspaceId)
      );
      return Promise.resolve({ data: usersDeleted, error: null });
    }

    return Promise.resolve({ data: null, error: null });
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

  upsert(
    row: Row,
    opts: { ignoreDuplicates?: boolean; onConflict?: string } = {}
  ) {
    this._op = "select"; // settle so subsequent ops on the same builder are clean
    const onConflict = (opts.onConflict ?? "")
      .split(",")
      .map((c) => c.trim())
      .filter(Boolean);
    if (onConflict.length === 0) {
      this.tables.set(this.table, [...this.rows, row]);
      return Promise.resolve({ data: null, error: null });
    }
    const conflict = this.rows.find((r) =>
      onConflict.every((c) => r[c] === row[c])
    );
    if (conflict) {
      if (!opts.ignoreDuplicates) Object.assign(conflict, row);
      return Promise.resolve({ data: null, error: null });
    }
    this.tables.set(this.table, [...this.rows, row]);
    return Promise.resolve({ data: null, error: null });
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

const revalidatePathMock = vi.fn((path: string) => {
  void path;
});

vi.mock("next/cache", () => ({
  revalidatePath: (path: string) => revalidatePathMock(path),
}));

beforeEach(() => {
  for (const t of [
    "workspaces",
    "users",
    "devices",
    "daily_rollups",
    "session_summaries",
    "invite_tokens",
    "invite_redemptions",
    "workspace_price_lists",
    "workspace_price_list_rows",
    "workspace_pricing_defaults",
    "recalculation_runs",
  ]) {
    fake.seed(t, []);
  }
  fake.lastRpc = null;
  fake.rpcErrors.clear();
  authUserId = null;
  signOut.mockClear();
  redirectMock.mockClear();
  revalidatePathMock.mockClear();
});

function seedSoloManagerWithData() {
  fake.seed("workspaces", [{ id: "org_acme", name: "Acme Co" }]);
  fake.seed("users", [
    {
      id: "usr_ivan",
      workspace_id: "org_acme",
      role: "manager",
      api_key: "budi_x",
    },
    {
      id: "usr_pat",
      workspace_id: "org_acme",
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
    { id: "tok_1", workspace_id: "org_acme", created_by: "usr_ivan" },
  ]);
  authUserId = "usr_ivan";
}

async function loadActions() {
  return await import("@/app/actions/workspace");
}

describe("deleteWorkspace", () => {
  it("cascades through session summaries, rollups, devices, pricing, invites, users, then the workspace itself", async () => {
    seedSoloManagerWithData();
    const { deleteWorkspace } = await loadActions();
    const { WORKSPACE_CASCADE_ORDER } =
      await import("@/app/actions/workspace-cascade");

    // Snapshot the declared order alongside the test so a change to one
    // without the other fails loudly. This must match the body of
    // `delete_workspace_cascade` in
    // `supabase/migrations/025_rename_org_to_workspace.sql`.
    expect(WORKSPACE_CASCADE_ORDER).toEqual([
      "session_summaries",
      "daily_rollups",
      "devices",
      "workspace_price_list_rows",
      "workspace_price_lists",
      "workspace_pricing_defaults",
      "recalculation_runs",
      "invite_tokens",
      "users",
      "workspaces",
    ]);

    const fd = new FormData();
    fd.set("confirm", "Acme Co");

    await expect(deleteWorkspace(undefined, fd)).rejects.toThrow(
      "__REDIRECT__"
    );

    expect(fake.lastRpc?.name).toBe("delete_workspace_cascade");
    expect(fake.lastRpc?.args).toEqual({ p_workspace_id: "org_acme" });

    expect(fake.rows("session_summaries")).toHaveLength(0);
    expect(fake.rows("daily_rollups")).toHaveLength(0);
    expect(fake.rows("devices")).toHaveLength(0);
    expect(fake.rows("invite_tokens")).toHaveLength(0);
    expect(fake.rows("users")).toHaveLength(0);
    expect(fake.rows("workspaces")).toHaveLength(0);
    expect(signOut).toHaveBeenCalledOnce();
    expect(redirectMock).toHaveBeenCalledWith("/login");
  });

  it("also clears the workspace's pricing tables (#276 regression — the manager-uploaded-a-price-list path)", async () => {
    seedSoloManagerWithData();
    fake.seed("workspace_price_lists", [
      {
        id: 1,
        workspace_id: "org_acme",
        name: "Q4 2026",
        effective_from: "2026-01-01",
        status: "active",
        uploaded_by: "usr_ivan",
      },
    ]);
    fake.seed("workspace_price_list_rows", [
      {
        id: 1,
        list_id: 1,
        platform: "anthropic",
        model_pattern: "claude-haiku-4-5",
        token_type: "input",
        sale_usd_per_mtok: 1.5,
      },
    ]);
    fake.seed("workspace_pricing_defaults", [
      {
        workspace_id: "org_acme",
        default_platform: "anthropic",
        updated_by: "usr_ivan",
      },
    ]);
    fake.seed("recalculation_runs", [
      {
        id: 1,
        workspace_id: "org_acme",
        status: "succeeded",
        triggered_by: "usr_ivan",
      },
    ]);

    const { deleteWorkspace } = await loadActions();
    const fd = new FormData();
    fd.set("confirm", "Acme Co");

    await expect(deleteWorkspace(undefined, fd)).rejects.toThrow(
      "__REDIRECT__"
    );

    // All four pricing surfaces must be wiped — these are exactly the rows
    // that the original implementation left behind (#276) because the
    // `DELETE FROM users` raised an FK violation against `updated_by` /
    // `uploaded_by` / `triggered_by` and supabase-js never threw.
    expect(fake.rows("workspace_price_list_rows")).toHaveLength(0);
    expect(fake.rows("workspace_price_lists")).toHaveLength(0);
    expect(fake.rows("workspace_pricing_defaults")).toHaveLength(0);
    expect(fake.rows("recalculation_runs")).toHaveLength(0);
    expect(fake.rows("users")).toHaveLength(0);
    expect(fake.rows("workspaces")).toHaveLength(0);
  });

  it("surfaces the RPC error to the UI instead of silently signing the user out", async () => {
    seedSoloManagerWithData();
    fake.rpcErrors.set("delete_workspace_cascade", {
      message: "foreign key violation on org_price_lists",
    });

    const { deleteWorkspace } = await loadActions();
    const fd = new FormData();
    fd.set("confirm", "Acme Co");

    const result = await deleteWorkspace(undefined, fd);
    expect(result?.error).toMatch(/foreign key violation/i);
    // Nothing else must change — the user should still be signed in and
    // able to retry / report the failure.
    expect(fake.rows("workspaces")).toHaveLength(1);
    expect(fake.rows("users")).toHaveLength(2);
    expect(signOut).not.toHaveBeenCalled();
    expect(redirectMock).not.toHaveBeenCalled();
  });

  it("rejects a non-manager caller without touching any data", async () => {
    seedSoloManagerWithData();
    authUserId = "usr_pat"; // member

    const { deleteWorkspace } = await loadActions();
    const fd = new FormData();
    fd.set("confirm", "Acme Co");

    const result = await deleteWorkspace(undefined, fd);
    expect(result).toEqual({
      error: "Only managers can delete the workspace",
    });
    expect(fake.rows("workspaces")).toHaveLength(1);
    expect(fake.rows("users")).toHaveLength(2);
    expect(signOut).not.toHaveBeenCalled();
  });

  it("rejects when the typed confirmation does not match the workspace name", async () => {
    seedSoloManagerWithData();
    const { deleteWorkspace } = await loadActions();

    const fd = new FormData();
    fd.set("confirm", "acme co"); // wrong case

    const result = await deleteWorkspace(undefined, fd);
    expect(result).toEqual({
      error: "Type the workspace name exactly to confirm",
    });
    expect(fake.rows("workspaces")).toHaveLength(1);
    expect(fake.rows("daily_rollups")).toHaveLength(2);
    expect(signOut).not.toHaveBeenCalled();
  });

  it("rejects an unauthenticated caller", async () => {
    seedSoloManagerWithData();
    authUserId = null;

    const { deleteWorkspace } = await loadActions();
    const fd = new FormData();
    fd.set("confirm", "Acme Co");

    const result = await deleteWorkspace(undefined, fd);
    expect(result).toEqual({ error: "Not authenticated" });
    expect(fake.rows("workspaces")).toHaveLength(1);
  });
});

describe("leaveWorkspace", () => {
  it("wipes the caller's devices and data, nulls their workspace_id, and signs them out", async () => {
    seedSoloManagerWithData();
    authUserId = "usr_pat"; // member

    const { leaveWorkspace } = await loadActions();

    await expect(leaveWorkspace()).rejects.toThrow("__REDIRECT__");

    const users = fake.rows("users");
    const pat = users.find((u) => u.id === "usr_pat");
    const ivan = users.find((u) => u.id === "usr_ivan");

    expect(pat?.workspace_id).toBeNull();
    expect(pat?.role).toBe("member");
    // The org and its other members must be untouched.
    expect(ivan?.workspace_id).toBe("org_acme");
    expect(fake.rows("workspaces")).toHaveLength(1);

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

    const { leaveWorkspace } = await loadActions();

    const result = await leaveWorkspace();
    expect(result?.error).toMatch(/can't leave/i);
    expect(fake.rows("devices")).toHaveLength(2);
    expect(signOut).not.toHaveBeenCalled();
  });

  it("rejects a caller who isn't in any org", async () => {
    fake.seed("users", [
      {
        id: "usr_nobody",
        workspace_id: null,
        role: "member",
        api_key: "budi_z",
      },
    ]);
    authUserId = "usr_nobody";

    const { leaveWorkspace } = await loadActions();
    const result = await leaveWorkspace();
    expect(result).toEqual({ error: "Not a member of any workspace" });
  });
});

describe("updateMemberRole", () => {
  function seedTwoOrgs() {
    fake.seed("workspaces", [
      { id: "org_acme", name: "Acme Co" },
      { id: "org_other", name: "Other Inc" },
    ]);
    fake.seed("users", [
      {
        id: "usr_ivan",
        workspace_id: "org_acme",
        role: "manager",
        api_key: "k1",
      },
      {
        id: "usr_pat",
        workspace_id: "org_acme",
        role: "member",
        api_key: "k2",
      },
      {
        id: "usr_jess",
        workspace_id: "org_acme",
        role: "manager",
        api_key: "k3",
      },
      // Cross-org user — must never be reachable from an Acme manager.
      {
        id: "usr_outsider",
        workspace_id: "org_other",
        role: "member",
        api_key: "k4",
      },
    ]);
  }

  it("promotes a member to manager and revalidates the settings page", async () => {
    seedTwoOrgs();
    authUserId = "usr_ivan";

    const { updateMemberRole } = await loadActions();
    const result = await updateMemberRole("usr_pat", "manager");

    expect(result).toEqual({ ok: true });
    const pat = fake.rows("users").find((u) => u.id === "usr_pat");
    expect(pat?.role).toBe("manager");
    expect(revalidatePathMock).toHaveBeenCalledWith("/dashboard/settings");
  });

  it("demotes another manager when ≥2 managers exist", async () => {
    seedTwoOrgs();
    authUserId = "usr_ivan";

    const { updateMemberRole } = await loadActions();
    const result = await updateMemberRole("usr_jess", "member");

    expect(result).toEqual({ ok: true });
    const jess = fake.rows("users").find((u) => u.id === "usr_jess");
    expect(jess?.role).toBe("member");
  });

  it("refuses to demote the last remaining manager (other-demote)", async () => {
    fake.seed("workspaces", [{ id: "org_acme", name: "Acme Co" }]);
    fake.seed("users", [
      {
        id: "usr_ivan",
        workspace_id: "org_acme",
        role: "manager",
        api_key: "k1",
      },
      {
        id: "usr_pat",
        workspace_id: "org_acme",
        role: "member",
        api_key: "k2",
      },
      {
        id: "usr_jess",
        workspace_id: "org_acme",
        role: "manager",
        api_key: "k3",
      },
    ]);
    // Ivan demotes Jess first — now Ivan is the only manager.
    authUserId = "usr_ivan";

    const { updateMemberRole } = await loadActions();
    await updateMemberRole("usr_jess", "member");
    const result = await updateMemberRole("usr_jess", "member");
    // The first call removed Jess as manager, second is a no-op short-circuit.
    expect(result).toEqual({ ok: true });

    // Now an attempt to demote the only remaining manager (Ivan) must fail.
    const lastManagerResult = await updateMemberRole("usr_ivan", "member");
    expect(lastManagerResult).toEqual({
      error: "Can't demote the last manager — promote someone else first.",
    });
    const ivan = fake.rows("users").find((u) => u.id === "usr_ivan");
    expect(ivan?.role).toBe("manager");
  });

  it("refuses self-demote when caller is the last manager", async () => {
    fake.seed("workspaces", [{ id: "org_acme", name: "Acme Co" }]);
    fake.seed("users", [
      {
        id: "usr_ivan",
        workspace_id: "org_acme",
        role: "manager",
        api_key: "k1",
      },
      {
        id: "usr_pat",
        workspace_id: "org_acme",
        role: "member",
        api_key: "k2",
      },
    ]);
    authUserId = "usr_ivan";

    const { updateMemberRole } = await loadActions();
    const result = await updateMemberRole("usr_ivan", "member");

    expect(result).toEqual({
      error: "Can't demote the last manager — promote someone else first.",
    });
    const ivan = fake.rows("users").find((u) => u.id === "usr_ivan");
    expect(ivan?.role).toBe("manager");
  });

  it("refuses a non-manager caller", async () => {
    seedTwoOrgs();
    authUserId = "usr_pat"; // member

    const { updateMemberRole } = await loadActions();
    const result = await updateMemberRole("usr_pat", "manager");

    expect(result).toEqual({ error: "Only managers can change member roles" });
    const pat = fake.rows("users").find((u) => u.id === "usr_pat");
    expect(pat?.role).toBe("member");
  });

  it("refuses to touch a user from another workspace", async () => {
    seedTwoOrgs();
    authUserId = "usr_ivan";

    const { updateMemberRole } = await loadActions();
    const result = await updateMemberRole("usr_outsider", "manager");

    expect(result).toEqual({
      error: "User is not a member of your workspace",
    });
    const outsider = fake.rows("users").find((u) => u.id === "usr_outsider");
    expect(outsider?.role).toBe("member");
  });

  it("rejects unknown role values", async () => {
    seedTwoOrgs();
    authUserId = "usr_ivan";

    const { updateMemberRole } = await loadActions();
    const result = await updateMemberRole("usr_pat", "owner");

    expect(result).toEqual({ error: "Invalid role" });
    const pat = fake.rows("users").find((u) => u.id === "usr_pat");
    expect(pat?.role).toBe("member");
  });

  it("rejects an unauthenticated caller", async () => {
    seedTwoOrgs();
    authUserId = null;

    const { updateMemberRole } = await loadActions();
    const result = await updateMemberRole("usr_pat", "manager");

    expect(result).toEqual({ error: "Not authenticated" });
  });

  it("short-circuits a no-op without writing or revalidating", async () => {
    seedTwoOrgs();
    authUserId = "usr_ivan";

    const { updateMemberRole } = await loadActions();
    const result = await updateMemberRole("usr_pat", "member");

    expect(result).toEqual({ ok: true });
    expect(revalidatePathMock).not.toHaveBeenCalled();
  });
});

describe("switchWorkspace", () => {
  const FUTURE = new Date(Date.now() + 60 * 60 * 1000).toISOString();
  const PAST = new Date(Date.now() - 60 * 1000).toISOString();

  function seedSwitchableMember() {
    fake.seed("workspaces", [
      { id: "org_acme", name: "Acme Co" },
      { id: "org_other", name: "Other Inc" },
    ]);
    fake.seed("users", [
      {
        id: "usr_ivan",
        workspace_id: "org_other",
        role: "manager",
        api_key: "k1",
      },
      {
        id: "usr_alice",
        workspace_id: "org_other",
        role: "member",
        api_key: "k2",
      },
      {
        id: "usr_acme_mgr",
        workspace_id: "org_acme",
        role: "manager",
        api_key: "k3",
      },
    ]);
    fake.seed("devices", [{ id: "dev_alice", user_id: "usr_alice" }]);
    fake.seed("daily_rollups", [
      { device_id: "dev_alice", bucket_day: "2026-04-20", cost_cents: 100 },
    ]);
    fake.seed("session_summaries", [
      { device_id: "dev_alice", session_id: "s1" },
    ]);
    fake.seed("invite_tokens", [
      {
        id: "tok_acme",
        workspace_id: "org_acme",
        role: "member",
        created_by: "usr_acme_mgr",
        expires_at: FUTURE,
      },
    ]);
  }

  function fd(values: Record<string, string>): FormData {
    const f = new FormData();
    for (const [k, v] of Object.entries(values)) f.set(k, v);
    return f;
  }

  it("flips the caller's workspace_id, leaves devices/data intact, and writes an audit row", async () => {
    seedSwitchableMember();
    authUserId = "usr_alice";

    const { switchWorkspace } = await loadActions();
    await expect(
      switchWorkspace(
        undefined,
        fd({
          token: "tok_acme",
          targetWorkspaceId: "org_acme",
          confirm: "Acme Co",
        })
      )
    ).rejects.toThrow("__REDIRECT__");

    const alice = fake.rows("users").find((u) => u.id === "usr_alice");
    expect(alice?.workspace_id).toBe("org_acme");
    expect(alice?.role).toBe("member");

    // Devices + synced data follow the user (FKs are user_id, not workspace_id).
    expect(fake.rows("devices")).toHaveLength(1);
    expect(fake.rows("daily_rollups")).toHaveLength(1);
    expect(fake.rows("session_summaries")).toHaveLength(1);

    // Audit trail in invite_redemptions, same shape as a fresh join.
    const redemptions = fake.rows("invite_redemptions");
    expect(redemptions).toEqual([
      { token_id: "tok_acme", user_id: "usr_alice" },
    ]);

    // The token itself is untouched and still redeemable for other teammates.
    expect(fake.rows("invite_tokens")).toHaveLength(1);

    expect(redirectMock).toHaveBeenCalledWith("/dashboard");
  });

  it("refuses a manager (would orphan the current org)", async () => {
    seedSwitchableMember();
    authUserId = "usr_ivan"; // manager of org_other

    const { switchWorkspace } = await loadActions();
    const result = await switchWorkspace(
      undefined,
      fd({
        token: "tok_acme",
        targetWorkspaceId: "org_acme",
        confirm: "Acme Co",
      })
    );

    expect(result?.error).toMatch(/Managers can't switch/i);
    const ivan = fake.rows("users").find((u) => u.id === "usr_ivan");
    expect(ivan?.workspace_id).toBe("org_other");
    expect(fake.rows("invite_redemptions")).toHaveLength(0);
  });

  it("rejects an unauthenticated caller", async () => {
    seedSwitchableMember();
    authUserId = null;

    const { switchWorkspace } = await loadActions();
    const result = await switchWorkspace(
      undefined,
      fd({
        token: "tok_acme",
        targetWorkspaceId: "org_acme",
        confirm: "Acme Co",
      })
    );

    expect(result).toEqual({ error: "Not authenticated" });
  });

  it("refuses an expired invite even if the form looks valid", async () => {
    seedSwitchableMember();
    fake.seed("invite_tokens", [
      {
        id: "tok_acme",
        workspace_id: "org_acme",
        role: "member",
        created_by: "usr_acme_mgr",
        expires_at: PAST,
      },
    ]);
    authUserId = "usr_alice";

    const { switchWorkspace } = await loadActions();
    const result = await switchWorkspace(
      undefined,
      fd({
        token: "tok_acme",
        targetWorkspaceId: "org_acme",
        confirm: "Acme Co",
      })
    );

    expect(result).toEqual({ error: "Invite link has expired" });
    const alice = fake.rows("users").find((u) => u.id === "usr_alice");
    expect(alice?.workspace_id).toBe("org_other");
  });

  it("refuses a missing/forged token", async () => {
    seedSwitchableMember();
    authUserId = "usr_alice";

    const { switchWorkspace } = await loadActions();
    const result = await switchWorkspace(
      undefined,
      fd({
        token: "tok_nope",
        targetWorkspaceId: "org_acme",
        confirm: "Acme Co",
      })
    );

    expect(result).toEqual({ error: "Invite link is invalid" });
  });

  it("refuses a tampered targetWorkspaceId that doesn't match the token", async () => {
    seedSwitchableMember();
    authUserId = "usr_alice";

    const { switchWorkspace } = await loadActions();
    const result = await switchWorkspace(
      undefined,
      fd({
        token: "tok_acme",
        targetWorkspaceId: "org_other",
        confirm: "Acme Co",
      })
    );

    expect(result).toEqual({
      error: "Invite link does not match the target workspace",
    });
    const alice = fake.rows("users").find((u) => u.id === "usr_alice");
    expect(alice?.workspace_id).toBe("org_other");
  });

  it("requires the typed confirmation to match the target org name", async () => {
    seedSwitchableMember();
    authUserId = "usr_alice";

    const { switchWorkspace } = await loadActions();
    const result = await switchWorkspace(
      undefined,
      fd({
        token: "tok_acme",
        targetWorkspaceId: "org_acme",
        confirm: "acme co",
      })
    );

    expect(result).toEqual({
      error: "Type the workspace name exactly to confirm",
    });
    const alice = fake.rows("users").find((u) => u.id === "usr_alice");
    expect(alice?.workspace_id).toBe("org_other");
  });
});
