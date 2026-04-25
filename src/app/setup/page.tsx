import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { isInvitePath } from "@/lib/auth-redirect";
import { OrgSetupForm } from "./form";

export const dynamic = "force-dynamic";

export default async function SetupPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string }>;
}) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) redirect("/login");

  // If the user landed here while in the middle of accepting an invite,
  // forward to the invite page so they join the inviter's org instead of
  // creating their own (issue #62).
  const { next } = await searchParams;
  if (isInvitePath(next)) redirect(next);

  // Check if user already has an org
  const admin = createAdminClient();
  const { data: budiUser } = await admin
    .from("users")
    .select("org_id")
    .eq("id", user.id)
    .single();

  if (budiUser?.org_id) redirect("/dashboard");

  return (
    <main className="flex min-h-screen items-center justify-center bg-[#0a0a0a]">
      <div className="w-full max-w-sm space-y-6 rounded-xl border border-white/10 bg-white/[0.02] p-8">
        <div className="text-center">
          <h1 className="text-xl font-bold text-white">Create Your Team</h1>
          <p className="mt-1 text-sm text-zinc-400">
            Set up an organization to start tracking team AI costs.
          </p>
        </div>
        <OrgSetupForm />
      </div>
    </main>
  );
}
