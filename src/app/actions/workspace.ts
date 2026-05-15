"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { randomBytes } from "crypto";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";

export async function createWorkspace(
  _prevState: { error: string } | undefined,
  formData: FormData
) {
  const name = formData.get("name") as string;
  if (!name?.trim()) return { error: "Workspace name is required" };

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { error: "Not authenticated" };

  const admin = createAdminClient();
  // New workspaces mint `ws_` IDs. Existing rows minted before this change
  // keep their `org_` prefix — IDs are opaque, never reformatted in place.
  const workspaceId = `ws_${randomBytes(12).toString("base64url")}`;

  // Create the workspace
  const { error: workspaceError } = await admin.from("workspaces").insert({
    id: workspaceId,
    name: name.trim(),
  });
  if (workspaceError) return { error: "Failed to create workspace" };

  // Link user to workspace as manager
  const { error: userError } = await admin
    .from("users")
    .update({ workspace_id: workspaceId, role: "manager" })
    .eq("id", user.id);
  if (userError) return { error: "Failed to link user to workspace" };

  redirect("/dashboard");
}

export async function generateInviteToken() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { error: "Not authenticated" };

  const admin = createAdminClient();
  const { data: budiUser } = await admin
    .from("users")
    .select("id, workspace_id, role")
    .eq("id", user.id)
    .single();

  if (!budiUser?.workspace_id || budiUser.role !== "manager") {
    return { error: "Only managers can create invite tokens" };
  }

  const token = randomBytes(24).toString("base64url");
  const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000); // 7 days

  const { error } = await admin.from("invite_tokens").insert({
    id: token,
    workspace_id: budiUser.workspace_id,
    role: "member",
    created_by: budiUser.id,
    expires_at: expiresAt.toISOString(),
  });

  if (error) return { error: "Failed to create invite token" };

  return { token };
}

/**
 * Manager-only: nuke an entire workspace and every piece of synced data tied
 * to it.
 *
 * The caller must type the workspace name into `formData.confirm` — this is
 * the only typed-confirmation the settings UI requires for a destructive
 * action, mirroring the GitHub "type the name to continue" pattern. We
 * re-verify both the role and the confirmation text on the server so a
 * crafted request can't skip either check.
 *
 * Deletion cascades in dependency order (see `WORKSPACE_CASCADE_ORDER` in
 * `./workspace-cascade.ts`). Supabase auth rows (`auth.users`) are
 * intentionally left intact so former members can still sign in and
 * create/join a different workspace.
 */
export async function deleteWorkspace(
  _prevState: { error: string } | undefined,
  formData: FormData
): Promise<{ error: string } | void> {
  const confirm = String(formData.get("confirm") ?? "");

  const supabase = await createClient();
  const {
    data: { user: authUser },
  } = await supabase.auth.getUser();
  if (!authUser) return { error: "Not authenticated" };

  const admin = createAdminClient();
  const { data: me } = await admin
    .from("users")
    .select("id, workspace_id, role")
    .eq("id", authUser.id)
    .single();

  if (!me?.workspace_id) return { error: "No workspace to delete" };
  if (me.role !== "manager") {
    return { error: "Only managers can delete the workspace" };
  }

  const { data: workspace } = await admin
    .from("workspaces")
    .select("id, name")
    .eq("id", me.workspace_id)
    .single();
  if (!workspace) return { error: "Workspace not found" };

  if (confirm.trim() !== workspace.name) {
    return { error: "Type the workspace name exactly to confirm" };
  }

  const workspaceId = workspace.id as string;

  // The cascade runs server-side in a single transaction
  // (`delete_workspace_cascade` in migration 025). Doing it in SQL avoids the
  // original bug where six independent `supabase.from(...).delete()` calls
  // swallowed FK violations and left the workspace half-deleted (#276):
  // supabase-js returns `{ data, error }` instead of throwing, so any
  // unchecked statement is a silent failure. Surface the RPC error to the UI
  // rather than redirecting on it.
  const { error: rpcError } = await admin.rpc("delete_workspace_cascade", {
    p_workspace_id: workspaceId,
  });
  if (rpcError) {
    return { error: `Failed to delete workspace: ${rpcError.message}` };
  }

  await supabase.auth.signOut();
  redirect("/login");
}

/**
 * Member-only: leave the current workspace. Deletes the caller's devices and
 * sync data, then nulls their `workspace_id` so they survive as a user who
 * can join or create a different workspace on next sign-in.
 *
 * Managers are refused here to avoid orphaning a workspace with no one who
 * can invite or delete — they should use `deleteWorkspace` instead (a lone
 * manager leaving is, functionally, a workspace deletion). Once we grow a
 * promote-to-manager flow this check can relax.
 */
export async function leaveWorkspace(): Promise<{ error: string } | void> {
  const supabase = await createClient();
  const {
    data: { user: authUser },
  } = await supabase.auth.getUser();
  if (!authUser) return { error: "Not authenticated" };

  const admin = createAdminClient();
  const { data: me } = await admin
    .from("users")
    .select("id, workspace_id, role")
    .eq("id", authUser.id)
    .single();

  if (!me?.workspace_id) return { error: "Not a member of any workspace" };
  if (me.role === "manager") {
    return {
      error:
        "Managers can't leave a workspace. Delete it instead, or hand off ownership first.",
    };
  }

  const userId = me.id as string;
  const { data: myDevices } = await admin
    .from("devices")
    .select("id")
    .eq("user_id", userId);
  const deviceIds = (myDevices ?? []).map((d) => d.id as string);

  // Per-table deletes here (rather than an RPC) because the surface is small
  // and bounded to the caller's own devices — but we still have to check
  // `{ error }` on every statement. The original implementation in #276
  // didn't, and that's what let `deleteWorkspace` look successful while
  // FK-violating against the price-list tables. Apply the same discipline
  // here so a future column referencing `users(id)` doesn't repeat the bug
  // for `leaveWorkspace` either.
  if (deviceIds.length > 0) {
    const { error: sessionsError } = await admin
      .from("session_summaries")
      .delete()
      .in("device_id", deviceIds);
    if (sessionsError) {
      return {
        error: `Failed to leave workspace: ${sessionsError.message}`,
      };
    }
    const { error: rollupsError } = await admin
      .from("daily_rollups")
      .delete()
      .in("device_id", deviceIds);
    if (rollupsError) {
      return { error: `Failed to leave workspace: ${rollupsError.message}` };
    }
    const { error: devicesError } = await admin
      .from("devices")
      .delete()
      .eq("user_id", userId);
    if (devicesError) {
      return { error: `Failed to leave workspace: ${devicesError.message}` };
    }
  }

  const { error: updateError } = await admin
    .from("users")
    .update({ workspace_id: null, role: "member" })
    .eq("id", userId);
  if (updateError) {
    return { error: `Failed to leave workspace: ${updateError.message}` };
  }

  await supabase.auth.signOut();
  redirect("/login");
}

/**
 * Member-only: switch the caller from their current workspace to the one an
 * invite token belongs to. The opt-in alternative to the dead-end "Already
 * in a Workspace" screen on `/invite/[token]` (#72).
 *
 * Devices, daily rollups, and session summaries are keyed off `user_id`
 * (transitively through `devices`), so flipping `users.workspace_id` is
 * enough to carry every piece of synced data with the user — there's no
 * DELETE in this action by design. The original workspace loses visibility
 * on the caller's data the moment the update commits.
 *
 * Managers are refused for the same reason `leaveWorkspace` refuses them: a
 * sole manager switching out would orphan the workspace with no one able to
 * invite, promote, or delete. They have to delete the workspace first (or,
 * once we ship one, hand off ownership).
 *
 * The token is re-validated server-side. The form-supplied
 * `targetWorkspaceId` is cross-checked against the token's `workspace_id` so
 * a tampered request can't land the user in a workspace the token wasn't
 * issued for.
 */
export async function switchWorkspace(
  _prevState: { error: string } | undefined,
  formData: FormData
): Promise<{ error: string } | void> {
  const tokenId = String(formData.get("token") ?? "");
  const targetWorkspaceId = String(formData.get("targetWorkspaceId") ?? "");
  const confirm = String(formData.get("confirm") ?? "");

  const supabase = await createClient();
  const {
    data: { user: authUser },
  } = await supabase.auth.getUser();
  if (!authUser) return { error: "Not authenticated" };

  const admin = createAdminClient();
  const { data: me } = await admin
    .from("users")
    .select("id, workspace_id, role")
    .eq("id", authUser.id)
    .single();

  if (!me?.workspace_id) return { error: "Not a member of any workspace" };
  if (me.role === "manager") {
    return {
      error:
        "Managers can't switch workspaces. Delete this workspace or hand off ownership first.",
    };
  }

  const { data: invite } = await admin
    .from("invite_tokens")
    .select("id, workspace_id, role, expires_at")
    .eq("id", tokenId)
    .single();

  if (!invite) return { error: "Invite link is invalid" };
  if (new Date(invite.expires_at as string) < new Date()) {
    return { error: "Invite link has expired" };
  }
  if (invite.workspace_id !== targetWorkspaceId) {
    return { error: "Invite link does not match the target workspace" };
  }
  if (invite.workspace_id === me.workspace_id) {
    return { error: "You are already a member of that workspace" };
  }

  const { data: targetWorkspace } = await admin
    .from("workspaces")
    .select("id, name")
    .eq("id", invite.workspace_id as string)
    .single();
  if (!targetWorkspace) return { error: "Target workspace not found" };

  if (confirm.trim() !== (targetWorkspace.name as string)) {
    return { error: "Type the workspace name exactly to confirm" };
  }

  const { error: updateError } = await admin
    .from("users")
    .update({ workspace_id: invite.workspace_id, role: invite.role })
    .eq("id", me.id as string);
  if (updateError) return { error: "Failed to switch workspace" };

  // Audit row, same shape as a fresh join. Idempotent on (token, user) so a
  // re-click after the switch is a no-op rather than a duplicate-key error.
  await admin
    .from("invite_redemptions")
    .upsert(
      { token_id: tokenId, user_id: me.id as string },
      { onConflict: "token_id,user_id", ignoreDuplicates: true }
    );

  redirect("/dashboard");
}

/**
 * Manager-only: change another workspace member's role between `member` and
 * `manager`. Self-edits go through the same path so the server's safety
 * guards (in particular the last-manager check) apply uniformly.
 *
 * The admin client bypasses RLS, so this action has to scope every read
 * and write to the caller's `workspace_id` itself — a manager from workspace
 * A must never be able to flip a user in workspace B.
 *
 * The "last manager" guard mirrors the invariant enforced by
 * `leaveWorkspace`: a workspace must always have ≥1 manager. Without this
 * check a sole manager could demote themselves and orphan the workspace
 * with no one able to invite, promote, or delete it.
 */
export async function updateMemberRole(
  targetUserId: string,
  newRole: string
): Promise<{ ok?: true; error?: string }> {
  if (newRole !== "member" && newRole !== "manager") {
    return { error: "Invalid role" };
  }

  const supabase = await createClient();
  const {
    data: { user: authUser },
  } = await supabase.auth.getUser();
  if (!authUser) return { error: "Not authenticated" };

  const admin = createAdminClient();
  const { data: me } = await admin
    .from("users")
    .select("id, workspace_id, role")
    .eq("id", authUser.id)
    .single();

  if (!me?.workspace_id || me.role !== "manager") {
    return { error: "Only managers can change member roles" };
  }

  const { data: target } = await admin
    .from("users")
    .select("id, workspace_id, role")
    .eq("id", targetUserId)
    .single();

  if (!target || target.workspace_id !== me.workspace_id) {
    return { error: "User is not a member of your workspace" };
  }

  if (target.role === newRole) return { ok: true };

  if (target.role === "manager" && newRole === "member") {
    const { data: managers } = await admin
      .from("users")
      .select("id")
      .eq("workspace_id", me.workspace_id)
      .eq("role", "manager");
    if ((managers?.length ?? 0) <= 1) {
      return {
        error: "Can't demote the last manager — promote someone else first.",
      };
    }
  }

  const { error: updateError } = await admin
    .from("users")
    .update({ role: newRole })
    .eq("id", targetUserId);
  if (updateError) return { error: "Failed to update role" };

  revalidatePath("/dashboard/settings");
  return { ok: true };
}
