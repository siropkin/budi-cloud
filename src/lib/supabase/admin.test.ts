import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/**
 * #282: pin the service-role client contract. The ingest path + admin
 * actions go through this factory, and a regression that silently keeps
 * the auth-refresh timer alive would leak handles in every serverless
 * invocation. We mock `@supabase/supabase-js` so the test never spins up a
 * real client (and never touches the network).
 */

const createClient = vi.fn();

vi.mock("@supabase/supabase-js", () => ({
  createClient: (...args: unknown[]) => {
    createClient(...args);
    return { __mock: true };
  },
}));

beforeEach(() => {
  createClient.mockClear();
});

afterEach(() => {
  delete process.env.NEXT_PUBLIC_SUPABASE_URL;
  delete process.env.SUPABASE_SERVICE_ROLE_KEY;
});

describe("createAdminClient", () => {
  it("forwards the URL + service-role key with autoRefresh disabled", async () => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = "https://example.supabase.co";
    process.env.SUPABASE_SERVICE_ROLE_KEY = "service-role-secret";

    const { createAdminClient } = await import("./admin");
    createAdminClient();

    expect(createClient).toHaveBeenCalledWith(
      "https://example.supabase.co",
      "service-role-secret",
      { auth: { autoRefreshToken: false, persistSession: false } }
    );
  });

  it("throws when the URL env var is missing", async () => {
    process.env.SUPABASE_SERVICE_ROLE_KEY = "service-role-secret";
    const { createAdminClient } = await import("./admin");
    expect(() => createAdminClient()).toThrow(/NEXT_PUBLIC_SUPABASE_URL/);
  });

  it("throws when the service-role key is missing", async () => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = "https://example.supabase.co";
    const { createAdminClient } = await import("./admin");
    expect(() => createAdminClient()).toThrow(/SUPABASE_SERVICE_ROLE_KEY/);
  });
});
