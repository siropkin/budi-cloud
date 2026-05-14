"use client";

import { useState } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Terminal, Copy, Check, Download, ExternalLink } from "lucide-react";

const INSTALL_DOCS_URL = "https://getbudi.dev/install";

/**
 * Prominent "install + link your local Budi" call-to-action.
 *
 * Rendered on the Overview page for accounts with no devices yet. Covers two
 * states the dashboard can't tell apart from the cloud side: the user hasn't
 * installed budi-core locally yet, and the user has installed it but hasn't
 * linked this account. Step 1 points to the canonical install docs; step 2
 * gives the exact `budi cloud init` command to copy.
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
          <div className="flex-1 space-y-4">
            <div>
              <h2 className="text-base font-semibold text-white">
                Finish setup to see your activity
              </h2>
              <p className="mt-1 text-sm text-zinc-400">
                We haven&apos;t heard from a budi daemon on this account yet.
                Two steps to get you flowing.
              </p>
            </div>

            <div className="space-y-2">
              <div className="text-xs font-medium uppercase tracking-wide text-zinc-500">
                Step 1 — Install budi
              </div>
              <a
                href={INSTALL_DOCS_URL}
                target="_blank"
                rel="noreferrer"
                data-testid="install-budi-link"
                className="inline-flex items-center gap-2 rounded-lg bg-white/10 px-4 py-2 text-sm font-medium text-zinc-100 transition-colors hover:bg-white/15"
              >
                <Download className="h-4 w-4" />
                Install budi on your machine
                <ExternalLink className="h-3.5 w-3.5 text-zinc-400" />
              </a>
              <p className="text-xs text-zinc-500">
                Already installed? Skip to step 2.
              </p>
            </div>

            <div className="space-y-2">
              <div className="text-xs font-medium uppercase tracking-wide text-zinc-500">
                Step 2 — Link this account
              </div>
              <p className="text-sm text-zinc-400">
                Run this in your terminal — the daemon picks up your key on its
                next cycle.
              </p>
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
            </div>
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
