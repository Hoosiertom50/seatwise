"use client";

import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import { api, ApiError } from "@/lib/api-client";
import type { VendorViewDTO } from "@seatwise/shared";
import { formatClockTime, formatDate, vendorCategoryLabel } from "@/lib/display-format";

// TS-114: a vendor's read-only page, opened from the private link the planner shares -- no account
// or sign-in. Shows the wedding's date and venue, the whole day-of timeline, this vendor's own
// details, and the other vendors' names and arrival times so they can coordinate (Tom's decisions,
// 2026-09-29). Never costs, contracts, notes, budget or anything about guests -- the API doesn't
// return them. Fetched fresh every time, so the latest timeline always shows.
export default function VendorViewPage() {
  const { token } = useParams<{ token: string }>();
  const [view, setView] = useState<VendorViewDTO | null>(null);
  const [inactive, setInactive] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  // TS-199: bumped by "Try again" to load the page once more.
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    api
      .get<{ active: boolean; view?: VendorViewDTO }>(`/api/v1/vendor-view/${token}`)
      .then((res) => (res.active && res.view ? setView(res.view) : setInactive(true)))
      .catch((err) =>
        setLoadError(err instanceof ApiError ? err.message : "Couldn't load this page — please try again.")
      );
  }, [token, attempt]);

  if (loadError) {
    return (
      <main className="mx-auto max-w-xl px-4 py-12">
        <p role="alert" className="text-sm text-red-600 dark:text-red-400">{loadError}</p>
        {/* TS-199: a failed load (a dropped connection) can be tried again without reloading. */}
        <button
          type="button"
          onClick={() => {
            setLoadError(null);
            setAttempt((n) => n + 1);
          }}
          className="mt-3 min-h-11 rounded-md border border-neutral-300 dark:border-neutral-600 px-3 py-1.5 text-sm font-medium hover:bg-neutral-50 dark:hover:bg-neutral-800"
        >
          Try again
        </button>
      </main>
    );
  }
  if (inactive) {
    return (
      <main className="mx-auto max-w-xl px-4 py-12">
        <h1 className="mb-2 text-xl font-semibold">This link is no longer active</h1>
        <p className="text-sm text-neutral-600 dark:text-neutral-300">
          Ask the wedding planner for a new link.
        </p>
      </main>
    );
  }
  if (!view) {
    return (
      <main className="mx-auto max-w-xl px-4 py-12">
        <p className="text-sm text-neutral-500 dark:text-neutral-400">Loading…</p>
      </main>
    );
  }

  const { wedding, vendor, otherVendors, timeline } = view;
  return (
    <main className="mx-auto max-w-xl px-4 py-8">
      {/* TS-199: long names, venues and descriptions wrap instead of running off a phone screen. */}
      <p className="break-words text-sm text-neutral-500 dark:text-neutral-400 [overflow-wrap:anywhere]">Day-of information for {vendor.name}</p>
      <h1 className="mb-1 break-words text-2xl font-semibold [overflow-wrap:anywhere]">{wedding.name}</h1>
      <p className="mb-6 break-words text-sm text-neutral-600 dark:text-neutral-300 [overflow-wrap:anywhere]">
        {wedding.eventDate ? formatDate(wedding.eventDate) : "Date not set yet"}
        {wedding.venueName ? ` · ${wedding.venueName}` : ""}
      </p>

      <section aria-labelledby="your-details" className="mb-6 rounded-lg border border-neutral-200 dark:border-neutral-700 p-4">
        <h2 id="your-details" className="mb-2 text-lg font-medium">
          Your details
        </h2>
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
          <dt className="text-neutral-500 dark:text-neutral-400">Vendor</dt>
          <dd className="min-w-0 break-words [overflow-wrap:anywhere]">
            {vendor.name} ({vendorCategoryLabel(vendor.category, vendor.categoryOther)})
          </dd>
          <dt className="text-neutral-500 dark:text-neutral-400">Arrival</dt>
          <dd>{vendor.arrivalTime ? formatClockTime(vendor.arrivalTime) : "Not set yet"}</dd>
          {vendor.contactName && (
            <>
              <dt className="text-neutral-500 dark:text-neutral-400">Contact</dt>
              <dd>{vendor.contactName}</dd>
            </>
          )}
          {vendor.contactEmail && (
            <>
              <dt className="text-neutral-500 dark:text-neutral-400">Email</dt>
              {/* TS-191: a long address wraps instead of running off a phone screen. */}
              <dd className="min-w-0 break-all">{vendor.contactEmail}</dd>
            </>
          )}
          {vendor.contactPhone && (
            <>
              <dt className="text-neutral-500 dark:text-neutral-400">Phone</dt>
              <dd>{vendor.contactPhone}</dd>
            </>
          )}
        </dl>
        <p className="mt-2 text-xs text-neutral-500 dark:text-neutral-400">
          If anything here is wrong, let the planner know.
        </p>
      </section>

      <section aria-labelledby="timeline" className="mb-6">
        <h2 id="timeline" className="mb-2 text-lg font-medium">
          Timeline
        </h2>
        {timeline.length === 0 ? (
          <p className="text-sm text-neutral-500 dark:text-neutral-400">The planner hasn&apos;t added the timeline yet.</p>
        ) : (
          <ol className="flex flex-col gap-2">
            {timeline.map((e, i) => (
              <li key={i} className="flex gap-3 rounded-md border border-neutral-200 dark:border-neutral-700 px-3 py-2 text-sm">
                <span className="w-20 shrink-0 font-medium">{formatClockTime(e.time)}</span>
                <span className="min-w-0 break-words [overflow-wrap:anywhere]">{e.description}</span>
              </li>
            ))}
          </ol>
        )}
      </section>

      <section aria-labelledby="other-vendors">
        <h2 id="other-vendors" className="mb-2 text-lg font-medium">
          Other vendors
        </h2>
        {otherVendors.length === 0 ? (
          <p className="text-sm text-neutral-500 dark:text-neutral-400">No other vendors listed.</p>
        ) : (
          <ul className="flex flex-col gap-2">
            {otherVendors.map((o, i) => (
              <li key={i} className="flex justify-between gap-3 rounded-md border border-neutral-200 dark:border-neutral-700 px-3 py-2 text-sm">
                <span className="min-w-0 break-words [overflow-wrap:anywhere]">
                  {o.name} <span className="text-neutral-500 dark:text-neutral-400">({vendorCategoryLabel(o.category, o.categoryOther)})</span>
                </span>
                <span className="shrink-0">{o.arrivalTime ? `Arrives ${formatClockTime(o.arrivalTime)}` : "Arrival not set"}</span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </main>
  );
}
