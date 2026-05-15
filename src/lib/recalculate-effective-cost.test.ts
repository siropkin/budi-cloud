import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * #233: wrapper tests for `recalculateEffectiveCost`. The math is exercised
 * by the migration (021) on CI's Postgres dry-run; here we verify the JS
 * adapter:
 *   - forwards the camelCase inputs onto the snake_case RPC args
 *   - parses the `recalc_summary` composite (numeric-as-string included) into
 *     a plain JS object the dashboard server actions can consume
 *   - tolerates the two shapes supabase-js can return composite types in
 *   - propagates RPC errors instead of swallowing them silently — a failed
 *     recalc is a load-bearing event for the audit trail in #235 and must
 *     not be lost
 */

type RpcArgs = {
  p_workspace_id: string;
  p_from_date: string;
  p_to_date: string;
  p_triggered_by: string | null;
};

type RpcResult = {
  data: unknown;
  error: unknown;
};

let lastRpc: { name: string; args: RpcArgs } | null = null;
let nextRpcResult: RpcResult = { data: null, error: null };

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    rpc: (name: string, args: RpcArgs) => {
      lastRpc = { name, args };
      return Promise.resolve(nextRpcResult);
    },
  }),
}));

beforeEach(() => {
  lastRpc = null;
  nextRpcResult = { data: null, error: null };
});

describe("recalculateEffectiveCost", () => {
  it("forwards camelCase inputs to the snake_case RPC contract", async () => {
    nextRpcResult = {
      data: {
        run_id: 42,
        rows_processed: 100,
        rows_changed: 7,
        before_total_cents: 1234.5,
        after_total_cents: 1100.25,
      },
      error: null,
    };

    const { recalculateEffectiveCost } =
      await import("./recalculate-effective-cost");

    const result = await recalculateEffectiveCost({
      workspaceId: "org_abc",
      fromDate: "2026-01-01",
      toDate: "2026-01-31",
      triggeredBy: "usr_mgr",
    });

    expect(lastRpc?.name).toBe("recalculate_effective_cost");
    expect(lastRpc?.args).toEqual({
      p_workspace_id: "org_abc",
      p_from_date: "2026-01-01",
      p_to_date: "2026-01-31",
      p_triggered_by: "usr_mgr",
    });
    expect(result).toEqual({
      runId: 42,
      rowsProcessed: 100,
      rowsChanged: 7,
      beforeTotalCents: 1234.5,
      afterTotalCents: 1100.25,
    });
  });

  it("defaults `triggeredBy` to null for the nightly pg_cron caller", async () => {
    nextRpcResult = {
      data: {
        run_id: 1,
        rows_processed: 0,
        rows_changed: 0,
        before_total_cents: 0,
        after_total_cents: 0,
      },
      error: null,
    };

    const { recalculateEffectiveCost } =
      await import("./recalculate-effective-cost");

    await recalculateEffectiveCost({
      workspaceId: "org_abc",
      fromDate: "2026-05-10",
      toDate: "2026-05-10",
    });

    expect(lastRpc?.args.p_triggered_by).toBeNull();
  });

  it("unwraps a composite returned as a one-element array (driver variant)", async () => {
    nextRpcResult = {
      data: [
        {
          run_id: "5",
          rows_processed: "10",
          rows_changed: "0",
          before_total_cents: "999.0000",
          after_total_cents: "999.0000",
        },
      ],
      error: null,
    };

    const { recalculateEffectiveCost } =
      await import("./recalculate-effective-cost");

    const result = await recalculateEffectiveCost({
      workspaceId: "org_idem",
      fromDate: "2026-01-01",
      toDate: "2026-01-31",
    });

    // NUMERIC values arriving as JS strings get coerced into real numbers so
    // downstream callers can compare them without `Number()` on every read.
    expect(result.runId).toBe(5);
    expect(result.rowsProcessed).toBe(10);
    expect(result.rowsChanged).toBe(0);
    expect(result.beforeTotalCents).toBe(999);
    expect(result.afterTotalCents).toBe(999);
  });

  it("propagates RPC errors so a failed recalc surfaces to the caller", async () => {
    nextRpcResult = {
      data: null,
      error: new Error("invalid date window [2026-02-01 .. 2026-01-01]"),
    };

    const { recalculateEffectiveCost } =
      await import("./recalculate-effective-cost");

    await expect(
      recalculateEffectiveCost({
        workspaceId: "org_abc",
        fromDate: "2026-02-01",
        toDate: "2026-01-01",
      })
    ).rejects.toThrow("invalid date window");
  });

  it("throws when the RPC returns no row (defensive)", async () => {
    nextRpcResult = { data: null, error: null };

    const { recalculateEffectiveCost } =
      await import("./recalculate-effective-cost");

    await expect(
      recalculateEffectiveCost({
        workspaceId: "org_abc",
        fromDate: "2026-01-01",
        toDate: "2026-01-31",
      })
    ).rejects.toThrow("returned no row");
  });
});
