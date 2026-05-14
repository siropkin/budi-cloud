import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/**
 * #282: pin the browser-side factory contract. Every "use client" component
 * that needs a fresh, RLS-respecting client goes through this — a regression
 * that silently swallowed the missing-env guard would surface as a confusing
 * runtime error inside an event handler instead of at boot.
 */

const createBrowserClient = vi.fn();

vi.mock("@supabase/ssr", () => ({
  createBrowserClient: (...args: unknown[]) => {
    createBrowserClient(...args);
    return { __mock: true };
  },
}));

beforeEach(() => {
  createBrowserClient.mockClear();
});

afterEach(() => {
  delete process.env.NEXT_PUBLIC_SUPABASE_URL;
  delete process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
});

describe("createClient (browser)", () => {
  it("forwards the URL + anon key to @supabase/ssr", async () => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = "https://example.supabase.co";
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "anon-key";

    const { createClient } = await import("./client");
    createClient();

    expect(createBrowserClient).toHaveBeenCalledWith(
      "https://example.supabase.co",
      "anon-key"
    );
  });

  it("throws when the URL env var is missing", async () => {
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "anon-key";
    const { createClient } = await import("./client");
    expect(() => createClient()).toThrow(/NEXT_PUBLIC_SUPABASE_URL/);
  });

  it("throws when the anon key env var is missing", async () => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = "https://example.supabase.co";
    const { createClient } = await import("./client");
    expect(() => createClient()).toThrow(/NEXT_PUBLIC_SUPABASE_ANON_KEY/);
  });
});
