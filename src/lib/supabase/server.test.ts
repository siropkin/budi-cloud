import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/**
 * #282: pin the server-side factory contract — including the cookie-bridge
 * wiring that `@supabase/ssr` uses to refresh sessions on the proxy. A
 * regression here would either drop refreshed cookies on the floor (silent
 * sign-out) or throw inside Server Components where `cookies().set()` isn't
 * allowed (the `try { … } catch {}` guard exists for that case).
 */

const createServerClient = vi.fn();
const cookieStore: Array<{
  name: string;
  value: string;
  options?: unknown;
}> = [];

vi.mock("@supabase/ssr", () => ({
  createServerClient: (url: string, key: string, init: unknown) => {
    createServerClient(url, key, init);
    return { __mock: true };
  },
}));

vi.mock("next/headers", () => ({
  cookies: async () => ({
    getAll() {
      return cookieStore.map((c) => ({ name: c.name, value: c.value }));
    },
    set(name: string, value: string, options?: unknown) {
      cookieStore.push({ name, value, options });
    },
  }),
}));

beforeEach(() => {
  createServerClient.mockClear();
  cookieStore.length = 0;
});

afterEach(() => {
  delete process.env.NEXT_PUBLIC_SUPABASE_URL;
  delete process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
});

describe("createClient (server)", () => {
  it("forwards the URL + anon key and a cookies bridge", async () => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = "https://example.supabase.co";
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "anon-key";
    cookieStore.push({ name: "sb-access-token", value: "abc" });

    const { createClient } = await import("./server");
    await createClient();

    expect(createServerClient).toHaveBeenCalledTimes(1);
    const call = createServerClient.mock.calls[0]!;
    const [url, key, init] = call as [string, string, { cookies: unknown }];
    expect(url).toBe("https://example.supabase.co");
    expect(key).toBe("anon-key");
    expect(init.cookies).toMatchObject({
      getAll: expect.any(Function),
      setAll: expect.any(Function),
    });
  });

  it("getAll() returns the current request cookies", async () => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = "https://example.supabase.co";
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "anon-key";
    cookieStore.push({ name: "sb-access-token", value: "abc" });

    const { createClient } = await import("./server");
    await createClient();

    const init = createServerClient.mock.calls[0]![2] as {
      cookies: { getAll: () => Array<{ name: string; value: string }> };
    };
    expect(init.cookies.getAll()).toEqual([
      { name: "sb-access-token", value: "abc" },
    ]);
  });

  it("setAll() forwards refreshed cookies into the Next.js cookie store", async () => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = "https://example.supabase.co";
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "anon-key";

    const { createClient } = await import("./server");
    await createClient();

    const init = createServerClient.mock.calls[0]![2] as {
      cookies: {
        setAll: (
          xs: Array<{ name: string; value: string; options: unknown }>
        ) => void;
      };
    };
    init.cookies.setAll([
      { name: "sb-access-token", value: "fresh", options: { httpOnly: true } },
    ]);
    expect(cookieStore).toContainEqual({
      name: "sb-access-token",
      value: "fresh",
      options: { httpOnly: true },
    });
  });

  it("setAll() swallows the Server-Component write error so reads don't crash", async () => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = "https://example.supabase.co";
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "anon-key";

    // Re-import with a cookies mock whose `set` throws — mimics calling the
    // factory from a Server Component context, where the proxy is expected
    // to handle session refresh instead.
    vi.resetModules();
    vi.doMock("next/headers", () => ({
      cookies: async () => ({
        getAll() {
          return [];
        },
        set() {
          throw new Error("Cookies cannot be set in a Server Component");
        },
      }),
    }));

    const { createClient } = await import("./server");
    await createClient();

    const init = createServerClient.mock.calls.at(-1)![2] as {
      cookies: {
        setAll: (
          xs: Array<{ name: string; value: string; options: unknown }>
        ) => void;
      };
    };
    expect(() =>
      init.cookies.setAll([
        { name: "sb-access-token", value: "fresh", options: {} },
      ])
    ).not.toThrow();

    vi.doUnmock("next/headers");
  });

  it("throws when the URL env var is missing", async () => {
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "anon-key";
    const { createClient } = await import("./server");
    await expect(createClient()).rejects.toThrow(/NEXT_PUBLIC_SUPABASE_URL/);
  });

  it("throws when the anon key env var is missing", async () => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = "https://example.supabase.co";
    const { createClient } = await import("./server");
    await expect(createClient()).rejects.toThrow(
      /NEXT_PUBLIC_SUPABASE_ANON_KEY/
    );
  });
});
