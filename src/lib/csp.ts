/**
 * Content-Security-Policy builder used by the proxy (#180).
 *
 * Strategy: nonce + 'strict-dynamic' for scripts. Per-request nonce means CSP
 * has to be set in the proxy (not in `next.config.ts`). Next.js automatically
 * applies the nonce to its bootstrap scripts when it sees `x-nonce` on the
 * forwarded request headers.
 *
 * Defaults to *report-only* so violations are surfaced before we enforce
 * (the issue explicitly recommends one release in report-only). Flip with
 * `CSP_REPORT_ONLY=false` once the report stream is clean.
 */

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";

let supabaseOrigin = "";
let supabaseWsOrigin = "";
try {
  if (SUPABASE_URL) {
    const u = new URL(SUPABASE_URL);
    supabaseOrigin = u.origin;
    supabaseWsOrigin = `wss://${u.host}`;
  }
} catch {
  // Misconfigured env — fall back to wildcard so auth still works rather
  // than silently blocking it via CSP.
  supabaseOrigin = "https://*.supabase.co";
  supabaseWsOrigin = "wss://*.supabase.co";
}

export function generateNonce(): string {
  // crypto.randomUUID is available on Node 19+ and the Edge runtime.
  return Buffer.from(crypto.randomUUID()).toString("base64");
}

export function buildCsp(nonce: string): string {
  const connectSrc = ["'self'", supabaseOrigin, supabaseWsOrigin]
    .filter(Boolean)
    .join(" ");

  const directives = [
    `default-src 'self'`,
    // 'strict-dynamic' lets nonce'd scripts (Next.js bootstrap, framework
    // chunks) load further scripts they need without us enumerating CDNs.
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic' https:`,
    // Tailwind/Next emit inline <style> blocks; 'unsafe-inline' is a known
    // necessary evil here. Worth revisiting if Next ships nonced styles.
    `style-src 'self' 'unsafe-inline'`,
    `img-src 'self' data: blob: https:`,
    `font-src 'self' data:`,
    `connect-src ${connectSrc}`,
    `frame-ancestors 'none'`,
    `frame-src 'none'`,
    `object-src 'none'`,
    `base-uri 'self'`,
    `form-action 'self'`,
    `upgrade-insecure-requests`,
    `report-uri /api/csp-report`,
    `report-to csp-endpoint`,
  ];

  return directives.join("; ");
}

export function isReportOnly(): boolean {
  // Default to report-only (issue #180 recommends one release in
  // report-only before flipping to enforcing).
  const v = process.env.CSP_REPORT_ONLY;
  if (v === undefined) return true;
  return !["0", "false", "no", "off"].includes(v.toLowerCase());
}

export function reportToHeaderValue(): string {
  return JSON.stringify({
    group: "csp-endpoint",
    max_age: 10886400,
    endpoints: [{ url: "/api/csp-report" }],
  });
}
