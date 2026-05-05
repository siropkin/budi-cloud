"use client";

import { useState, useTransition } from "react";
import { clsx } from "clsx";
import { deleteOrganization, leaveOrganization } from "@/app/actions/org";

/**
 * Destructive-action card shown at the bottom of /dashboard/settings.
 *
 * Managers see "Delete organization" (nukes the org + all synced data);
 * members see "Leave organization" (wipes only their own devices and
 * rollups). Both paths sign the caller out and bounce them to /login.
 *
 * The delete flow requires typing the org name into a confirmation input —
 * the server re-verifies this, but guarding it client-side as well keeps the
 * destructive button disabled until the user has done the deliberate act.
 */
export function DangerZone({
  userRole,
  orgName,
}: {
  userRole: string;
  orgName: string;
}) {
  const isManager = userRole === "manager";

  return (
    <section
      className="rounded-xl border border-red-500/30 bg-red-950/10 p-6"
      data-testid="danger-zone"
    >
      <h2 className="text-sm font-semibold text-red-300">Danger zone</h2>
      <p className="mt-1 text-sm text-zinc-400">
        {isManager
          ? "Deleting the organization removes every member, device, and synced rollup. This cannot be undone."
          : "Leaving removes your devices and sync history from this organization. Your account itself stays intact so you can rejoin or create a new org later."}
      </p>

      <div className="mt-4">
        {isManager ? (
          <DeleteOrgButton orgName={orgName} />
        ) : (
          <LeaveOrgButton orgName={orgName} />
        )}
      </div>
    </section>
  );
}

function DeleteOrgButton({ orgName }: { orgName: string }) {
  const [open, setOpen] = useState(false);
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const canSubmit = confirm.trim() === orgName && !pending;

  function close() {
    if (pending) return;
    setOpen(false);
    setConfirm("");
    setError(null);
  }

  function submit(formData: FormData) {
    setError(null);
    startTransition(async () => {
      const result = await deleteOrganization(undefined, formData);
      // A successful action redirects server-side and never resolves with a
      // return value. Anything we see here is an error path.
      if (result?.error) setError(result.error);
    });
  }

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="rounded-lg border border-red-500/40 bg-red-500/10 px-4 py-2 text-sm font-medium text-red-300 transition-colors hover:bg-red-500/20"
      >
        Delete organization…
      </button>

      {open && (
        <ConfirmationModal
          title="Delete organization"
          onClose={close}
          description={
            <>
              This will permanently remove <strong>{orgName}</strong>, every
              member, and all synced data. Other members will be signed out the
              next time they open the dashboard.
            </>
          }
          error={error}
        >
          <form action={submit} className="space-y-3">
            <label className="block text-xs text-zinc-400">
              Type <span className="font-mono text-zinc-200">{orgName}</span> to
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
              className="w-full rounded-lg border border-white/10 bg-black/40 px-3 py-2 font-mono text-sm text-zinc-200 focus:border-red-500/60 focus:outline-none"
            />
            <div className="flex justify-end gap-2 pt-2">
              <button
                type="button"
                onClick={close}
                disabled={pending}
                className="rounded-lg px-4 py-2 text-sm font-medium text-zinc-300 hover:bg-white/5 disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={!canSubmit}
                className={clsx(
                  "rounded-lg px-4 py-2 text-sm font-medium transition-colors",
                  canSubmit
                    ? "bg-red-600 text-white hover:bg-red-700"
                    : "cursor-not-allowed bg-red-600/40 text-red-200/60"
                )}
              >
                {pending ? "Deleting…" : "Delete organization"}
              </button>
            </div>
          </form>
        </ConfirmationModal>
      )}
    </>
  );
}

function LeaveOrgButton({ orgName }: { orgName: string }) {
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function close() {
    if (pending) return;
    setOpen(false);
    setError(null);
  }

  function submit() {
    setError(null);
    startTransition(async () => {
      const result = await leaveOrganization();
      if (result?.error) setError(result.error);
    });
  }

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="rounded-lg border border-red-500/40 bg-red-500/10 px-4 py-2 text-sm font-medium text-red-300 transition-colors hover:bg-red-500/20"
      >
        Leave organization…
      </button>

      {open && (
        <ConfirmationModal
          title="Leave organization"
          onClose={close}
          description={
            <>
              This removes your devices and sync history from{" "}
              <strong>{orgName}</strong>. Your sign-in account stays, so you can
              rejoin or create a different org later.
            </>
          }
          error={error}
        >
          <div className="flex justify-end gap-2 pt-2">
            <button
              type="button"
              onClick={close}
              disabled={pending}
              className="rounded-lg px-4 py-2 text-sm font-medium text-zinc-300 hover:bg-white/5 disabled:opacity-50"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={submit}
              disabled={pending}
              className="rounded-lg bg-red-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-red-700 disabled:opacity-50"
            >
              {pending ? "Leaving…" : "Leave organization"}
            </button>
          </div>
        </ConfirmationModal>
      )}
    </>
  );
}

function ConfirmationModal({
  title,
  description,
  error,
  onClose,
  children,
}: {
  title: string;
  description: React.ReactNode;
  error: string | null;
  onClose: () => void;
  children: React.ReactNode;
}) {
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label={title}
    >
      <div
        className="w-full max-w-md rounded-xl border border-white/10 bg-zinc-950 p-6 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <h3 className="text-base font-semibold text-zinc-100">{title}</h3>
        <p className="mt-2 text-sm text-zinc-400">{description}</p>
        {error && (
          <p className="mt-3 rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-300">
            {error}
          </p>
        )}
        <div className="mt-4">{children}</div>
      </div>
    </div>
  );
}
