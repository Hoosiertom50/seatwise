"use client";

import { useState } from "react";
import { needsReassignmentExportWarning, openPdfExport, unseatedExportWarning } from "@/lib/export-download";

// TS-211: the Seating plan tab's three PDF exports. Each is fetched as a file and opened in a new tab
// -- a failure (signed out, the plan un-approved or replaced in another tab, a server error) is said
// here, next to the buttons, instead of a tab of raw error text. And when the approved plan has
// attending guests without a seat (added, or back to Attending, since it was approved), that's said
// next to the buttons too: they're on the PDFs only under "Not seated". TS-250: likewise for guests
// whose seat needs changing since approval -- on the PDFs only under "Needs reassignment".
const EXPORTS = [
  { kind: "chart", label: "Seating chart (PDF)", fileName: "seating-chart.pdf" },
  { kind: "lookup", label: "Guest lookup list (PDF)", fileName: "guest-lookup-list.pdf" },
  { kind: "cards", label: "Place cards (PDF)", fileName: "place-cards.pdf" },
] as const;

export function PlanExportButtons({
  weddingId,
  planVersionId,
  unseatedCount,
  needsReassignmentCount = 0,
}: {
  weddingId: string;
  planVersionId: string;
  unseatedCount: number;
  /** TS-250: guests flagged "Needs reassignment" in this plan. */
  needsReassignmentCount?: number;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const warning = unseatedExportWarning(unseatedCount);
  const reassignWarning = needsReassignmentExportWarning(needsReassignmentCount);

  async function onExport(kind: (typeof EXPORTS)[number]["kind"], fileName: string) {
    if (busy !== null) return;
    setError(null);
    setBusy(kind);
    try {
      const message = await openPdfExport(
        `/api/v1/weddings/${weddingId}/plan-versions/${planVersionId}/export/${kind}`,
        fileName,
        "Couldn't make that PDF just now — please try again."
      );
      setError(message);
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="mb-6 rounded-lg border border-neutral-200 dark:border-neutral-700 p-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm font-medium">Export:</span>
        {EXPORTS.map(({ kind, label, fileName }) => (
          <button
            key={kind}
            type="button"
            onClick={() => onExport(kind, fileName)}
            // TS-225: aria-disabled (not disabled) while a PDF is made, so the button keeps keyboard
            // focus -- a disabled button dropped it to the page. onExport ignores clicks meanwhile.
            aria-disabled={busy !== null || undefined}
            className="rounded-md border border-neutral-300 dark:border-neutral-600 min-h-11 px-3 py-1.5 text-sm font-medium hover:bg-neutral-50 dark:hover:bg-neutral-800 aria-disabled:opacity-50"
          >
            {busy === kind ? "Preparing..." : label}
          </button>
        ))}
      </div>
      {warning && (
        <p data-testid="export-unseated-warning" className="mt-2 text-sm text-amber-700 dark:text-amber-400">
          {warning}
        </p>
      )}
      {reassignWarning && (
        <p data-testid="export-needs-reassignment-warning" className="mt-2 text-sm text-amber-700 dark:text-amber-400">
          {reassignWarning}
        </p>
      )}
      {error && (
        <p role="alert" className="mt-2 text-sm text-red-600 dark:text-red-400">
          {error}
        </p>
      )}
    </div>
  );
}
