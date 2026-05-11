"use client";

import { useTransition, useState } from "react";
import {
  activatePricingList,
  discardPricingDraft,
} from "@/app/actions/pricing";

export type PriceListRow = {
  id: number;
  name: string;
  status: "draft" | "active" | "archived";
  effectiveFrom: string;
  effectiveTo: string | null;
  sourceFileName: string | null;
  uploadedAt: string;
  uploadedBy: string | null;
};

function StatusBadge({ status }: { status: PriceListRow["status"] }) {
  const styles =
    status === "active"
      ? "bg-emerald-500/15 text-emerald-300"
      : status === "draft"
        ? "bg-amber-500/15 text-amber-300"
        : "bg-zinc-500/15 text-zinc-400";
  return (
    <span
      className={`inline-block rounded-full px-2 py-0.5 text-xs font-medium ${styles}`}
    >
      {status}
    </span>
  );
}

export function PriceListsTable({ lists }: { lists: PriceListRow[] }) {
  const [isPending, startTransition] = useTransition();
  const [busyId, setBusyId] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  function handleActivate(listId: number) {
    setError(null);
    setBusyId(listId);
    startTransition(async () => {
      const res = await activatePricingList(listId);
      setBusyId(null);
      if (res.error) setError(res.error);
    });
  }

  function handleDiscard(listId: number) {
    setError(null);
    setBusyId(listId);
    startTransition(async () => {
      const res = await discardPricingDraft(listId);
      setBusyId(null);
      if (res.error) setError(res.error);
    });
  }

  if (lists.length === 0) {
    return (
      <p className="text-sm text-zinc-500">
        No price lists yet. Upload a CSV below to get started.
      </p>
    );
  }

  return (
    <div className="space-y-3">
      {error && <p className="text-sm text-red-400">{error}</p>}

      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-white/10 text-left text-zinc-400">
              <th className="pb-2 font-medium">Name</th>
              <th className="pb-2 font-medium">Status</th>
              <th className="pb-2 font-medium">Effective from</th>
              <th className="pb-2 font-medium">Source file</th>
              <th className="pb-2 font-medium">Uploaded by</th>
              <th className="pb-2 font-medium text-right">Actions</th>
            </tr>
          </thead>
          <tbody>
            {lists.map((l) => (
              <tr key={l.id} className="border-b border-white/5">
                <td className="py-2 text-zinc-200">{l.name}</td>
                <td className="py-2">
                  <StatusBadge status={l.status} />
                </td>
                <td className="py-2 text-zinc-400">
                  {l.effectiveFrom}
                  {l.effectiveTo ? ` → ${l.effectiveTo}` : ""}
                </td>
                <td className="py-2 text-zinc-400">
                  {l.sourceFileName ?? "—"}
                </td>
                <td className="py-2 text-zinc-400">
                  {l.uploadedBy ?? "—"}
                </td>
                <td className="py-2 text-right">
                  {l.status === "draft" && (
                    <div className="flex items-center justify-end gap-2">
                      <button
                        onClick={() => handleActivate(l.id)}
                        disabled={isPending && busyId === l.id}
                        className="rounded-md bg-emerald-600 px-3 py-1 text-xs font-medium text-white transition-colors hover:bg-emerald-700 disabled:opacity-50"
                      >
                        {isPending && busyId === l.id ? "Activating…" : "Activate"}
                      </button>
                      <button
                        onClick={() => handleDiscard(l.id)}
                        disabled={isPending && busyId === l.id}
                        className="rounded-md bg-white/10 px-3 py-1 text-xs font-medium text-zinc-200 transition-colors hover:bg-white/15 disabled:opacity-50"
                      >
                        Discard
                      </button>
                    </div>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
