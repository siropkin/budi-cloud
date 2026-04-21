"use client";

import { useState } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Terminal, Copy, Check } from "lucide-react";

/**
 * Prominent "link your local Budi" call-to-action.
 *
 * Rendered on the Overview page for freshly signed-up accounts that don't
 * have any devices yet. The goal is that a user who just created a cloud
 * account can tell — without reading docs — which command to run on their
 * laptop to finish the handshake.
 */
export function LinkDaemonBanner({ apiKey }: { apiKey: string }) {
  const [copied, setCopied] = useState(false);
  const command = `budi cloud init --api-key ${apiKey}`;

  function handleCopy() {
    navigator.clipboard.writeText(command);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  return (
    <Card data-testid="link-daemon-banner">
      <CardContent>
        <div className="flex items-start gap-4">
          <div className="flex h-10 w-10 flex-none items-center justify-center rounded-lg bg-sky-500/10 text-sky-400">
            <Terminal className="h-5 w-5" />
          </div>
          <div className="flex-1 space-y-3">
            <div>
              <h2 className="text-base font-semibold text-white">
                Link your local Budi to finish setup
              </h2>
              <p className="mt-1 text-sm text-zinc-400">
                Run this in your terminal on the machine where{" "}
                <code className="text-zinc-300">budi</code> is installed — the
                daemon picks up your key on its next cycle.
              </p>
            </div>
            <div className="flex items-start gap-2">
              <code className="block flex-1 whitespace-pre-wrap rounded-lg bg-black/50 px-4 py-3 font-mono text-sm text-emerald-400">
                {command}
              </code>
              <button
                onClick={handleCopy}
                className="inline-flex items-center gap-1.5 rounded-lg bg-white/10 px-4 py-2 text-sm font-medium text-zinc-200 transition-colors hover:bg-white/15"
              >
                {copied ? (
                  <>
                    <Check className="h-4 w-4" /> Copied
                  </>
                ) : (
                  <>
                    <Copy className="h-4 w-4" /> Copy
                  </>
                )}
              </button>
            </div>
            <p className="text-xs text-zinc-500">
              Don&apos;t have Budi installed?{" "}
              <a
                className="text-zinc-300 underline underline-offset-2 hover:text-white"
                href="https://getbudi.dev"
                target="_blank"
                rel="noreferrer"
              >
                Install it first
              </a>
              , then come back here.
            </p>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

/**
 * Softer variant shown when the account *is* linked but hasn't produced any
 * rollups yet (first ingest happened but no usage data has landed, or the
 * user is within the `1d` window on a day where nothing was used).
 */
export function FirstSyncInProgressBanner() {
  return (
    <Card data-testid="first-sync-in-progress-banner">
      <CardContent>
        <div className="flex items-start gap-4">
          <div className="flex h-10 w-10 flex-none items-center justify-center rounded-lg bg-sky-500/10 text-sky-400">
            <Terminal className="h-5 w-5" />
          </div>
          <div className="flex-1">
            <h2 className="text-base font-semibold text-white">
              Linked — waiting for your first sync
            </h2>
            <p className="mt-1 text-sm text-zinc-400">
              We&apos;ve heard from your local Budi daemon, but no usage data
              has been pushed yet. Use any AI coding tool for a few minutes and
              your stats will appear here automatically on the next sync.
            </p>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
