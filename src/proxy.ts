import { type NextRequest, NextResponse } from "next/server";
import { createServerClient } from "@supabase/ssr";
import {
  buildCsp,
  generateNonce,
  isReportOnly,
  reportToHeaderValue,
} from "@/lib/csp";

/**
 * Next.js 16 Proxy (formerly Middleware).
 *
 * Refreshes the Supabase auth session on every navigation, protects
 * /dashboard/* routes from unauthenticated users, and stamps a per-request
 * Content-Security-Policy with a nonce (#180).
 */
export async function proxy(request: NextRequest) {
  // CSP nonce is generated per request so 'strict-dynamic' can pin script
  // trust to scripts we render. The nonce travels via request headers so the
  // App Router picks it up and applies it to its own injected scripts.
  const nonce = generateNonce();
  const csp = buildCsp(nonce);
  const cspHeaderName = isReportOnly()
    ? "Content-Security-Policy-Report-Only"
    : "Content-Security-Policy";

  const requestHeaders = new Headers(request.headers);
  requestHeaders.set("x-nonce", nonce);
  // Forwarding the policy on the request lets Next strip it from inline
  // scripts where we cannot annotate them, per the App Router CSP guide.
  requestHeaders.set("content-security-policy", csp);

  let supabaseResponse = NextResponse.next({
    request: { headers: requestHeaders },
  });

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet) {
          for (const { name, value } of cookiesToSet) {
            request.cookies.set(name, value);
          }
          supabaseResponse = NextResponse.next({
            request: { headers: requestHeaders },
          });
          for (const { name, value, options } of cookiesToSet) {
            supabaseResponse.cookies.set(name, value, options);
          }
        },
      },
    }
  );

  // Refresh session — important for keeping auth tokens valid.
  const {
    data: { user },
  } = await supabase.auth.getUser();

  const path = request.nextUrl.pathname;

  const stampSecurityHeaders = (res: NextResponse) => {
    res.headers.set(cspHeaderName, csp);
    res.headers.set("Report-To", reportToHeaderValue());
    return res;
  };

  // Protect dashboard routes
  if (path.startsWith("/dashboard") && !user) {
    const url = request.nextUrl.clone();
    url.pathname = "/login";
    url.searchParams.set("next", path);
    const redirect = NextResponse.redirect(url);
    supabaseResponse.cookies.getAll().forEach((cookie) => {
      redirect.cookies.set(cookie.name, cookie.value);
    });
    return stampSecurityHeaders(redirect);
  }

  // Redirect authenticated users away from login
  if (path === "/login" && user) {
    const next = request.nextUrl.searchParams.get("next") || "/dashboard";
    const url = request.nextUrl.clone();
    url.pathname = next;
    url.searchParams.delete("next");
    const redirect = NextResponse.redirect(url);
    supabaseResponse.cookies.getAll().forEach((cookie) => {
      redirect.cookies.set(cookie.name, cookie.value);
    });
    return stampSecurityHeaders(redirect);
  }

  return stampSecurityHeaders(supabaseResponse);
}

export const config = {
  matcher: [
    // Run on all routes except static files and API routes
    "/((?!_next/static|_next/image|favicon.ico|api/).*)",
  ],
};
