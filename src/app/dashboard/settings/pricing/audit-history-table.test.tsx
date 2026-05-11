import { describe, it, expect } from "vitest";
import { extractText } from "@/test-utils/page-tree";
import type { RecalculationRunRow } from "@/lib/dal";
import {
  AuditHistoryTable,
  PAGE_SIZE,
  parsePage,
  parseStatusFilter,
} from "./audit-history-table";

/**
 * Tests for the Settings → Pricing → Audit history surface (#733).
 *
 * The component is a Server Component — these tests inspect the returned
 * React tree via `extractText` rather than rendering, matching the rest of
 * the dashboard's page-level coverage pattern (#112).
 */

describe("parseStatusFilter", () => {
  it("defaults to 'all' when no value is supplied", () => {
    expect(parseStatusFilter(undefined)).toBe("all");
    expect(parseStatusFilter(null)).toBe("all");
    expect(parseStatusFilter("")).toBe("all");
  });

  it("accepts the known status values verbatim", () => {
    expect(parseStatusFilter("succeeded")).toBe("succeeded");
    expect(parseStatusFilter("running")).toBe("running");
    expect(parseStatusFilter("failed")).toBe("failed");
  });

  it("coerces unknown values back to 'all' so a bad URL never zeroes the table out", () => {
    expect(parseStatusFilter("garbage")).toBe("all");
  });
});

describe("parsePage", () => {
  it("defaults to page 1", () => {
    expect(parsePage(undefined)).toBe(1);
    expect(parsePage(null)).toBe(1);
    expect(parsePage("")).toBe(1);
  });

  it("parses positive integers", () => {
    expect(parsePage("3")).toBe(3);
    expect(parsePage("12")).toBe(12);
  });

  it("rejects zero, negative, and non-numeric values", () => {
    expect(parsePage("0")).toBe(1);
    expect(parsePage("-4")).toBe(1);
    expect(parsePage("abc")).toBe(1);
  });
});

const sampleRow: RecalculationRunRow = {
  id: 42,
  startedAt: "2026-05-01T10:30:00Z",
  finishedAt: "2026-05-01T10:31:15Z",
  status: "succeeded",
  scopeFromDate: "2026-04-01",
  scopeToDate: "2026-04-30",
  priceListIds: [7, 8],
  rowsProcessed: 5000,
  rowsChanged: 4200,
  beforeTotalCents: 481_520,
  afterTotalCents: 352_777,
  triggeredBy: "usr_admin",
};

describe("AuditHistoryTable", () => {
  it("renders the row's stats and trigger label", () => {
    const tree = AuditHistoryTable({
      runs: [sampleRow],
      total: 1,
      page: 1,
      pageSize: PAGE_SIZE,
      status: "all",
      usersById: new Map([["usr_admin", "Admin Person"]]),
    });
    const text = extractText(tree);
    expect(text).toContain("Admin Person");
    expect(text).toContain("4200");
    expect(text).toContain("$4,815.20".replace(/,/g, ""));
    expect(text).toContain("succeeded");
    expect(text).toContain("2026-04-01");
  });

  it("falls back to the raw user id when the user lookup misses", () => {
    const tree = AuditHistoryTable({
      runs: [sampleRow],
      total: 1,
      page: 1,
      pageSize: PAGE_SIZE,
      status: "all",
      usersById: new Map(),
    });
    expect(extractText(tree)).toContain("usr_admin");
  });

  it("shows an empty-state hint that mentions the active filter", () => {
    const tree = AuditHistoryTable({
      runs: [],
      total: 0,
      page: 1,
      pageSize: PAGE_SIZE,
      status: "failed",
      usersById: new Map(),
    });
    const text = extractText(tree);
    expect(text).toContain("failed");
    // The empty state should not pretend the page is paginated.
    expect(text).not.toContain("Showing");
  });

  it("omits the pager when total fits on one page", () => {
    const tree = AuditHistoryTable({
      runs: [sampleRow],
      total: 1,
      page: 1,
      pageSize: PAGE_SIZE,
      status: "all",
      usersById: new Map(),
    });
    expect(extractText(tree)).not.toContain("Previous");
  });

  it("renders the pager when total exceeds one page", () => {
    const tree = AuditHistoryTable({
      runs: Array(PAGE_SIZE).fill(sampleRow),
      total: PAGE_SIZE * 3,
      page: 2,
      pageSize: PAGE_SIZE,
      status: "all",
      usersById: new Map(),
    });
    const text = extractText(tree);
    expect(text).toContain("Previous");
    expect(text).toContain("Next");
    // `extractText` joins separate React children with spaces, so the literal
    // "Page 2 / 3" arrives with extra whitespace. Assert the parts instead.
    expect(text).toMatch(/Page\s+2\s+\/\s+3/);
    expect(text).toMatch(/Showing\s+51\s*–\s*100\s+of\s+150/);
  });
});
