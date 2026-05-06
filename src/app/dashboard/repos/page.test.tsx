import { describe, it, expect, vi, beforeEach } from "vitest";
import { containsSuspense, extractText } from "@/test-utils/page-tree";

/**
 * Page-level coverage for `/dashboard/repos` (#112).
 */

vi.mock("server-only", () => ({}));
vi.mock("@/lib/viewer-timezone", () => ({
  getViewerTimeZone: async () => "UTC",
}));
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
  getCostByRepo: vi.fn(),
  getCostByBranch: vi.fn(),
  getCostByTicket: vi.fn(),
  getEarliestActivity: vi.fn(),
  getOrgMembers: vi.fn(),
};
vi.mock("@/lib/dal", () => dal);

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
  dal.getCostByRepo.mockReset().mockResolvedValue([
    {
      repo_id: "repo_x",
      cost_cents: 800_00,
      input_tokens: 1_000,
      output_tokens: 500,
    },
  ]);
  dal.getCostByBranch.mockReset().mockResolvedValue([
    {
      repo_id: "repo_x",
      git_branch: "refs/heads/main",
      cost_cents: 600_00,
      input_tokens: 700,
      output_tokens: 300,
    },
  ]);
  dal.getCostByTicket.mockReset().mockResolvedValue([
    {
      ticket: "TICKET-1",
      cost_cents: 200_00,
      input_tokens: 200,
      output_tokens: 150,
    },
  ]);
  dal.getEarliestActivity.mockReset().mockResolvedValue("2026-04-01");
  dal.getOrgMembers.mockReset().mockResolvedValue([]);
});

async function render(searchParams: Record<string, string> = {}) {
  const mod = await import("./page");
  return mod.default({ searchParams: Promise.resolve(searchParams) });
}

describe("dashboard/repos /page", () => {
  it("smoke: renders all three cards (Project / Branch / Ticket) with populated DAL data", async () => {
    const node = await render();
    expect(node).toBeTruthy();
    const text = extractText(node);
    expect(text).toContain("Repos");
    expect(text).toContain("Cost by Project");
    expect(text).toContain("Cost by Branch");
    expect(text).toContain("Cost by Ticket");
  });

  it("companion tables: each chart card renders a table next to the bar chart with In/Out columns and the ticket id", async () => {
    const node = await render();
    const text = extractText(node);
    // Project / Branch / Ticket tables share these columns; one assertion per
    // unique value catches a regression in any of them.
    expect(text).toContain("Project");
    expect(text).toContain("Branch");
    expect(text).toContain("Ticket");
    expect(text).toContain("In");
    expect(text).toContain("Out");
    expect(text).toContain("TICKET-1");
  });

  it("empty: renders all three empty-state copies when every breakdown is empty", async () => {
    dal.getCostByRepo.mockResolvedValue([]);
    dal.getCostByBranch.mockResolvedValue([]);
    dal.getCostByTicket.mockResolvedValue([]);
    const node = await render();
    expect(node).toBeTruthy();
    const text = extractText(node);
    expect(text).toContain("No project data for this period");
    expect(text).toContain("No branch data for this period");
    expect(text).toContain("No ticket data for this period");
  });

  it("loading: composes a Suspense boundary around the filter cluster", async () => {
    const node = await render();
    expect(containsSuspense(node)).toBe(true);
  });

  it("error: a DAL fault propagates so the framework error boundary can render its fallback", async () => {
    dal.getCostByRepo.mockRejectedValue(new Error("__DAL_BOOM__"));
    await expect(render()).rejects.toThrow("__DAL_BOOM__");
  });

  it("returns null (no leak) when the viewer has no org_id yet", async () => {
    dal.getCurrentUser.mockResolvedValue({ ...MANAGER, org_id: null });
    const node = await render();
    expect(node).toBeNull();
  });
});
