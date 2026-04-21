"use client";

import { createClient } from "@/lib/supabase/client";

const ERROR_MESSAGES: Record<string, string> = {
  missing_user_record:
    "Your sign-in succeeded, but your account could not be set up. Please sign out and try again. If the problem persists, contact support.",
};

const DEFAULT_MESSAGE =
  "Something went wrong during authentication. Please try signing in again.";

export default function AuthErrorPage() {
  async function handleSignOut() {
    const supabase = createClient();
    await supabase.auth.signOut();
    window.location.href = "/login";
  }

  // Client component: read directly from the URL rather than routing through
  // the server `searchParams` prop (which would require React.use() in N16).
  const reason =
    typeof window !== "undefined"
      ? new URLSearchParams(window.location.search).get("reason")
      : null;

  const message = (reason && ERROR_MESSAGES[reason]) || DEFAULT_MESSAGE;

  return (
    <main className="flex min-h-screen items-center justify-center bg-[#0a0a0a]">
      <div className="w-full max-w-sm space-y-6 rounded-xl border border-white/10 bg-white/[0.02] p-8">
        <div className="text-center">
          <h1 className="text-2xl font-bold text-white">Budi Cloud</h1>
          <p className="mt-1 text-sm text-zinc-400">Authentication Error</p>
        </div>

        <div className="rounded-lg border border-red-500/20 bg-red-500/10 px-4 py-3 text-sm text-red-400">
          {message}
        </div>

        <div className="space-y-3">
          <button
            onClick={handleSignOut}
            className="w-full rounded-lg bg-white px-4 py-2.5 text-sm font-medium text-black transition-colors hover:bg-zinc-200"
          >
            Sign out and try again
          </button>
          <a
            href="/login"
            className="block w-full rounded-lg border border-white/10 bg-white/5 px-4 py-2.5 text-center text-sm font-medium text-white transition-colors hover:bg-white/10"
          >
            Back to login
          </a>
        </div>
      </div>
    </main>
  );
}
