import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

/**
 * #180: end-to-end smoke test for the per-request CSP. Confirms the proxy
 * stamps a CSP header (with nonce, frame-ancestors, no 'unsafe-eval') on
 * `/dashboard` and `/login` responses — the two surfaces called out in the
 * issue. Supabase auth is mocked: the proxy's only job here is the
 * security headers, redirects, and nonce wiring.
 */

let mockUser: { id: string } | null = null;

vi.mock("@supabase/ssr", () => ({
  createServerClient: () => ({
    auth: {
      getUser: async () => ({ data: { user: mockUser }, error: null }),
    },
  }),
}));

beforeEach(() => {
  mockUser = null;
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://abc.supabase.co";
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "anon_test_key";
  delete process.env.CSP_REPORT_ONLY;
});

async function callProxy(url: string) {
  const { proxy } = await import("./proxy");
  const req = new NextRequest(new Request(url));
  return proxy(req);
}

describe("proxy — CSP wiring (#180)", () => {
  it("stamps CSP-Report-Only with a nonce on /login by default", async () => {
    const res = await callProxy("http://localhost:3000/login");

    const reportOnly = res.headers.get("content-security-policy-report-only");
    expect(reportOnly).toBeTruthy();
    expect(reportOnly).toMatch(
      /script-src 'self' 'nonce-[^']+' 'strict-dynamic'/
    );
    expect(reportOnly).toContain("frame-ancestors 'none'");
    expect(reportOnly).not.toContain("unsafe-eval");
    expect(res.headers.get("report-to")).toContain("csp-endpoint");
  });

  it("stamps CSP on the /dashboard redirect for unauth users", async () => {
    mockUser = null;
    const res = await callProxy("http://localhost:3000/dashboard");

    // Unauthenticated → 307 redirect to /login.
    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toContain("/login");
    const csp =
      res.headers.get("content-security-policy") ??
      res.headers.get("content-security-policy-report-only");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).not.toContain("unsafe-eval");
  });

  it("stamps CSP on the authenticated /dashboard pass-through", async () => {
    mockUser = { id: "usr_a" };
    const res = await callProxy("http://localhost:3000/dashboard");

    const csp =
      res.headers.get("content-security-policy") ??
      res.headers.get("content-security-policy-report-only");
    expect(csp).toMatch(/script-src 'self' 'nonce-[^']+'/);
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).not.toContain("unsafe-eval");
  });

  it("uses enforcing CSP header when CSP_REPORT_ONLY=false", async () => {
    process.env.CSP_REPORT_ONLY = "false";
    vi.resetModules();

    const res = await callProxy("http://localhost:3000/login");
    expect(res.headers.get("content-security-policy")).toBeTruthy();
    expect(res.headers.get("content-security-policy-report-only")).toBeNull();
  });
});
