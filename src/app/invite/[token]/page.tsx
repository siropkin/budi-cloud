import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { randomBytes } from "crypto";
import { CrossOrgSwitch } from "./cross-org-switch";

export const dynamic = "force-dynamic";

export default async function InvitePage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;
  const admin = createAdminClient();

  // Validate the invite token
  const { data: invite } = await admin
    .from("invite_tokens")
    .select("id, org_id, role, expires_at")
    .eq("id", token)
    .single();

  if (!invite) {
    return (
      <main className="flex min-h-screen items-center justify-center bg-[#0a0a0a]">
        <div className="text-center">
          <h1 className="text-xl font-bold text-white">Invalid Invite</h1>
          <p className="mt-2 text-zinc-400">This invite link is invalid.</p>
        </div>
      </main>
    );
  }

  if (new Date(invite.expires_at) < new Date()) {
    return (
      <main className="flex min-h-screen items-center justify-center bg-[#0a0a0a]">
        <div className="text-center">
          <h1 className="text-xl font-bold text-white">Expired</h1>
          <p className="mt-2 text-zinc-400">
            This invite link has expired. Ask your manager for a new one.
          </p>
        </div>
      </main>
    );
  }

  // Check if user is authenticated
  const supabase = await createClient();
  const {
    data: { user: authUser },
  } = await supabase.auth.getUser();

  if (!authUser) {
    // Redirect to login with return URL
    redirect(`/login?next=/invite/${token}`);
  }

  // Check if user already exists
  const { data: existingUser } = await admin
    .from("users")
    .select("id, org_id, role")
    .eq("id", authUser.id)
    .single();

  if (existingUser?.org_id) {
    // User already in an org
    if (existingUser.org_id === invite.org_id) {
      // Re-click by an already-joined member is idempotent.
      await admin
        .from("invite_redemptions")
        .upsert(
          { token_id: token, user_id: authUser.id },
          { onConflict: "token_id,user_id", ignoreDuplicates: true }
        );
      redirect("/dashboard");
    }

    // Cross-org click: surface an explicit switch path (#72). A manager
    // switching out would orphan their current org, so they get a refusal
    // instead of a switch button.
    const [{ data: currentOrg }, { data: targetOrg }] = await Promise.all([
      admin.from("orgs").select("id, name").eq("id", existingUser.org_id).single(),
      admin.from("orgs").select("id, name").eq("id", invite.org_id).single(),
    ]);

    const currentOrgName = currentOrg?.name ?? existingUser.org_id;
    const targetOrgName = targetOrg?.name ?? invite.org_id;

    if (existingUser.role === "manager") {
      return (
        <main className="flex min-h-screen items-center justify-center bg-[#0a0a0a] p-4">
          <div className="w-full max-w-md rounded-xl border border-white/10 bg-zinc-950 p-6 text-center shadow-xl">
            <h1 className="text-xl font-bold text-white">
              Already in an Organization
            </h1>
            <p className="mt-3 text-sm text-zinc-300">
              You manage <strong>{currentOrgName}</strong>, so you can&rsquo;t
              switch into <strong>{targetOrgName}</strong> directly. Delete{" "}
              <strong>{currentOrgName}</strong> first (or hand off ownership),
              then re-click this invite.
            </p>
            <a
              href="/dashboard"
              className="mt-5 inline-block rounded-lg border border-white/10 bg-white/5 px-4 py-2 text-sm font-medium text-zinc-200 hover:bg-white/10"
            >
              Back to dashboard
            </a>
          </div>
        </main>
      );
    }

    return (
      <CrossOrgSwitch
        token={token}
        currentOrgName={currentOrgName}
        targetOrgId={invite.org_id}
        targetOrgName={targetOrgName}
      />
    );
  }

  // Join the org
  if (existingUser) {
    // User exists but has no org
    await admin
      .from("users")
      .update({ org_id: invite.org_id, role: invite.role })
      .eq("id", authUser.id);
  } else {
    // New user
    const apiKey = `budi_${randomBytes(24).toString("base64url")}`;
    const displayName =
      authUser.user_metadata?.full_name ||
      authUser.user_metadata?.name ||
      authUser.email?.split("@")[0] ||
      "User";

    await admin.from("users").insert({
      id: authUser.id,
      org_id: invite.org_id,
      role: invite.role,
      api_key: apiKey,
      display_name: displayName,
      email: authUser.email,
    });
  }

  // Record the redemption. `invite_redemptions` is now the source of truth
  // for "who joined via this token" — the token itself stays valid for other
  // teammates until it expires. Idempotent on (token, user) so a re-click by
  // the same user is a no-op.
  await admin
    .from("invite_redemptions")
    .upsert(
      { token_id: token, user_id: authUser.id },
      { onConflict: "token_id,user_id", ignoreDuplicates: true }
    );

  redirect("/dashboard");
}
