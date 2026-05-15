import { NextResponse } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { isInvitePath, isSafeNextPath } from "@/lib/auth-redirect";
import { randomBytes } from "crypto";

const DEFAULT_WORKSPACE_NAME = "Your workspace";

/**
 * Create a default workspace ("Your workspace") and link the user to it as
 * manager. The workspace has no special flags — it's identical to one the
 * user would create themselves through settings, so rename/delete/invite all
 * work the same (issue #314).
 *
 * Callers must ensure the user is not arriving via an invite link; in that
 * case the invite page assigns the workspace instead and short-circuiting here
 * would silently break the invite (issue #62).
 */
async function createDefaultWorkspace(
  admin: SupabaseClient,
  userId: string
): Promise<{ error: string | null }> {
  const workspaceId = `ws_${randomBytes(12).toString("base64url")}`;
  const { error: workspaceError } = await admin.from("workspaces").insert({
    id: workspaceId,
    name: DEFAULT_WORKSPACE_NAME,
  });
  if (workspaceError) return { error: workspaceError.message };

  const { error: userError } = await admin
    .from("users")
    .update({ workspace_id: workspaceId, role: "manager" })
    .eq("id", userId);
  if (userError) return { error: userError.message };

  return { error: null };
}

/**
 * OAuth callback handler for Supabase Auth.
 * Exchanges the code for a session, then ensures a budi `users` row exists.
 *
 * The `?next=<path>` query param is preserved across the auth round-trip
 * by `buildAuthCallbackUrl` on the login page. When `next` points at an
 * invite link, this handler must NOT auto-provision a workspace: the invite
 * page is responsible for joining the user to the inviter's workspace. Creating
 * one here first would silently break the invite (issue #62).
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
    .select("id, workspace_id, display_name")
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
      workspace_id: null, // Will be set when creating/joining a workspace
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

    // Came in via an invite link — let the invite page assign the workspace.
    if (cameFromInvite) {
      return NextResponse.redirect(`${origin}${next}`);
    }

    // Auto-provision a default workspace so first-time users skip the
    // workspace-creation step entirely (issue #314).
    const { error: workspaceError } = await createDefaultWorkspace(
      admin,
      user.id
    );
    if (workspaceError) {
      console.error("Failed to create default workspace:", workspaceError);
      return NextResponse.redirect(
        `${origin}/login?error=workspace_creation_failed`
      );
    }

    return NextResponse.redirect(`${origin}${next}`);
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

  // If user has no workspace, send them to the invite page when they came via
  // one — otherwise auto-provision a default workspace so they never end up
  // stranded on a setup screen (issue #314).
  if (!existingUser.workspace_id) {
    if (cameFromInvite) {
      return NextResponse.redirect(`${origin}${next}`);
    }
    const { error: workspaceError } = await createDefaultWorkspace(
      admin,
      user.id
    );
    if (workspaceError) {
      console.error("Failed to create default workspace:", workspaceError);
      return NextResponse.redirect(
        `${origin}/login?error=workspace_creation_failed`
      );
    }
    return NextResponse.redirect(`${origin}${next}`);
  }

  return NextResponse.redirect(`${origin}${next}`);
}
