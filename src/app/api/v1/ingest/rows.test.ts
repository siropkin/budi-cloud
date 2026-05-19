import { describe, it, expect } from "vitest";
import {
  buildWindowRows,
  validateIngestMetrics,
  type IngestWindowSummary,
} from "./rows";

const baseWindow: IngestWindowSummary = {
  started_at: "2026-05-14T10:00:00Z",
  ended_at: "2026-05-14T15:00:00Z",
  duration_minutes: 300,
  is_active: false,
  message_count: 42,
  input_tokens: 5000,
  output_tokens: 2000,
  cache_creation_tokens: 100,
  cache_read_tokens: 300,
  cost_cents: 150,
  burn_rate_cents_per_minute: 0.5,
  hit_rate_limit: true,
  provider: "claude_code",
  surface: "terminal",
};

describe("buildWindowRows", () => {
  it("maps all fields to the database row shape", () => {
    const rows = buildWindowRows("dev_1", "2026-05-15T00:00:00Z", [baseWindow]);

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      device_id: "dev_1",
      started_at: "2026-05-14T10:00:00Z",
      ended_at: "2026-05-14T15:00:00Z",
      duration_minutes: 300,
      is_active: false,
      message_count: 42,
      input_tokens: 5000,
      output_tokens: 2000,
      cache_creation_tokens: 100,
      cache_read_tokens: 300,
      cost_cents: 150,
      burn_rate_cents_per_minute: 0.5,
      hit_rate_limit: true,
      provider: "claude_code",
      surface: "terminal",
      synced_at: "2026-05-15T00:00:00Z",
    });
  });

  it("defaults optional booleans to false when missing", () => {
    const { is_active, hit_rate_limit, ...rest } = baseWindow;
    void is_active;
    void hit_rate_limit;
    const rows = buildWindowRows("dev_1", "2026-05-15T00:00:00Z", [
      rest as IngestWindowSummary,
    ]);

    expect(rows[0].is_active).toBe(false);
    expect(rows[0].hit_rate_limit).toBe(false);
  });

  it("normalizes missing surface and provider to 'unknown'", () => {
    const rows = buildWindowRows("dev_1", "2026-05-15T00:00:00Z", [
      { ...baseWindow, provider: null, surface: null },
    ]);

    expect(rows[0].provider).toBe("unknown");
    expect(rows[0].surface).toBe("unknown");
  });

  it("clamps negative metrics to zero", () => {
    const rows = buildWindowRows("dev_1", "2026-05-15T00:00:00Z", [
      {
        ...baseWindow,
        cost_cents: -10,
        input_tokens: -5,
      } as IngestWindowSummary,
    ]);

    expect(rows[0].cost_cents).toBe(0);
    expect(rows[0].input_tokens).toBe(0);
  });

  it("caps metrics at their configured max", () => {
    const rows = buildWindowRows("dev_1", "2026-05-15T00:00:00Z", [
      { ...baseWindow, cost_cents: 1e12, duration_minutes: 9999 },
    ]);

    expect(rows[0].cost_cents).toBe(1e8);
    expect(rows[0].duration_minutes).toBe(600);
  });
});

describe("validateIngestMetrics — window_summaries", () => {
  it("returns null for valid window summaries", () => {
    const result = validateIngestMetrics([], [], [baseWindow]);
    expect(result).toBeNull();
  });

  it("rejects NaN in message_count", () => {
    const result = validateIngestMetrics(
      [],
      [],
      [{ ...baseWindow, message_count: NaN }]
    );
    expect(result).toMatch(/window_summaries\[0\].message_count/);
  });

  it("rejects negative cost_cents", () => {
    const result = validateIngestMetrics(
      [],
      [],
      [{ ...baseWindow, cost_cents: -1 }]
    );
    expect(result).toMatch(/window_summaries\[0\].cost_cents/);
  });

  it("rejects Infinity in duration_minutes", () => {
    const result = validateIngestMetrics(
      [],
      [],
      [{ ...baseWindow, duration_minutes: Infinity }]
    );
    expect(result).toMatch(/window_summaries\[0\].duration_minutes/);
  });

  it("rejects negative burn_rate_cents_per_minute", () => {
    const result = validateIngestMetrics(
      [],
      [],
      [{ ...baseWindow, burn_rate_cents_per_minute: -0.5 }]
    );
    expect(result).toMatch(/window_summaries\[0\].burn_rate_cents_per_minute/);
  });

  it("skips validation when windows array is undefined", () => {
    const result = validateIngestMetrics([], [], undefined);
    expect(result).toBeNull();
  });
});
