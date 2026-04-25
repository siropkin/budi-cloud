import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * Regression coverage for issue #62 — invite-link round-trip.
 *
 * The bug: the Supabase auth callback redirected every brand-new (or
 * orgless) user to `/setup`, ignoring the `?next=/invite/<token>` query
 * param. That auto-provisioned a personal org for the invitee before the
 * invite page ever ran, and the invite page then short-circuited with
 * "Already in an Organization".
 *
 * These tests pin the post-auth redirect target for every combination of
 * (user state) × (next param) so the regression cannot return silently.
 */

type Row = Record<string, unknown>;

class FakeAdmin {
  rows: Row[] = [];

  seed(rows: Row[]) {
    this.rows = [...rows];
  }

  from(_table: string) {
    void _table;
    return new FakeQuery(this.rows);
  }
}

class FakeQuery {
  private filters: Array<(r: Row) => boolean> = [];
  private _pendingPatch: Row | null = null;

  constructor(private readonly rows: Row[]) {}

  select(_cols?: string) {
    void _cols;
    return this;
  }

  eq(col: string, value: unknown) {
    this.filters.push((r) => r[col] === value);
    return this;
  }

  async single() {
    const matched = this.rows.filter((r) => this.filters.every((f) => f(r)));
    if (matched.length !== 1) {
      return { data: null, error: { message: "not found" } };
    }
    return { data: matched[0], error: null };
  }

  async insert(row: Row) {
    this.rows.push({ ...row });
    return { data: null, error: null };
  }

  update(patch: Row) {
    this._pendingPatch = patch;
    return this;
  }

  // The callback awaits the chained `.update().eq()` directly.
  then<T>(onFulfilled: (r: { data: null; error: null }) => T) {
    if (this._pendingPatch) {
      const matches = this.rows.filter((r) => this.filters.every((f) => f(r)));
      for (const r of matches) Object.assign(r, this._pendingPatch);
      this._pendingPatch = null;
    }
    return Promise.resolve(onFulfilled({ data: null, error: null }));
  }
}

const admin = new FakeAdmin();

let mockUser: { id: string; email: string; user_metadata: Row } | null = {
  id: "user_abc",
  email: "bon@example.com",
  user_metadata: {},
};
let exchangeError: { message: string } | null = null;

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => admin,
}));

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    auth: {
      exchangeCodeForSession: async (_code: string) => {
        void _code;
        return { error: exchangeError };
      },
      getUser: async () => ({ data: { user: mockUser }, error: null }),
    },
  }),
}));

vi.mock("server-only", () => ({}));

beforeEach(() => {
  admin.seed([]);
  mockUser = {
    id: "user_abc",
    email: "bon@example.com",
    user_metadata: {},
  };
  exchangeError = null;
});

const ORIGIN = "http://localhost:3000";

async function runCallback(query: string): Promise<string> {
  const { GET } = await import("./route");
  const url = `${ORIGIN}/auth/callback${query}`;
  const res = await GET(new Request(url));
  return res.headers.get("location") ?? "";
}

describe("/auth/callback — invite-link round-trip (#62)", () => {
  it("forwards a new user with ?next=/invite/<token> straight to the invite page", async () => {
    // No row in `users` yet — first sign-in. Without the fix, this would
    // redirect to /setup and the invitee would create their own org before
    // the invite page ever ran.
    const location = await runCallback("?code=abc&next=%2Finvite%2Ftok_xyz");

    expect(location).toBe(`${ORIGIN}/invite/tok_xyz`);
    // The user row must still be created — the invite page expects to find
    // it and just patch on the org_id.
    expect(admin.rows).toHaveLength(1);
    expect(admin.rows[0].org_id).toBeNull();
  });

  it("forwards an existing orgless user with ?next=/invite/<token> to the invite page", async () => {
    admin.seed([
      {
        id: "user_abc",
        org_id: null,
        display_name: "Bon",
      },
    ]);

    const location = await runCallback("?code=abc&next=%2Finvite%2Ftok_xyz");

    expect(location).toBe(`${ORIGIN}/invite/tok_xyz`);
  });

  it("still sends a brand-new user with no next to /setup", async () => {
    const location = await runCallback("?code=abc");
    expect(location).toBe(`${ORIGIN}/setup`);
  });

  it("still sends an existing orgless user with no next to /setup", async () => {
    admin.seed([{ id: "user_abc", org_id: null, display_name: "Bon" }]);

    const location = await runCallback("?code=abc");
    expect(location).toBe(`${ORIGIN}/setup`);
  });

  it("sends an existing user with an org to ?next when it's safe", async () => {
    admin.seed([{ id: "user_abc", org_id: "org_1", display_name: "Bon" }]);

    const location = await runCallback("?code=abc&next=%2Fdashboard%2Fteam");
    expect(location).toBe(`${ORIGIN}/dashboard/team`);
  });

  it("ignores an open-redirect attempt in next and falls through to /dashboard", async () => {
    admin.seed([{ id: "user_abc", org_id: "org_1", display_name: "Bon" }]);

    // `next=https://evil.example` is rejected by the safety whitelist —
    // the callback falls back to /dashboard.
    const location = await runCallback(
      "?code=abc&next=https%3A%2F%2Fevil.example"
    );
    expect(location).toBe(`${ORIGIN}/dashboard`);
  });

  it("redirects to /login on missing code", async () => {
    const location = await runCallback("");
    expect(location).toBe(`${ORIGIN}/login?error=missing_code`);
  });

  it("redirects to /login on auth_failed", async () => {
    exchangeError = { message: "bad code" };
    const location = await runCallback("?code=abc");
    expect(location).toBe(`${ORIGIN}/login?error=auth_failed`);
  });
});
