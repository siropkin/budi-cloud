import { describe, it, expect, beforeEach, afterEach } from "vitest";

/**
 * #180: CSP builder smoke tests. The proxy stamps these headers on every
 * non-API response so we want to keep the directive shape stable —
 * forgetting `frame-ancestors` or letting `'unsafe-eval'` slip back in are
 * the kind of regressions a smoke test catches cheaply.
 */

beforeEach(() => {
  delete process.env.CSP_REPORT_ONLY;
});

afterEach(() => {
  delete process.env.CSP_REPORT_ONLY;
});

describe("buildCsp", () => {
  it("includes a script-src nonce, strict-dynamic, and the core directives", async () => {
    const { buildCsp } = await import("./csp");
    const csp = buildCsp("abc123");

    expect(csp).toContain("script-src 'self' 'nonce-abc123' 'strict-dynamic'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("base-uri 'self'");
    expect(csp).toContain("form-action 'self'");
    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("report-uri /api/csp-report");
    expect(csp).toContain("report-to csp-endpoint");
  });

  it("never emits 'unsafe-eval'", async () => {
    const { buildCsp } = await import("./csp");
    expect(buildCsp("n")).not.toContain("unsafe-eval");
  });
});

describe("isReportOnly", () => {
  it("defaults to report-only when the env var is unset", async () => {
    const { isReportOnly } = await import("./csp");
    expect(isReportOnly()).toBe(true);
  });

  it("flips to enforcing when CSP_REPORT_ONLY is falsy", async () => {
    process.env.CSP_REPORT_ONLY = "false";
    const { isReportOnly } = await import("./csp");
    expect(isReportOnly()).toBe(false);
  });
});
