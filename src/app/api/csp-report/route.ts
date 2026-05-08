import { NextResponse, type NextRequest } from "next/server";

export const dynamic = "force-dynamic";

/**
 * POST /api/csp-report (#180)
 *
 * Receives Content-Security-Policy violation reports from the browser.
 * Browsers send these as either:
 *   - `application/csp-report` (legacy `report-uri` directive)
 *   - `application/reports+json` (Reporting API / `report-to` directive)
 *
 * The endpoint exists so we can run CSP in report-only mode and triage
 * violations before flipping to enforcing. Reports are logged to stderr;
 * downstream log shipping captures them without us standing up a separate
 * sink. Never echo the body back — it can include user-pasted URLs.
 */
export async function POST(request: NextRequest) {
  let body: unknown = null;
  try {
    body = await request.json();
  } catch {
    // Fall through; some browsers send empty bodies on opaque redirect blocks.
  }

  console.warn("[csp-report]", JSON.stringify(body));

  return new NextResponse(null, { status: 204 });
}
