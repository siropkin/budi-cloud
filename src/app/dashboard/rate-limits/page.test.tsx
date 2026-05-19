import { describe, it, expect, vi, beforeEach } from "vitest";
import { containsSuspense, extractText } from "@/test-utils/page-tree";

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
  getEarliestActivity: vi.fn(),
  getKnownSurfaces: vi.fn(),
  getWorkspaceMembers: vi.fn(),
  getWindowTimeline: vi.fn(),
  getThrottleEvents: vi.fn(),
  getTeamRateLimitStats: vi.fn(),
};
vi.mock("@/lib/dal", () => dal);

const MANAGER = {
  id: "usr_ivan",
  workspace_id: "org_team",
  role: "manager",
  api_key: "budi_i",
  display_name: "Ivan",
  email: "ivan@example.com",
};

const MEMBER = {
  ...MANAGER,
  role: "member",
};

beforeEach(() => {
  dal.getCurrentUser.mockReset().mockResolvedValue(MANAGER);
  dal.getEarliestActivity.mockReset().mockResolvedValue("2026-04-01");
  dal.getKnownSurfaces.mockReset().mockResolvedValue(["terminal"]);
  dal.getWorkspaceMembers.mockReset().mockResolvedValue([]);
  dal.getWindowTimeline.mockReset().mockResolvedValue([
    {
      bucket_day: "2026-05-14",
      window_count: 3,
      message_count: 42,
      input_tokens: 5000,
      output_tokens: 2000,
      cost_cents: 150,
      avg_burn_rate: 0.5,
    },
  ]);
  dal.getThrottleEvents.mockReset().mockResolvedValue([
    {
      started_at: "2026-05-14T10:00:00Z",
      ended_at: "2026-05-14T15:00:00Z",
      duration_minutes: 300,
      message_count: 42,
      input_tokens: 5000,
      output_tokens: 2000,
      cost_cents: 150,
      burn_rate: 0.5,
      device_id: "dev_1",
      provider: "claude_code",
      surface: "terminal",
    },
  ]);
  dal.getTeamRateLimitStats.mockReset().mockResolvedValue([
    {
      bucket_day: "2026-05-14",
      users_hitting_limit: 1,
      total_throttle_windows: 1,
      total_windows: 3,
    },
  ]);
});

async function render(searchParams: Record<string, string> = {}) {
  const mod = await import("./page");
  return mod.default({ searchParams: Promise.resolve(searchParams) });
}

describe("dashboard/rate-limits /page", () => {
  it("smoke: renders Rate Limits headline and stat cards", async () => {
    const node = await render();
    expect(node).toBeTruthy();
    const text = extractText(node);
    expect(text).toContain("Rate Limits");
    expect(text).toContain("Windows");
    expect(text).toContain("Throttle events");
    expect(text).toContain("Avg burn rate");
  });

  it("shows throttle event details in the table", async () => {
    const node = await render();
    const text = extractText(node);
    expect(text).toContain("Claude Code");
    expect(text).toMatch(/300\s*m/);
  });

  it("renders team rate limit impact card for managers", async () => {
    const node = await render();
    const text = extractText(node);
    expect(text).toContain("Team Rate Limit Impact");
  });

  it("hides team rate limit card for members", async () => {
    dal.getCurrentUser.mockResolvedValue(MEMBER);
    const node = await render();
    const text = extractText(node);
    expect(text).not.toContain("Team Rate Limit Impact");
  });

  it("renders empty state when no window data exists", async () => {
    dal.getWindowTimeline.mockResolvedValue([]);
    dal.getThrottleEvents.mockResolvedValue([]);
    dal.getTeamRateLimitStats.mockResolvedValue([]);
    const node = await render();
    const text = extractText(node);
    expect(text).toContain("No window data for this period");
    expect(text).toContain("No throttle events for this period");
  });

  it("wraps filters in a Suspense boundary", async () => {
    const node = await render();
    expect(containsSuspense(node)).toBe(true);
  });

  it("returns null when the viewer has no workspace_id", async () => {
    dal.getCurrentUser.mockResolvedValue({ ...MANAGER, workspace_id: null });
    const node = await render();
    expect(node).toBeNull();
  });

  it("switches to tokens unit when ?units=tokens is set", async () => {
    const node = await render({ units: "tokens" });
    const text = extractText(node);
    expect(text).toContain("Total tokens");
    expect(text).toMatch(/Tokens\s+per Window Period/);
  });
});
