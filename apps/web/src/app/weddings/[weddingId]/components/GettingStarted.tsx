"use client";

import { useEffect, useState } from "react";
import { api } from "@/lib/api-client";

// TS-96: a new wedding opens on ten tabs with nothing saying where to start. This is the order that
// actually gets a planner to a seating plan -- guests, tables, (optionally) rules, generate -- with
// each step ticked off as it's done and a click taking them to the right tab. Deliberately just a
// hint, not a wizard: nothing is forced, every tab stays usable, and it disappears for good once
// the wedding has its first plan.
//
// Step labels are worded differently from the tab buttons ("1. Add your guests" vs "Guests") so an
// exact accessible-name lookup for a tab never also matches a step here.

type StepTab = "guests" | "tables" | "rules" | "plan";

export function GettingStarted({
  weddingId,
  guestCount,
  refreshKey,
  onGoTo,
}: {
  weddingId: string;
  guestCount: number;
  // Changes whenever the planner switches tabs, so counts made on another tab are picked up.
  refreshKey: string;
  onGoTo: (tab: StepTab) => void;
}) {
  const [counts, setCounts] = useState<{ tables: number; rules: number; plans: number } | null>(null);

  useEffect(() => {
    let cancelled = false;
    Promise.all([
      api.get<{ tables: unknown[] }>(`/api/v1/weddings/${weddingId}/tables`),
      api.get<{ relationships: unknown[] }>(`/api/v1/weddings/${weddingId}/relationships`),
      api.get<{ planVersions: unknown[] }>(`/api/v1/weddings/${weddingId}/plan-versions`),
    ])
      .then(([t, r, p]) => {
        if (!cancelled) setCounts({ tables: t.tables.length, rules: r.relationships.length, plans: p.planVersions.length });
      })
      // A hint is never worth an error banner -- if it can't load, it just doesn't show.
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [weddingId, refreshKey]);

  if (!counts || counts.plans > 0) return null;

  const steps: { tab: StepTab; label: string; done: boolean; detail: string }[] = [
    {
      tab: "guests",
      label: "1. Add your guests",
      done: guestCount > 0,
      detail: guestCount > 0 ? `${guestCount} added` : "one at a time, or import a CSV",
    },
    {
      tab: "tables",
      label: "2. Add tables",
      done: counts.tables > 0,
      detail: counts.tables > 0 ? `${counts.tables} added` : "Quick-create makes a standard set in one step",
    },
    {
      tab: "rules",
      label: "3. Add seating rules (optional)",
      done: counts.rules > 0,
      detail: counts.rules > 0 ? `${counts.rules} added` : "who must, or must not, sit together",
    },
    { tab: "plan", label: "4. Generate a seating plan", done: false, detail: "on the Seating plan tab" },
  ];

  return (
    <section
      aria-label="Getting started"
      className="mb-6 rounded-lg border border-blue-200 dark:border-blue-900 bg-blue-50/60 dark:bg-blue-950/40 p-4"
    >
      <h2 className="mb-2 text-sm font-semibold text-blue-900 dark:text-blue-200">Getting started</h2>
      <ol className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
        {steps.map((s) => (
          <li key={s.tab}>
            <button
              type="button"
              onClick={() => onGoTo(s.tab)}
              className="w-full rounded-md border border-blue-200 dark:border-blue-900 bg-white dark:bg-neutral-900 px-3 py-2 text-left text-sm hover:border-blue-400 dark:hover:border-blue-600"
            >
              <span className="flex items-center gap-1.5 font-medium">
                <span aria-hidden="true" className={s.done ? "text-green-600 dark:text-green-400" : "text-neutral-400"}>
                  {s.done ? "✓" : "○"}
                </span>
                {s.label}
                {s.done && <span className="sr-only"> (done)</span>}
              </span>
              <span className="mt-0.5 block text-xs text-neutral-600 dark:text-neutral-400">{s.detail}</span>
            </button>
          </li>
        ))}
      </ol>
    </section>
  );
}
