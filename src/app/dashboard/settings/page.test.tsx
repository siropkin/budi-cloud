import { describe, it, expect, vi, beforeEach } from "vitest";
import { containsSuspense, extractText } from "@/test-utils/page-tree";

/**
 * Page-level coverage for `/dashboard/settings` (#112).
 *
 * The settings page is the only dashboard page that bypasses the DAL for
 * one of its reads (`createAdminClient().from("orgs").select(...)`), so the
 * mock surface here is split across `@/lib/dal` and `@/lib/supabase/admin`.
 */

vi.mock("server-only", () => ({}));
vi.mock("next/navigation", () => ({
  redirect: (to: string) => {
    throw new Error(`__REDIRECT__:${to}`);
  },
  notFound: () => {
    throw new Error("__NOT_FOUND__");
  },
}));

const dal = {
  getCurrentUser: vi.fn(),
  getOrgMembers: vi.fn(),
};
vi.mock("@/lib/dal", () => dal);

const orgRow = vi.fn();

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    from: () => ({
      select: () => ({
        eq: () => ({
          single: () => orgRow(),
        }),
      }),
    }),
  }),
}));

const MANAGER = {
  id: "usr_ivan",
  org_id: "org_team",
  role: "manager",
  api_key: "budi_i",
  display_name: "Ivan",
  email: "ivan@example.com",
};

beforeEach(() => {
  dal.getCurrentUser.mockReset().mockResolvedValue(MANAGER);
  dal.getOrgMembers.mockReset().mockResolvedValue([
    {
      id: "usr_ivan",
      display_name: "Ivan",
      email: "ivan@example.com",
      role: "manager",
    },
    {
      id: "usr_jane",
      display_name: "Jane",
      email: "jane@example.com",
      role: "member",
    },
  ]);
  orgRow.mockReset().mockResolvedValue({
    data: { id: "org_team", name: "Acme" },
    error: null,
  });
});

async function render() {
  const mod = await import("./page");
  return mod.default();
}

describe("dashboard/settings /page", () => {
  it("smoke: renders Organization, API Key, and Team Members sections with populated data", async () => {
    const node = await render();
    expect(node).toBeTruthy();
    const text = extractText(node);
    expect(text).toContain("Settings");
    expect(text).toContain("Organization");
    expect(text).toContain("Acme");
    // The team members section header includes the count — pin it so a
    // refactor that drops the count or the header is caught.
    expect(text).toContain("Team Members");
    expect(text).toContain("2");
    expect(text).toContain("Ivan");
    expect(text).toContain("Jane");
  });

  it("empty: renders the 'No members yet' copy when the org has no members", async () => {
    dal.getOrgMembers.mockResolvedValue([]);
    const node = await render();
    expect(node).toBeTruthy();
    const text = extractText(node);
    expect(text).toContain("Team Members");
    expect(text).toContain("0");
    expect(text).toContain("No members yet");
  });

  it("loading: pins the no-Suspense contract — settings has no period-driven data, so it ships without a streaming boundary", async () => {
    // The other dashboard pages wrap their filter cluster in `<Suspense>`
    // so the page can stream while filters resolve. Settings has no
    // searchParams-driven UI, so it intentionally skips that boundary.
    // Pin the absence so a future change adds it deliberately rather than
    // by accident — and so the test grid stays parallel with #112's spec.
    const node = await render();
    expect(node).toBeTruthy();
    expect(containsSuspense(node)).toBe(false);
  });

  it("error: a DAL fault propagates so the framework error boundary can render its fallback", async () => {
    dal.getOrgMembers.mockRejectedValue(new Error("__DAL_BOOM__"));
    await expect(render()).rejects.toThrow("__DAL_BOOM__");
  });

  it("returns null (no leak) when the viewer has no org_id yet", async () => {
    dal.getCurrentUser.mockResolvedValue({ ...MANAGER, org_id: null });
    const node = await render();
    expect(node).toBeNull();
  });
});
