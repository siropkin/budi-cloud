import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * Coverage for issue #68 — invite tokens are multi-use.
 *
 * The handler used to single-use the token by writing back `used_by` /
 * `used_at` and short-circuiting every subsequent visitor with "Already
 * Used." The new contract: the token stays redeemable until `expires_at`,
 * each successful join inserts a row into `invite_redemptions`, and a
 * re-click by an already-joined user is an idempotent redirect to the
 * dashboard rather than an error.
 *
 * These tests pin the redemption flow at the handler level so the
 * regression cannot return silently if someone re-introduces a "used_by"
 * style guard.
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
  private _op: "select" | "delete" | "update" | "insert" | "upsert" = "select";
  private _patch: Row | null = null;
  private _upsertOpts: { ignoreDuplicates?: boolean; onConflict?: string } = {};

  constructor(
    private readonly tables: Map<string, Row[]>,
    private readonly table: string
  ) {}

  private get rows(): Row[] {
    return this.tables.get(this.table) ?? [];
  }

  select(_cols?: string) {
    void _cols;
    this._op = "select";
    return this;
  }

  insert(row: Row | Row[]) {
    this._op = "insert";
    const next = [...this.rows, ...(Array.isArray(row) ? row : [row])];
    this.tables.set(this.table, next);
    return Promise.resolve({ data: null, error: null });
  }

  upsert(
    row: Row,
    opts: { ignoreDuplicates?: boolean; onConflict?: string } = {}
  ) {
    this._op = "upsert";
    this._patch = row;
    this._upsertOpts = opts;
    // Apply immediately — the handler awaits the upsert directly without an `.eq()`.
    this.applyUpsert();
    return Promise.resolve({ data: null, error: null });
  }

  update(patch: Row) {
    this._op = "update";
    this._patch = patch;
    return this;
  }

  eq(col: string, value: unknown) {
    this.filters.push((r) => r[col] === value);
    if (this._op === "update") this.applyUpdate();
    return this;
  }

  async single() {
    const matched = this.rows.filter((r) => this.filters.every((f) => f(r)));
    if (matched.length === 1) return { data: matched[0], error: null };
    return {
      data: null,
      error: { message: `expected 1 row, got ${matched.length}` },
    };
  }

  private applyUpdate() {
    if (!this._patch) return;
    const patch = this._patch;
    const next = this.rows.map((r) =>
      this.filters.every((f) => f(r)) ? { ...r, ...patch } : r
    );
    this.tables.set(this.table, next);
  }

  private applyUpsert() {
    if (!this._patch) return;
    const patch = this._patch;
    const onConflict = (this._upsertOpts.onConflict ?? "")
      .split(",")
      .map((c) => c.trim())
      .filter(Boolean);
    if (onConflict.length === 0) {
      this.tables.set(this.table, [...this.rows, patch]);
      return;
    }
    const conflict = this.rows.find((r) =>
      onConflict.every((c) => r[c] === patch[c])
    );
    if (conflict) {
      if (!this._upsertOpts.ignoreDuplicates) Object.assign(conflict, patch);
      return;
    }
    this.tables.set(this.table, [...this.rows, patch]);
  }
}

const fake = new FakeSupabase();
let authUser: { id: string; email?: string; user_metadata?: Row } | null = null;
const redirectMock = vi.fn((to: string) => {
  throw new Error(`__REDIRECT__:${to}`);
});

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => fake,
}));

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    auth: {
      getUser: async () => ({ data: { user: authUser } }),
    },
  }),
}));

vi.mock("next/navigation", () => ({
  redirect: (to: string) => redirectMock(to),
}));

vi.mock("server-only", () => ({}));

beforeEach(() => {
  for (const t of ["orgs", "users", "invite_tokens", "invite_redemptions"]) {
    fake.seed(t, []);
  }
  authUser = null;
  redirectMock.mockClear();
});

const FUTURE = new Date(Date.now() + 60 * 60 * 1000).toISOString();
const PAST = new Date(Date.now() - 60 * 1000).toISOString();

function seedInvite(overrides: Row = {}) {
  fake.seed("orgs", [{ id: "org_acme", name: "Acme" }]);
  fake.seed("invite_tokens", [
    {
      id: "tok_xyz",
      org_id: "org_acme",
      role: "member",
      created_by: "usr_manager",
      created_at: PAST,
      expires_at: FUTURE,
      ...overrides,
    },
  ]);
}

async function loadPage() {
  const mod = await import("./page");
  return mod.default;
}

async function visit(token = "tok_xyz") {
  const InvitePage = await loadPage();
  return InvitePage({ params: Promise.resolve({ token }) });
}

describe("invite/[token] page — multi-use redemption (#68)", () => {
  it("lets two distinct authenticated users redeem the same token", async () => {
    seedInvite();
    fake.seed("users", [
      { id: "usr_manager", org_id: "org_acme", role: "manager" },
    ]);

    // First teammate joins.
    authUser = {
      id: "usr_alice",
      email: "alice@example.com",
      user_metadata: {},
    };
    await expect(visit()).rejects.toThrow("__REDIRECT__:/dashboard");

    // Second teammate joins via the SAME token — must succeed (no "Already Used").
    authUser = { id: "usr_bob", email: "bob@example.com", user_metadata: {} };
    await expect(visit()).rejects.toThrow("__REDIRECT__:/dashboard");

    const users = fake.rows("users");
    expect(users.find((u) => u.id === "usr_alice")?.org_id).toBe("org_acme");
    expect(users.find((u) => u.id === "usr_bob")?.org_id).toBe("org_acme");

    const redemptions = fake.rows("invite_redemptions");
    expect(redemptions.map((r) => r.user_id).sort()).toEqual([
      "usr_alice",
      "usr_bob",
    ]);
    // The token row stays intact and reusable — no `used_by` is written back.
    const token = fake.rows("invite_tokens")[0];
    expect(token.id).toBe("tok_xyz");
    expect(token).not.toHaveProperty("used_by");
  });

  it("treats a re-click by an already-joined user as an idempotent dashboard redirect", async () => {
    seedInvite();
    fake.seed("users", [
      { id: "usr_manager", org_id: "org_acme", role: "manager" },
      { id: "usr_alice", org_id: "org_acme", role: "member" },
    ]);
    // Pretend Alice already redeemed once.
    fake.seed("invite_redemptions", [
      { token_id: "tok_xyz", user_id: "usr_alice" },
    ]);

    authUser = {
      id: "usr_alice",
      email: "alice@example.com",
      user_metadata: {},
    };
    await expect(visit()).rejects.toThrow("__REDIRECT__:/dashboard");

    // No duplicate row appears.
    expect(fake.rows("invite_redemptions")).toHaveLength(1);
  });

  it("renders the cross-org switch panel for a member already in another org (#72)", async () => {
    seedInvite();
    fake.seed("orgs", [
      { id: "org_acme", name: "Acme" },
      { id: "org_other", name: "Other Inc" },
    ]);
    fake.seed("users", [
      { id: "usr_alice", org_id: "org_other", role: "member" },
    ]);

    authUser = {
      id: "usr_alice",
      email: "alice@example.com",
      user_metadata: {},
    };
    const node = (await visit()) as { props: Record<string, unknown> };

    // Surfaces the explicit switch path — does NOT redirect, does NOT show the
    // old "Multi-org is not supported yet" dead-end copy. The page hands a
    // CrossOrgSwitch client component the four props it needs to render the
    // confirmation flow; pin them all so the page<->component contract can't
    // drift silently.
    expect(redirectMock).not.toHaveBeenCalled();
    expect(node.props).toEqual({
      token: "tok_xyz",
      currentOrgName: "Other Inc",
      targetOrgId: "org_acme",
      targetOrgName: "Acme",
    });
    expect(JSON.stringify(node)).not.toContain("Multi-org is not supported");
    // The flip-to-Acme write only lands when the user submits the form, so a
    // pure render must not have moved them.
    const alice = fake.rows("users").find((u) => u.id === "usr_alice");
    expect(alice?.org_id).toBe("org_other");
    expect(fake.rows("invite_redemptions")).toHaveLength(0);
  });

  it("refuses a manager from a different org without rendering the switch UI", async () => {
    seedInvite();
    fake.seed("orgs", [
      { id: "org_acme", name: "Acme" },
      { id: "org_other", name: "Other Inc" },
    ]);
    fake.seed("users", [
      { id: "usr_alice", org_id: "org_other", role: "manager" },
    ]);

    authUser = {
      id: "usr_alice",
      email: "alice@example.com",
      user_metadata: {},
    };
    const node = await visit();

    expect(redirectMock).not.toHaveBeenCalled();
    const html = JSON.stringify(node);
    expect(html).toContain("Already in an Organization");
    // The switch CTA must not be rendered for a manager — they'd orphan their
    // current org. Copy nudges them toward delete/hand-off instead.
    expect(html).not.toContain("Switch organizations?");
    expect(html).toContain("Delete");
    expect(fake.rows("invite_redemptions")).toHaveLength(0);
  });

  it("redirects an unauthenticated visitor to /login with a next= round-trip", async () => {
    seedInvite();
    authUser = null;

    await expect(visit()).rejects.toThrow(
      "__REDIRECT__:/login?next=/invite/tok_xyz"
    );
    expect(fake.rows("invite_redemptions")).toHaveLength(0);
  });

  it("renders Expired (and writes nothing) when the token is past expires_at", async () => {
    seedInvite({ expires_at: PAST });
    authUser = {
      id: "usr_alice",
      email: "alice@example.com",
      user_metadata: {},
    };

    const node = await visit();
    expect(redirectMock).not.toHaveBeenCalled();
    expect(JSON.stringify(node)).toContain("Expired");
    expect(fake.rows("invite_redemptions")).toHaveLength(0);
  });

  it("renders Invalid Invite for a token that does not exist", async () => {
    authUser = {
      id: "usr_alice",
      email: "alice@example.com",
      user_metadata: {},
    };

    const node = await visit("does_not_exist");
    expect(JSON.stringify(node)).toContain("Invalid Invite");
    expect(fake.rows("invite_redemptions")).toHaveLength(0);
  });
});
