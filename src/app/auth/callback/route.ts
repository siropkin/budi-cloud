import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { isInvitePath, isSafeNextPath } from "@/lib/auth-redirect";
import { randomBytes } from "crypto";

/**
 * OAuth callback handler for Supabase Auth.
 * Exchanges the code for a session, then ensures a budi `users` row exists.
 *
 * The `?next=<path>` query param is preserved across the auth round-trip
 * by `buildAuthCallbackUrl` on the login page. When `next` points at an
 * invite link, this handler must NOT short-circuit to `/setup`: the invite
 * page is responsible for joining the user to the inviter's org. Sending
 * a brand-new user to `/setup` first would auto-provision a personal org
 * and silently break the invite (issue #62).
 */
export async function GET(request: Request) {
  const { searchParams, origin } = new URL(request.url);
  const code = searchParams.get("code");
  const rawNext = searchParams.get("next");
  const next = isSafeNextPath(rawNext) ? rawNext : "/dashboard";
  const cameFromInvite = isInvitePath(rawNext);

  if (!code) {
    return NextResponse.redirect(`${origin}/login?error=missing_code`);
  }

  const supabase = await createClient();
  const { error } = await supabase.auth.exchangeCodeForSession(code);

  if (error) {
    return NextResponse.redirect(`${origin}/login?error=auth_failed`);
  }

  // Get the authenticated user
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.redirect(`${origin}/login?error=no_user`);
  }

  // Ensure a budi users row exists (uses admin client to bypass RLS for upsert)
  const admin = createAdminClient();
  const { data: existingUser } = await admin
    .from("users")
    .select("id, org_id, display_name")
    .eq("id", user.id)
    .single();

  if (!existingUser) {
    // First sign-in: create the users row
    const apiKey = `budi_${randomBytes(24).toString("base64url")}`;
    const displayName =
      user.user_metadata?.full_name ||
      user.user_metadata?.name ||
      user.email?.split("@")[0] ||
      "User";

    const { error: insertError } = await admin.from("users").insert({
      id: user.id,
      org_id: null, // Will be set when creating/joining an org
      role: "manager", // First user defaults to manager
      api_key: apiKey,
      display_name: displayName,
      email: user.email,
    });

    if (insertError) {
      console.error("Failed to create user record:", insertError);
      return NextResponse.redirect(
        `${origin}/login?error=user_creation_failed`
      );
    }

    // Came in via an invite link — let the invite page assign the org.
    if (cameFromInvite) {
      return NextResponse.redirect(`${origin}${next}`);
    }

    // New user with no org — redirect to setup
    return NextResponse.redirect(`${origin}/setup`);
  }

  // Existing user — update email/display_name if changed
  const displayName =
    user.user_metadata?.full_name ||
    user.user_metadata?.name ||
    existingUser.display_name;
  if (displayName || user.email) {
    await admin
      .from("users")
      .update({
        ...(displayName && { display_name: displayName }),
        ...(user.email && { email: user.email }),
      })
      .eq("id", user.id);
  }

  // If user has no org, send them to the invite page when they came via
  // one — otherwise to setup so they can create their own org.
  if (!existingUser.org_id) {
    if (cameFromInvite) {
      return NextResponse.redirect(`${origin}${next}`);
    }
    return NextResponse.redirect(`${origin}/setup`);
  }

  return NextResponse.redirect(`${origin}${next}`);
}
