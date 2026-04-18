"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { clsx } from "clsx";

/**
 * Freshness threshold beyond which a linked daemon is considered "stalled".
 *
 * The budi daemon syncs on a periodic timer (typically every 10–15 minutes
 * while running) and again whenever the user opens a surface that pushes an
 * ingest. If we haven't heard anything in more than a day, something is
 * wrong (machine off, network dropped, token revoked, ingest 401).
 */
const STALLED_AFTER_MS = 24 * 60 * 60 * 1000;

export interface SyncFreshnessProps {
  deviceCount: number;
  lastSeenAt: string | null;
  lastRollupAt: string | null;
}

export function SyncFreshness({
  deviceCount,
  lastSeenAt,
  lastRollupAt,
}: SyncFreshnessProps) {
  // Not-linked is rendered as a call-to-action so it's obvious what to do
  // next instead of looking like a silent empty dashboard.
  if (deviceCount === 0) {
    return (
      <Link
        href="/dashboard/settings"
        className="group inline-flex items-center gap-2 rounded-md border border-amber-400/30 bg-amber-400/10 px-2.5 py-1 text-xs font-medium text-amber-300 transition-colors hover:border-amber-400/60 hover:bg-amber-400/20"
        data-testid="sync-freshness"
        data-sync-state="not_linked"
      >
        <span className="h-1.5 w-1.5 rounded-full bg-amber-300" />
        Not linked yet — link your local Budi
      </Link>
    );
  }

  return (
    <LinkedSyncFreshness lastSeenAt={lastSeenAt} lastRollupAt={lastRollupAt} />
  );
}

/**
 * Inner component that is only rendered once we know the account has at
 * least one device. Splitting this out keeps the `useNow` hook unconditional
 * (React hook ordering rules) while still allowing the parent to short-
 * circuit the not-linked state.
 */
function LinkedSyncFreshness({
  lastSeenAt,
  lastRollupAt,
}: {
  lastSeenAt: string | null;
  lastRollupAt: string | null;
}) {
  const now = useNow(60_000);
  const effective = lastRollupAt ?? lastSeenAt;
  const isStalled =
    effective !== null && now - Date.parse(effective) > STALLED_AFTER_MS;
  const state: "linked_no_data" | "stalled" | "ok" = !lastRollupAt
    ? "linked_no_data"
    : isStalled
      ? "stalled"
      : "ok";

  return (
    <div
      className={clsx(
        "inline-flex items-center gap-2 rounded-md border px-2.5 py-1 text-xs font-medium",
        state === "ok" &&
          "border-emerald-400/20 bg-emerald-400/5 text-emerald-300",
        state === "linked_no_data" &&
          "border-sky-400/20 bg-sky-400/5 text-sky-300",
        state === "stalled" &&
          "border-amber-400/30 bg-amber-400/10 text-amber-300"
      )}
      data-testid="sync-freshness"
      data-sync-state={state}
      title={
        effective
          ? `Last contact: ${new Date(effective).toLocaleString()}`
          : "No sync activity recorded yet"
      }
    >
      <span
        className={clsx(
          "h-1.5 w-1.5 rounded-full",
          state === "ok" && "bg-emerald-300",
          state === "linked_no_data" && "animate-pulse bg-sky-300",
          state === "stalled" && "bg-amber-300"
        )}
      />
      <SyncFreshnessLabel state={state} effective={effective} now={now} />
    </div>
  );
}

function SyncFreshnessLabel({
  state,
  effective,
  now,
}: {
  state: "linked_no_data" | "stalled" | "ok";
  effective: string | null;
  now: number;
}) {
  if (state === "linked_no_data") {
    return <>Linked — waiting for first sync…</>;
  }
  if (!effective) return <>Unknown</>;
  return (
    <>
      {state === "stalled" ? "Stalled — last synced " : "Synced "}
      <span>{formatRelative(Date.parse(effective), now)}</span>
    </>
  );
}

function useNow(intervalMs: number): number {
  const [now, setNow] = useState<number>(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), intervalMs);
    return () => window.clearInterval(id);
  }, [intervalMs]);
  return now;
}

export function formatRelative(
  whenMs: number,
  now: number = Date.now()
): string {
  const diff = Math.max(0, now - whenMs);
  const s = Math.floor(diff / 1000);
  if (s < 60) return "just now";
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 7) return `${d}d ago`;
  const w = Math.floor(d / 7);
  if (w < 5) return `${w}w ago`;
  const months = Math.floor(d / 30);
  if (months < 12) return `${months}mo ago`;
  const y = Math.floor(d / 365);
  return `${y}y ago`;
}
