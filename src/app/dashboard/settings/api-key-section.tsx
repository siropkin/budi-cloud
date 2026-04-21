"use client";

import { useState } from "react";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";

export function ApiKeySection({ apiKey }: { apiKey: string }) {
  const [copied, setCopied] = useState(false);

  const command = `budi cloud init --api-key ${apiKey}`;

  function handleCopy() {
    navigator.clipboard.writeText(command);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Your API Key</CardTitle>
      </CardHeader>
      <CardContent>
        <p className="mb-2 text-sm text-zinc-400">
          Run this on your local machine to point Budi at your cloud account.
        </p>
        <div className="flex items-start gap-2">
          <code className="block flex-1 whitespace-pre-wrap rounded-lg bg-black/50 px-4 py-3 font-mono text-sm text-emerald-400">
            {command}
          </code>
          <button
            onClick={handleCopy}
            className="rounded-lg bg-white/10 px-4 py-2 text-sm font-medium text-zinc-200 transition-colors hover:bg-white/15"
          >
            {copied ? "Copied!" : "Copy"}
          </button>
        </div>
      </CardContent>
    </Card>
  );
}
