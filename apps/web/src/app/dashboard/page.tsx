"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { api, ApiError } from "@/lib/api-client";
import type { WeddingSummaryDTO } from "@seatwise/shared";
import { NotificationsBell } from "@/components/NotificationsBell";

type PlanStatusFilter = "ALL" | "DRAFT" | "IN_REVIEW" | "APPROVED" | "NONE";
type SortKey = "urgency" | "name" | "eventDate" | "guestCount" | "issues";

const PLAN_STATUS_LABELS: Record<"DRAFT" | "IN_REVIEW" | "APPROVED", string> = {
  DRAFT: "Draft",
  IN_REVIEW: "In Review",
  APPROVED: "Approved",
};

const PLAN_STATUS_BADGE_CLASSES: Record<"DRAFT" | "IN_REVIEW" | "APPROVED", string> = {
  DRAFT: "bg-amber-100 text-amber-700",
  IN_REVIEW: "bg-blue-100 text-blue-700",
  APPROVED: "bg-green-100 text-green-700",
};

// FR-11.3: "needing attention soonest" is a combination of two independent things -- an
// approaching (or past) event date, and outstanding unassigned/Needs Reassignment guests -- not a
// single column, so the default sort is its own comparator rather than an ORDER BY on one field.
// Bucket 0: has a future (or today's) event date -- the most time-pressured group, soonest first.
// Bucket 1: no event date yet, but has outstanding issues -- worth surfacing even without a date.
// Bucket 2: no date and no issues -- nothing pressing either way.
// Bucket 3: event date has already passed -- deprioritized regardless of issues, since the event
// itself is over and nothing here is still time-sensitive in the way the other buckets are.
function urgencyBucket(w: WeddingSummaryDTO, todayIso: string): number {
  const hasIssues = w.unassignedCount + w.needsReassignmentCount > 0;
  if (w.eventDate) {
    return w.eventDate >= todayIso ? 0 : 3;
  }
  return hasIssues ? 1 : 2;
}

function compareUrgency(a: WeddingSummaryDTO, b: WeddingSummaryDTO, todayIso: string): number {
  const bucketA = urgencyBucket(a, todayIso);
  const bucketB = urgencyBucket(b, todayIso);
  if (bucketA !== bucketB) return bucketA - bucketB;
  // Within a bucket: soonest event date first (nulls last), then most outstanding issues first,
  // then alphabetically so the order is always stable and explainable.
  if (a.eventDate !== b.eventDate) {
    if (!a.eventDate) return 1;
    if (!b.eventDate) return -1;
    return a.eventDate.localeCompare(b.eventDate);
  }
  const issuesA = a.unassignedCount + a.needsReassignmentCount;
  const issuesB = b.unassignedCount + b.needsReassignmentCount;
  if (issuesA !== issuesB) return issuesB - issuesA;
  return a.name.localeCompare(b.name);
}

export default function DashboardPage() {
  const router = useRouter();
  const [userName, setUserName] = useState<string | null>(null);
  const [userId, setUserId] = useState<string | null>(null);
  const [weddings, setWeddings] = useState<WeddingSummaryDTO[]>([]);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");
  const [newDate, setNewDate] = useState("");
  const [newVenue, setNewVenue] = useState("");
  // FR-1.3: "an optional note" -- always fine left blank.
  const [newNote, setNewNote] = useState("");
  const [showNote, setShowNote] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // FR-11.1: search/filter/sort all operate on the already-fetched list client-side -- at the
  // portfolio scale this is built for (dozens, 15-50+ weddings per planner) that's instant, and
  // far simpler than a parameterized query-param API (see listWeddingsWithSummaryForUser's own
  // comment for the same reasoning on the backend side).
  const [search, setSearch] = useState("");
  const [planStatusFilter, setPlanStatusFilter] = useState<PlanStatusFilter>("ALL");
  const [sortKey, setSortKey] = useState<SortKey>("urgency");

  useEffect(() => {
    (async () => {
      try {
        const me = await api.get<{ user: { id: string; name: string } }>("/api/v1/auth/me");
        setUserName(me.user.name);
        setUserId(me.user.id);
        const list = await api.get<{ weddings: WeddingSummaryDTO[] }>("/api/v1/weddings");
        setWeddings(list.weddings);
      } catch (err) {
        if (err instanceof ApiError && err.status === 401) {
          router.push("/login");
          return;
        }
        setError("Couldn't load your weddings.");
      } finally {
        setLoading(false);
      }
    })();
  }, [router]);

  const visibleWeddings = useMemo(() => {
    const term = search.trim().toLowerCase();
    const filtered = weddings.filter((w) => {
      if (term) {
        const haystack = `${w.name} ${w.venueName ?? ""}`.toLowerCase();
        if (!haystack.includes(term)) return false;
      }
      if (planStatusFilter === "NONE") return w.planStatus === null;
      if (planStatusFilter !== "ALL") return w.planStatus === planStatusFilter;
      return true;
    });

    const sorted = [...filtered];
    if (sortKey === "urgency") {
      const todayIso = new Date().toISOString().slice(0, 10);
      sorted.sort((a, b) => compareUrgency(a, b, todayIso));
    } else if (sortKey === "name") {
      sorted.sort((a, b) => a.name.localeCompare(b.name));
    } else if (sortKey === "eventDate") {
      sorted.sort((a, b) => {
        if (a.eventDate === b.eventDate) return a.name.localeCompare(b.name);
        if (!a.eventDate) return 1;
        if (!b.eventDate) return -1;
        return a.eventDate.localeCompare(b.eventDate);
      });
    } else if (sortKey === "guestCount") {
      sorted.sort((a, b) => b.guestCount - a.guestCount || a.name.localeCompare(b.name));
    } else if (sortKey === "issues") {
      sorted.sort((a, b) => {
        const issuesA = a.unassignedCount + a.needsReassignmentCount;
        const issuesB = b.unassignedCount + b.needsReassignmentCount;
        return issuesB - issuesA || a.name.localeCompare(b.name);
      });
    }
    return sorted;
  }, [weddings, search, planStatusFilter, sortKey]);

  async function onCreate(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setCreating(true);
    try {
      const { wedding } = await api.post<{ wedding: WeddingSummaryDTO }>("/api/v1/weddings", {
        name: newName,
        eventDate: newDate || null,
        venueName: newVenue || null,
        note: newNote || null,
      });
      // A brand-new wedding has no plan version and no guests yet -- fill in the summary fields
      // the create endpoint itself doesn't compute, rather than waiting on a second round-trip.
      setWeddings((prev) => [
        { ...wedding, planStatus: null, unassignedCount: 0, needsReassignmentCount: 0 },
        ...prev,
      ]);
      setNewName("");
      setNewDate("");
      setNewVenue("");
      setNewNote("");
      setShowNote(false);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't create the wedding.");
    } finally {
      setCreating(false);
    }
  }

  async function onLogout() {
    await api.post("/api/v1/auth/logout");
    router.push("/login");
  }

  if (loading) {
    return <main className="flex flex-1 items-center justify-center text-neutral-500">Loading...</main>;
  }

  return (
    <main className="mx-auto w-full max-w-5xl flex-1 px-6 py-10">
      <div className="mb-8 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold">Your weddings</h1>
          {userName && <p className="text-sm text-neutral-500">Signed in as {userName}</p>}
        </div>
        <div className="flex items-center gap-2">
          <NotificationsBell />
          <button
            onClick={onLogout}
            className="rounded-md border border-neutral-300 px-3 py-1.5 text-sm hover:bg-neutral-50"
          >
            Log out
          </button>
        </div>
      </div>

      <form
        onSubmit={onCreate}
        className="mb-8 flex flex-col gap-3 rounded-lg border border-neutral-200 p-4"
      >
        {/* FR-11.4: a wedding you create is yours -- you're its planner and owner from the start,
            and the couple is someone you invite in afterward (see the Collaborators tab once
            it's created), not the other way around. */}
        <p className="text-sm text-neutral-500">
          You&apos;ll own and manage this wedding as its planner. Once it&apos;s created, invite the
          couple (and anyone else helping) as collaborators from the Collaborators tab.
        </p>
        <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
          <div className="flex-1">
            <label htmlFor="new-wedding-name" className="mb-1 block text-sm font-medium">
              Wedding name
            </label>
            <input
              id="new-wedding-name"
              className="w-full rounded-md border border-neutral-300 px-3 py-2 text-sm"
              placeholder="Alex &amp; Jordan's Wedding"
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              required
            />
          </div>
          <div>
            <label htmlFor="new-wedding-date" className="mb-1 block text-sm font-medium">
              Date
            </label>
            <input
              id="new-wedding-date"
              type="date"
              className="rounded-md border border-neutral-300 px-3 py-2 text-sm"
              value={newDate}
              onChange={(e) => setNewDate(e.target.value)}
            />
          </div>
          <div className="flex-1">
            <label htmlFor="new-wedding-venue" className="mb-1 block text-sm font-medium">
              Venue
            </label>
            <input
              id="new-wedding-venue"
              className="w-full rounded-md border border-neutral-300 px-3 py-2 text-sm"
              value={newVenue}
              onChange={(e) => setNewVenue(e.target.value)}
            />
          </div>
          <button
            type="submit"
            disabled={creating}
            className="rounded-md bg-neutral-900 px-4 py-2 text-sm font-medium text-white hover:bg-neutral-700 disabled:opacity-50"
          >
            {creating ? "Adding..." : "Add wedding"}
          </button>
        </div>
        {/* FR-1.3: "an optional note" -- tucked behind a toggle so the quick-add row above stays
            uncluttered for the common case of not needing one. */}
        {showNote ? (
          <div>
            <label htmlFor="new-wedding-note" className="mb-1 block text-sm font-medium">
              Note (optional)
            </label>
            <textarea
              id="new-wedding-note"
              className="w-full rounded-md border border-neutral-300 px-3 py-2 text-sm"
              rows={2}
              placeholder="Anything worth remembering about this wedding"
              value={newNote}
              onChange={(e) => setNewNote(e.target.value)}
            />
          </div>
        ) : (
          <button
            type="button"
            onClick={() => setShowNote(true)}
            className="self-start text-sm text-neutral-500 underline hover:text-neutral-700"
          >
            + Add a note
          </button>
        )}
      </form>

      {error && <p className="mb-4 text-sm text-red-600">{error}</p>}

      {weddings.length > 0 && (
        <div className="mb-4 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex flex-1 flex-col gap-2 sm:flex-row">
            <input
              type="search"
              aria-label="Search weddings"
              placeholder="Search by name or venue..."
              className="flex-1 rounded-md border border-neutral-300 px-3 py-1.5 text-sm sm:max-w-xs"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
            <select
              aria-label="Filter by plan status"
              className="rounded-md border border-neutral-300 px-2 py-1.5 text-sm"
              value={planStatusFilter}
              onChange={(e) => setPlanStatusFilter(e.target.value as PlanStatusFilter)}
            >
              <option value="ALL">All plan statuses</option>
              <option value="NONE">No plan yet</option>
              <option value="DRAFT">Draft</option>
              <option value="IN_REVIEW">In Review</option>
              <option value="APPROVED">Approved</option>
            </select>
          </div>
          <select
            aria-label="Sort weddings"
            className="rounded-md border border-neutral-300 px-2 py-1.5 text-sm"
            value={sortKey}
            onChange={(e) => setSortKey(e.target.value as SortKey)}
          >
            <option value="urgency">Sort: Needs attention first</option>
            <option value="eventDate">Sort: Event date (soonest)</option>
            <option value="name">Sort: Name (A–Z)</option>
            <option value="guestCount">Sort: Guest count (most)</option>
            <option value="issues">Sort: Outstanding issues (most)</option>
          </select>
        </div>
      )}

      {weddings.length === 0 ? (
        <p className="text-sm text-neutral-500">
          No weddings yet — add one above to start building a guest list.
        </p>
      ) : visibleWeddings.length === 0 ? (
        <p className="text-sm text-neutral-500">No weddings match your search/filter.</p>
      ) : (
        <>
          {(search.trim() || planStatusFilter !== "ALL") && (
            <p className="mb-2 text-xs text-neutral-500">
              Showing {visibleWeddings.length} of {weddings.length} weddings.
            </p>
          )}
          <ul className="flex flex-col gap-2">
            {visibleWeddings.map((w) => {
              const totalIssues = w.unassignedCount + w.needsReassignmentCount;
              return (
                <li key={w.id}>
                  <Link
                    href={`/weddings/${w.id}`}
                    className="flex flex-col gap-2 rounded-lg border border-neutral-200 px-4 py-3 hover:border-neutral-400 sm:flex-row sm:items-center sm:justify-between"
                  >
                    <div>
                      <p className="flex flex-wrap items-center gap-2 font-medium">
                        {w.name}
                        {userId && w.ownerId !== userId && (
                          <span className="rounded-full bg-neutral-100 px-2 py-0.5 text-xs font-normal text-neutral-500">
                            Shared with you
                          </span>
                        )}
                        <span
                          className={`rounded-full px-2 py-0.5 text-xs font-normal ${
                            w.planStatus
                              ? PLAN_STATUS_BADGE_CLASSES[w.planStatus]
                              : "bg-neutral-100 text-neutral-500"
                          }`}
                        >
                          {w.planStatus ? PLAN_STATUS_LABELS[w.planStatus] : "No plan yet"}
                        </span>
                      </p>
                      <p className="text-sm text-neutral-500">
                        {w.eventDate ? new Date(w.eventDate).toLocaleDateString() : "No date set"}
                        {w.venueName ? ` · ${w.venueName}` : ""}
                      </p>
                    </div>
                    <div className="flex flex-wrap items-center gap-3 text-sm text-neutral-500 sm:text-right">
                      {totalIssues > 0 && (
                        <span className="rounded-full bg-red-100 px-2 py-0.5 text-xs font-medium text-red-700">
                          {w.unassignedCount > 0 && `${w.unassignedCount} unassigned`}
                          {w.unassignedCount > 0 && w.needsReassignmentCount > 0 && " · "}
                          {w.needsReassignmentCount > 0 &&
                            `${w.needsReassignmentCount} needs reassignment`}
                        </span>
                      )}
                      <span>
                        {w.guestCount} guest{w.guestCount === 1 ? "" : "s"}
                      </span>
                    </div>
                  </Link>
                </li>
              );
            })}
          </ul>
        </>
      )}
    </main>
  );
}
