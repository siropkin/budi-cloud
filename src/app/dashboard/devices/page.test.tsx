import { describe, it, expect, vi, beforeEach } from "vitest";
import { containsSuspense, extractText } from "@/test-utils/page-tree";

/**
 * Page-level coverage for `/dashboard/devices` (#284).
 *
 * Mirrors the ladder used by the other surfaces:
 *   1. Smoke — manager view renders the Devices headline, the bar/table card
 *      and the two time-series cards with their headline stat tiles.
 *   2. Empty — empty `getCostByDevice` collapses the per-device card to its
 *      chart-only empty state and the headline tiles render the em-dash.
 *   3. Units — `?units=tokens` swaps every "Cost" label to "Tokens".
 *   4. Loading — the filter cluster is wrapped in a `<Suspense>` boundary.
 *   5. Error — DAL faults propagate so the framework error boundary fires.
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
  getCostByDevice: vi.fn(),
  getDeviceActivityByDay: vi.fn(),
  getEarliestActivity: vi.fn(),
  getWorkspaceMembers: vi.fn(),
  getKnownSurfaces: vi.fn(),
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

beforeEach(() => {
  dal.getCurrentUser.mockReset().mockResolvedValue(MANAGER);
  dal.getCostByDevice.mockReset().mockResolvedValue([
    {
      id: "dev_alpha",
      label: "laptop",
      owner_name: "Ivan",
      last_seen: "2026-05-01T00:00:00Z",
      cost_cents: 800_00,
      input_tokens: 600_000,
      output_tokens: 200_000,
    },
    {
      id: "dev_beta",
      label: null,
      owner_name: "Jane",
      last_seen: "2026-05-02T00:00:00Z",
      cost_cents: 200_00,
      input_tokens: 150_000,
      output_tokens: 50_000,
    },
  ]);
  dal.getDeviceActivityByDay.mockReset().mockResolvedValue([
    {
      bucket_day: "2026-05-01",
      active_devices: 2,
      cost_cents: 600_00,
      input_tokens: 500_000,
      output_tokens: 150_000,
    },
    {
      bucket_day: "2026-05-02",
      active_devices: 1,
      cost_cents: 400_00,
      input_tokens: 250_000,
      output_tokens: 100_000,
    },
  ]);
  dal.getEarliestActivity.mockReset().mockResolvedValue("2026-04-01");
  dal.getWorkspaceMembers.mockReset().mockResolvedValue([]);
  dal.getKnownSurfaces.mockReset().mockResolvedValue(["cursor", "vscode"]);
});

async function render(searchParams: Record<string, string> = {}) {
  const mod = await import("./page");
  return mod.default({ searchParams: Promise.resolve(searchParams) });
}

describe("dashboard/devices /page", () => {
  it("smoke: renders Devices headline, all three cards, the manager-only owner-disambiguated label and the headline stat tiles", async () => {
    const node = await render();
    expect(node).toBeTruthy();
    const text = extractText(node);
    expect(text).toContain("Devices");
    expect(text).toContain("Cost by Device");
    expect(text).toContain("Device Count");
    expect(text).toContain("Cost per Device");
    // Labelled device with manager-view owner suffix; unlabelled device falls
    // back to the `device <suffix>` form from `deviceLabel`.
    expect(text).toContain("laptop — Ivan");
    expect(text).toContain("device beta");
    // Headline tiles: 2 active devices, $1000 total / 2 = $500 avg per device.
    expect(text).toContain("Active devices");
    expect(text).toContain("Avg cost per device");
    expect(text).toContain("$500.00");
  });

  it("units=tokens: every Cost label flips to Tokens and the per-device average becomes a token count", async () => {
    const node = await render({ units: "tokens" });
    const text = extractText(node);
    expect(text).toContain("Tokens by Device");
    expect(text).toContain("Tokens per Device");
    expect(text).toContain("Avg tokens per device");
    expect(text).not.toContain("Avg cost per device");
    // (600k+200k + 150k+50k) / 2 distinct active devices = 500,000 tokens/device,
    // which `fmtNum` collapses to "500.0K".
    expect(text).toContain("500.0K");
  });

  it("excludes zero-activity devices from the headline math (mirrors the Team-page UNASSIGNED exclusion)", async () => {
    dal.getCostByDevice.mockResolvedValue([
      {
        id: "dev_alpha",
        label: "laptop",
        owner_name: "Ivan",
        last_seen: "2026-05-01T00:00:00Z",
        cost_cents: 1_000_00,
        input_tokens: 100,
        output_tokens: 50,
      },
      {
        id: "dev_idle",
        label: "idle",
        owner_name: "Jane",
        last_seen: null,
        cost_cents: 0,
        input_tokens: 0,
        output_tokens: 0,
      },
    ]);
    const node = await render();
    const text = extractText(node);
    // 1 active device, $1,000 from that device ⇒ $1,000 avg per device. The
    // idle row must not pull the divisor up to 2 (which would give $500).
    expect(text).toContain("$1000.00");
    expect(text).not.toContain("$500.00");
  });

  it("empty: collapses the per-device card to the chart-only empty-state and renders em-dash headlines", async () => {
    dal.getCostByDevice.mockResolvedValue([]);
    dal.getDeviceActivityByDay.mockResolvedValue([]);
    const node = await render();
    expect(node).toBeTruthy();
    const text = extractText(node);
    expect(text).toContain("No device cost data for this period");
    // No active devices ⇒ both stat tiles render the em-dash sentinel rather
    // than `0` or `NaN`.
    expect(text).toContain("—");
  });

  it("loading: composes a Suspense boundary around the filter cluster", async () => {
    const node = await render();
    expect(containsSuspense(node)).toBe(true);
  });

  it("error: a DAL fault propagates so the framework error boundary can render its fallback", async () => {
    dal.getCostByDevice.mockRejectedValue(new Error("__DAL_BOOM__"));
    await expect(render()).rejects.toThrow("__DAL_BOOM__");
  });

  it("returns null (no leak) when the viewer has no workspace_id yet", async () => {
    dal.getCurrentUser.mockResolvedValue({ ...MANAGER, workspace_id: null });
    const node = await render();
    expect(node).toBeNull();
  });
});
