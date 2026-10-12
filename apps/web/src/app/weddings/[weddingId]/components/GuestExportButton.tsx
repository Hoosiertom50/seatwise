"use client";

import { useState } from "react";
import { downloadCsvExport } from "@/lib/export-download";

// TS-211: "Export guest list (CSV)" -- the file is fetched first and then saved, so a failure is said
// next to the button. As a plain download link, a failure was saved as a broken file (or the
// browser's "Failed – server problem").
export function GuestExportButton({ weddingId }: { weddingId: string }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onExport() {
    if (busy) return;
    setError(null);
    setBusy(true);
    try {
      setError(
        await downloadCsvExport(
          `/api/v1/weddings/${weddingId}/guests/export`,
          "guest-list.csv",
          "Couldn't export the guest list just now — please try again."
        )
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col items-end gap-1">
      <button
        type="button"
        onClick={onExport}
        // TS-225: aria-disabled (not disabled) while exporting, so the button keeps keyboard focus --
        // a disabled button dropped it to the page. onExport ignores clicks meanwhile.
        aria-disabled={busy || undefined}
        className="rounded-md border border-neutral-300 dark:border-neutral-600 min-h-11 px-3 py-1.5 text-sm font-medium hover:bg-neutral-50 dark:hover:bg-neutral-800 aria-disabled:opacity-50"
      >
        {busy ? "Exporting..." : "Export guest list (CSV)"}
      </button>
      {error && (
        <p role="alert" className="text-sm text-red-600 dark:text-red-400">
          {error}
        </p>
      )}
    </div>
  );
}
