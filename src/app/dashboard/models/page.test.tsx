import { describe, it, expect, vi, beforeEach } from "vitest";
import { containsSuspense, extractText } from "@/test-utils/page-tree";

/**
 * Page-level coverage for `/dashboard/models` (#112, #147).
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
  getCostByModel: vi.fn(),
  getModelActivityByDay: vi.fn(),
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
  dal.getCostByModel.mockReset().mockResolvedValue([
    {
      provider: "claude_code",
      model: "claude-sonnet-4-5",
      cost_cents: 800_00,
      input_tokens: 600_000,
      output_tokens: 200_000,
    },
    {
      provider: "openai",
      model: "gpt-4o",
      cost_cents: 200_00,
      input_tokens: 150_000,
      output_tokens: 50_000,
    },
  ]);
  dal.getModelActivityByDay.mockReset().mockResolvedValue([
    {
      bucket_day: "2026-05-01",
      active_models: 2,
      cost_cents: 600_00,
      input_tokens: 0,
      output_tokens: 0,
    },
    {
      bucket_day: "2026-05-02",
      active_models: 1,
      cost_cents: 400_00,
      input_tokens: 0,
      output_tokens: 0,
    },
  ]);
  dal.getEarliestActivity.mockReset().mockResolvedValue("2026-04-01");
  dal.getOrgMembers.mockReset().mockResolvedValue([]);
});

async function render(searchParams: Record<string, string> = {}) {
  const mod = await import("./page");
  return mod.default({ searchParams: Promise.resolve(searchParams) });
}

describe("dashboard/models /page", () => {
  it("smoke: renders headline, merged Cost by Model card with companion table, and headline stats (#147)", async () => {
    const node = await render();
    expect(node).toBeTruthy();
    const text = extractText(node);
    expect(text).toContain("Models");
    expect(text).toContain("Cost by Model");
    // Companion table promotes provider to its own column so the manager can
    // tell `gpt-4o` on OpenAI apart from a hypothetical `gpt-4o` on Azure.
    expect(text).toContain("claude_code");
    expect(text).toContain("openai");
    expect(text).toContain("claude-sonnet-4-5");
    expect(text).toContain("gpt-4o");
    // Headline tiles. 2 distinct active models, $1,000 total ⇒ $500 avg.
    expect(text).toContain("Active models");
    expect(text).toContain("Avg cost per model");
    expect(text).toContain("$500.00");
  });

  it("tokens unit relabels the per-model headline and totals", async () => {
    const node = await render({ units: "tokens" });
    const text = extractText(node);
    expect(text).toContain("Avg tokens per model");
    expect(text).not.toContain("Avg cost per model");
    // (600k+200k + 150k+50k) / 2 = 500,000 tokens/model ⇒ "500.0K".
    expect(text).toContain("500.0K");
  });

  it("empty: chart-empty fallback when the DAL returns no models", async () => {
    dal.getCostByModel.mockResolvedValue([]);
    dal.getModelActivityByDay.mockResolvedValue([]);
    const node = await render();
    expect(node).toBeTruthy();
    const text = extractText(node);
    expect(text).toContain("No model cost data for this period");
    // No active models ⇒ both stats render the em-dash sentinel.
    expect(text).toContain("—");
  });

  it("loading: composes a Suspense boundary around the filter cluster", async () => {
    const node = await render();
    expect(containsSuspense(node)).toBe(true);
  });

  it("error: a DAL fault propagates so the framework error boundary can render its fallback", async () => {
    dal.getCostByModel.mockRejectedValue(new Error("__DAL_BOOM__"));
    await expect(render()).rejects.toThrow("__DAL_BOOM__");
  });

  it("returns null (no leak) when the viewer has no org_id yet", async () => {
    dal.getCurrentUser.mockResolvedValue({ ...MANAGER, org_id: null });
    const node = await render();
    expect(node).toBeNull();
  });
});
