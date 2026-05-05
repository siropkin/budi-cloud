"use client";

import { useState, useTransition } from "react";
import { clsx } from "clsx";
import { switchOrganization } from "@/app/actions/org";

/**
 * Cross-org switch panel for `/invite/[token]` (#72).
 *
 * Shown when an authenticated user clicks an invite for an org other than
 * the one they currently belong to. Replaces the old dead-end "Multi-org is
 * not supported yet" copy with an explicit, opt-in switch path.
 *
 * The action is destructive from the *leaving* org's perspective (the user's
 * devices and history move with them and stop being visible to that org's
 * manager), so we mirror the typed-confirmation pattern from
 * `deleteOrganization` — the user has to type the target org's name. The
 * server re-validates this; the client gate just keeps the button inert
 * until the user has completed the deliberate act.
 *
 * Managers are blocked at the page level (not rendered here) because the
 * action would otherwise orphan their current org. If a manager somehow
 * reaches this UI, the server action refuses and we surface the error.
 */
export function CrossOrgSwitch({
  token,
  currentOrgName,
  targetOrgId,
  targetOrgName,
}: {
  token: string;
  currentOrgName: string;
  targetOrgId: string;
  targetOrgName: string;
}) {
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const canSubmit = confirm.trim() === targetOrgName && !pending;

  function submit(formData: FormData) {
    setError(null);
    startTransition(async () => {
      const result = await switchOrganization(undefined, formData);
      if (result?.error) setError(result.error);
    });
  }

  return (
    <main className="flex min-h-screen items-center justify-center bg-[#0a0a0a] p-4">
      <div className="w-full max-w-md rounded-xl border border-white/10 bg-zinc-950 p-6 shadow-xl">
        <h1 className="text-xl font-bold text-white">Switch organizations?</h1>
        <div className="mt-4 space-y-3 text-sm text-zinc-300">
          <p>
            You&rsquo;re currently a member of{" "}
            <strong className="text-zinc-100">{currentOrgName}</strong>.
          </p>
          <p>
            This invite is for{" "}
            <strong className="text-zinc-100">{targetOrgName}</strong>.
          </p>
          <p className="rounded-lg border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-amber-200">
            If you switch, all of your devices, sessions, and cost history will
            move with you to <strong>{targetOrgName}</strong>.{" "}
            <strong>{currentOrgName}</strong>&rsquo;s manager will no longer see
            your usage.
          </p>
        </div>

        {error && (
          <p className="mt-4 rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-300">
            {error}
          </p>
        )}

        <form action={submit} className="mt-5 space-y-3">
          <input type="hidden" name="token" value={token} />
          <input type="hidden" name="targetOrgId" value={targetOrgId} />
          <label className="block text-xs text-zinc-400">
            Type{" "}
            <span className="font-mono text-zinc-200">{targetOrgName}</span> to
            confirm:
          </label>
          <input
            type="text"
            name="confirm"
            autoFocus
            autoComplete="off"
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            disabled={pending}
            className="w-full rounded-lg border border-white/10 bg-black/40 px-3 py-2 font-mono text-sm text-zinc-200 focus:border-blue-500/60 focus:outline-none"
          />
          <div className="flex justify-end gap-2 pt-2">
            <a
              href="/dashboard"
              className={clsx(
                "rounded-lg px-4 py-2 text-sm font-medium text-zinc-300 hover:bg-white/5",
                pending && "pointer-events-none opacity-50"
              )}
            >
              Stay in {currentOrgName}
            </a>
            <button
              type="submit"
              disabled={!canSubmit}
              className={clsx(
                "rounded-lg px-4 py-2 text-sm font-medium transition-colors",
                canSubmit
                  ? "bg-blue-600 text-white hover:bg-blue-700"
                  : "cursor-not-allowed bg-blue-600/40 text-blue-200/60"
              )}
            >
              {pending ? "Switching…" : `Switch to ${targetOrgName}`}
            </button>
          </div>
        </form>
      </div>
    </main>
  );
}
