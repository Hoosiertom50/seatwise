"use client";

import { useEffect, useMemo, useState } from "react";
import { ConfirmDeleteButton } from "@/components/ConfirmDeleteButton";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { api, ApiError, apiErrorMessage } from "@/lib/api-client";
import { formatDate, localTodayIso } from "@/lib/display-format";
import { formatGuestCounts, type WeddingSummaryDTO, type SeatingTemplateDTO } from "@seatwise/shared";
import { NotificationsBell } from "@/components/NotificationsBell";
import { EmailVerificationNotice } from "@/components/EmailVerificationNotice";
// TS-193: the same limits the server checks (packages/shared/src/field-limits.ts).
import { FIELD_LIMITS } from "@seatwise/shared";

// TS-19 (FR-14.2): human-readable labels for a template's captured rule-shape.
const SIDE_MIXING_LABELS: Record<string, string> = {
  KEEP_SEPARATE: "Keep sides separate",
  BALANCED_MIX: "Balanced mix",
  FULLY_MIXED: "Fully mixed",
};

type PlanStatusFilter = "ALL" | "DRAFT" | "IN_REVIEW" | "APPROVED" | "NONE";
type SortKey = "urgency" | "name" | "eventDate" | "guestCount" | "issues";

const PLAN_STATUS_LABELS: Record<"DRAFT" | "IN_REVIEW" | "APPROVED", string> = {
  DRAFT: "Draft",
  IN_REVIEW: "In Review",
  APPROVED: "Approved",
};

const PLAN_STATUS_BADGE_CLASSES: Record<"DRAFT" | "IN_REVIEW" | "APPROVED", string> = {
  // TS-175: dark-mode backgrounds too -- light text on the light pill was unreadable.
  DRAFT: "bg-amber-100 dark:bg-amber-900 text-amber-700 dark:text-amber-300",
  IN_REVIEW: "bg-blue-100 dark:bg-blue-900 text-blue-700 dark:text-blue-300",
  APPROVED: "bg-green-100 dark:bg-green-900 text-green-700 dark:text-green-400",
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

  // TS-19 (FR-14.4): "start from an existing template" is offered right in this create form --
  // templates are a portfolio-level asset (not scoped to any one wedding), so they're fetched
  // once here alongside the wedding list itself.
  const [templates, setTemplates] = useState<SeatingTemplateDTO[]>([]);
  const [selectedTemplateId, setSelectedTemplateId] = useState("");
  const [applyTemplateTables, setApplyTemplateTables] = useState(true);
  const [applyTemplateRules, setApplyTemplateRules] = useState(true);
  const [templatesError, setTemplatesError] = useState<string | null>(null);
  // TS-199: whether "Your templates" is unfolded (kept when the list is briefly empty).
  const [templatesOpen, setTemplatesOpen] = useState(false);
  // TS-191: the template list itself couldn't be loaded (shown in the templates section).
  const [templatesLoadFailed, setTemplatesLoadFailed] = useState(false);
  async function loadTemplates() {
    try {
      const res = await api.get<{ templates: SeatingTemplateDTO[] }>("/api/v1/templates");
      setTemplates(res.templates);
      setTemplatesLoadFailed(false);
    } catch (err) {
      // A signed-out session is handled by the wedding list's own load.
      if (err instanceof ApiError && err.status === 401) return;
      setTemplatesLoadFailed(true);
    }
  }

  // FR-11.1: search/filter/sort all operate on the already-fetched list client-side -- at the
  // portfolio scale this is built for (dozens, 15-50+ weddings per planner) that's instant, and
  // far simpler than a parameterized query-param API (see listWeddingsWithSummaryForUser's own
  // comment for the same reasoning on the backend side).
  const [search, setSearch] = useState("");
  const [planStatusFilter, setPlanStatusFilter] = useState<PlanStatusFilter>("ALL");
  const [sortKey, setSortKey] = useState<SortKey>("urgency");

  // TS-175: a failed load says so, with Try again -- it used to show "No weddings yet".
  const [loadFailed, setLoadFailed] = useState(false);
  const [loadAttempt, setLoadAttempt] = useState(0);
  useEffect(() => {
    (async () => {
      try {
        const me = await api.get<{ user: { id: string; name: string } }>("/api/v1/auth/me");
        setUserName(me.user.name);
        setUserId(me.user.id);
        // TS-191: templates load on their own -- if only they fail, the weddings still show and
        // the templates section says what went wrong (it used to be "Couldn't load your weddings").
        void loadTemplates();
        const list = await api.get<{ weddings: WeddingSummaryDTO[] }>("/api/v1/weddings");
        setWeddings(list.weddings);
        setLoadFailed(false);
      } catch (err) {
        if (err instanceof ApiError && err.status === 401) {
          router.push("/login");
          return;
        }
        setLoadFailed(true);
      } finally {
        setLoading(false);
      }
    })();
  }, [router, loadAttempt]);

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
      const todayIso = localTodayIso();
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

  // TS-91: start a new wedding from one of yours -- same room layout (tables, positions, shapes,
  // table settings) and seating settings, none of its guests, rules or plans -- then open it.
  const [duplicatingId, setDuplicatingId] = useState<string | null>(null);
  async function onDuplicate(w: WeddingSummaryDTO) {
    setError(null);
    setDuplicatingId(w.id);
    try {
      const { wedding } = await api.post<{ wedding: { id: string } }>(`/api/v1/weddings/${w.id}/duplicate`, {});
      router.push(`/weddings/${wedding.id}`);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't duplicate that wedding.");
      setDuplicatingId(null);
    }
  }

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
        // TS-19 (FR-14.4): only sent meaningfully when a template is actually selected -- an
        // unselected picker (selectedTemplateId === "") sends no templateId, and the two
        // checkboxes are simply ignored server-side in that case.
        templateId: selectedTemplateId || undefined,
        applyTemplateTables: selectedTemplateId ? applyTemplateTables : false,
        applyTemplateRules: selectedTemplateId ? applyTemplateRules : false,
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
      setSelectedTemplateId("");
      // TS-112: go straight into the new wedding -- its Getting started steps (TS-96) are what a
      // planner needs next, rather than hunting for it in the list they were just on.
      router.push(`/weddings/${wedding.id}`);
    } catch (err) {
      setError(apiErrorMessage(err, ["name"], "Couldn't create the wedding."));
    } finally {
      setCreating(false);
    }
  }

  async function onDeleteTemplate(id: string) {
    // TS-182: on failure only this template comes back, in its old place -- a copy of the whole
    // list taken here used to also undo another template deleted meanwhile.
    const index = templates.findIndex((t) => t.id === id);
    const removed = templates[index];
    setTemplatesError(null);
    setTemplates((cur) => cur.filter((t) => t.id !== id));
    if (selectedTemplateId === id) setSelectedTemplateId("");
    try {
      await api.delete(`/api/v1/templates/${id}`);
    } catch (err) {
      if (removed)
        setTemplates((cur) =>
          cur.some((t) => t.id === id) ? cur : [...cur.slice(0, index), removed, ...cur.slice(index)]
        );
      setTemplatesError(err instanceof ApiError ? err.message : "Couldn't delete that template.");
    }
  }

  // TS-175: a failed log out says so (it failed silently), and a successful one replaces this
  // page in history, so Back doesn't bounce between the dashboard and the sign-in page.
  // TS-204 (Tom's decision): this device only -- "Log out on all devices" is on the Account page.
  async function onLogout() {
    try {
      await api.post("/api/v1/auth/logout");
    } catch {
      setError("Couldn't log out — check your connection and try again.");
      return;
    }
    router.replace("/login");
  }

  if (loading) {
    return <main className="flex flex-1 items-center justify-center text-neutral-500 dark:text-neutral-400">Loading...</main>;
  }

  return (
    <main className="mx-auto w-full max-w-[1600px] flex-1 px-6 py-10">
      <div className="mb-8 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold">Your weddings</h1>
          {userName && <p className="text-sm text-neutral-500 dark:text-neutral-400">Signed in as {userName}</p>}
        </div>
        <div className="flex items-center gap-2">
          <NotificationsBell />
          {/* TS-105 */}
          <Link
            href="/account"
            className="rounded-md border border-neutral-300 dark:border-neutral-600 px-3 py-1.5 text-sm hover:bg-neutral-50 dark:hover:bg-neutral-800"
          >
            Account
          </Link>
          <button
            onClick={onLogout}
            className="rounded-md border border-neutral-300 dark:border-neutral-600 px-3 py-1.5 text-sm hover:bg-neutral-50 dark:hover:bg-neutral-800"
          >
            Log out
          </button>
        </div>
      </div>

      {/* TS-164 */}
      <EmailVerificationNotice />

      <form
        onSubmit={onCreate}
        className="mb-8 flex flex-col gap-3 rounded-lg border border-neutral-200 dark:border-neutral-700 p-4"
      >
        {/* FR-11.4: a wedding you create is yours -- you're its planner and owner from the start,
            and the couple is someone you invite in afterward (see the Collaborators tab once
            it's created), not the other way around. */}
        <p className="text-sm text-neutral-500 dark:text-neutral-400">
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
              className="w-full rounded-md border border-neutral-300 dark:border-neutral-600 px-3 py-2 text-sm"
              placeholder="Alex &amp; Jordan's Wedding"
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              required
              maxLength={FIELD_LIMITS.weddingName}
            />
          </div>
          <div>
            <label htmlFor="new-wedding-date" className="mb-1 block text-sm font-medium">
              Date
            </label>
            <input
              id="new-wedding-date"
              type="date"
              className="rounded-md border border-neutral-300 dark:border-neutral-600 px-3 py-2 text-sm"
              value={newDate}
              onChange={(e) => setNewDate(e.target.value)}
            />
          </div>
          <div className="flex-1">
            <label htmlFor="new-wedding-venue" className="mb-1 block text-sm font-medium">
              Venue
            </label>
            <input
              maxLength={FIELD_LIMITS.venueName}
              id="new-wedding-venue"
              className="w-full rounded-md border border-neutral-300 dark:border-neutral-600 px-3 py-2 text-sm"
              value={newVenue}
              onChange={(e) => setNewVenue(e.target.value)}
            />
          </div>
          <button
            type="submit"
            disabled={creating || (!!selectedTemplateId && !applyTemplateTables && !applyTemplateRules)}
            className="rounded-md bg-neutral-900 dark:bg-neutral-100 px-4 py-2 text-sm font-medium text-white dark:text-neutral-900 hover:bg-neutral-700 dark:hover:bg-neutral-300 disabled:opacity-50"
          >
            {creating ? "Adding..." : "Add wedding"}
          </button>
        </div>
        {/* TS-19 (FR-14.4): entirely optional -- leaving this at "Start from scratch" behaves
            exactly as before this feature existed. */}
        {templates.length > 0 && (
          <div className="rounded-md border border-neutral-200 dark:border-neutral-700 p-3">
            <label htmlFor="new-wedding-template" className="mb-1 block text-sm font-medium">
              Start from a template (optional)
            </label>
            <select
              id="new-wedding-template"
              className="w-full rounded-md border border-neutral-300 dark:border-neutral-600 px-3 py-2 text-sm sm:max-w-sm"
              value={selectedTemplateId}
              onChange={(e) => setSelectedTemplateId(e.target.value)}
            >
              <option value="">Start from scratch</option>
              {templates.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name} ({t.tableCount} table{t.tableCount === 1 ? "" : "s"}
                  {t.sourceWeddingName ? ` · from ${t.sourceWeddingName}` : ""})
                </option>
              ))}
            </select>
            {selectedTemplateId && (
              <div className="mt-2 flex flex-col gap-1.5">
                <label className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={applyTemplateTables}
                    onChange={(e) => setApplyTemplateTables(e.target.checked)}
                  />
                  Use its table layout
                </label>
                <label className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={applyTemplateRules}
                    onChange={(e) => setApplyTemplateRules(e.target.checked)}
                  />
                  Use its side-mixing setting (
                  {SIDE_MIXING_LABELS[
                    templates.find((t) => t.id === selectedTemplateId)?.sideMixing ?? "BALANCED_MIX"
                  ]}
                  )
                </label>
                {!applyTemplateTables && !applyTemplateRules && (
                  <p className="text-xs text-red-600 dark:text-red-400">
                    Pick at least one, or choose &ldquo;Start from scratch&rdquo; instead.
                  </p>
                )}
                <p className="text-xs text-neutral-500 dark:text-neutral-400">
                  Everything pre-filled from the template stays fully editable afterward.
                </p>
              </div>
            )}
          </div>
        )}
        {/* FR-1.3: "an optional note" -- tucked behind a toggle so the quick-add row above stays
            uncluttered for the common case of not needing one. */}
        {showNote ? (
          <div>
            <label htmlFor="new-wedding-note" className="mb-1 block text-sm font-medium">
              Note (optional)
            </label>
            <textarea
              maxLength={FIELD_LIMITS.weddingNote}
              id="new-wedding-note"
              className="w-full rounded-md border border-neutral-300 dark:border-neutral-600 px-3 py-2 text-sm"
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
            className="self-start text-sm text-neutral-500 dark:text-neutral-400 underline hover:text-neutral-700 dark:hover:text-neutral-300"
          >
            + Add a note
          </button>
        )}
      </form>

      {error && (
        <p role="alert" className="mb-4 text-sm text-red-600 dark:text-red-400">
          {error}
        </p>
      )}

      {templatesLoadFailed && templates.length === 0 && (
        <div className="mb-8 rounded-lg border border-neutral-200 dark:border-neutral-700 p-4">
          <p className="text-sm font-medium">Your templates</p>
          <p role="alert" className="mt-2 text-sm text-red-600 dark:text-red-400">
            Couldn&apos;t load your templates.{" "}
            <button type="button" onClick={() => void loadTemplates()} className="underline hover:no-underline">
              Try again
            </button>
          </p>
        </div>
      )}

      {/* TS-199: the error is shown outside the fold, and the fold remembers it was open -- deleting
          the only template took the whole section away for a moment, so when the delete failed it
          came back closed with the error hidden inside it. */}
      {templatesError && !templatesLoadFailed && (
        <p role="alert" className="mb-2 text-sm text-red-600 dark:text-red-400">{templatesError}</p>
      )}
      {templates.length > 0 && (
        <details
          open={templatesOpen}
          onToggle={(e) => setTemplatesOpen(e.currentTarget.open)}
          className="mb-8 rounded-lg border border-neutral-200 dark:border-neutral-700 p-4"
        >
          <summary className="cursor-pointer text-sm font-medium">
            Your templates ({templates.length})
          </summary>
          <ul className="mt-3 flex flex-col gap-2">
            {templates.map((t) => (
              <li
                key={t.id}
                className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-neutral-200 dark:border-neutral-700 px-3 py-2"
              >
                {/* TS-199: a long name wraps instead of running off a phone screen. */}
                <div className="min-w-0">
                  <p className="break-words font-medium [overflow-wrap:anywhere]">{t.name}</p>
                  <p className="text-xs text-neutral-500 dark:text-neutral-400">
                    {t.tableCount} table{t.tableCount === 1 ? "" : "s"} ·{" "}
                    {SIDE_MIXING_LABELS[t.sideMixing]}
                    {t.sourceWeddingName ? ` · saved from ${t.sourceWeddingName}` : ""}
                  </p>
                </div>
                <ConfirmDeleteButton
                  id={`template-${t.id}-delete`}
                  label="Delete"
                  ariaLabel={`Delete ${t.name}`}
                  question={`Delete the template "${t.name}"? Weddings already made from it aren't changed. This can't be undone.`}
                  confirmLabel="Yes, delete template"
                  onConfirm={() => onDeleteTemplate(t.id)}
                />
              </li>
            ))}
          </ul>
        </details>
      )}

      {weddings.length > 0 && (
        <div className="mb-4 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex flex-1 flex-col gap-2 sm:flex-row">
            <input
              maxLength={FIELD_LIMITS.search}
              type="search"
              aria-label="Search weddings"
              placeholder="Search by name or venue..."
              className="flex-1 rounded-md border border-neutral-300 dark:border-neutral-600 px-3 py-1.5 text-sm sm:max-w-xs"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
            <select
              aria-label="Filter by plan status"
              className="rounded-md border border-neutral-300 dark:border-neutral-600 px-2 py-1.5 text-sm"
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
            className="rounded-md border border-neutral-300 dark:border-neutral-600 px-2 py-1.5 text-sm"
            value={sortKey}
            onChange={(e) => setSortKey(e.target.value as SortKey)}
          >
            <option value="urgency">Sort: Needs attention first</option>
            <option value="eventDate">Sort: Event date (soonest)</option>
            <option value="name">Sort: Name (A–Z)</option>
            <option value="guestCount">Sort: Invitations (most)</option>
            <option value="issues">Sort: Outstanding issues (most)</option>
          </select>
        </div>
      )}

      {loadFailed ? (
        <div role="alert" className="flex flex-wrap items-center gap-3 text-sm text-red-600 dark:text-red-400">
          Couldn&apos;t load your weddings.
          <button
            type="button"
            onClick={() => {
              setLoading(true);
              setLoadAttempt((n) => n + 1);
            }}
            className="rounded-md border border-neutral-300 dark:border-neutral-600 px-3 py-1.5 text-neutral-900 dark:text-neutral-100 hover:bg-neutral-50 dark:hover:bg-neutral-800"
          >
            Try again
          </button>
        </div>
      ) : weddings.length === 0 ? (
        <p className="text-sm text-neutral-500 dark:text-neutral-400">
          {/* TS-96: say what happens after this first step, not just "add one". */}
          No weddings yet — add one above. Then open it to add your guests and tables, and Seatwise
          will generate a seating plan that follows your rules.
        </p>
      ) : visibleWeddings.length === 0 ? (
        <p className="text-sm text-neutral-500 dark:text-neutral-400">No weddings match your search/filter.</p>
      ) : (
        <>
          {(search.trim() || planStatusFilter !== "ALL") && (
            <p className="mb-2 text-xs text-neutral-500 dark:text-neutral-400">
              Showing {visibleWeddings.length} of {weddings.length} weddings.
            </p>
          )}
          <ul className="flex flex-col gap-2">
            {visibleWeddings.map((w) => {
              const totalIssues = w.unassignedCount + w.needsReassignmentCount;
              return (
                <li key={w.id} className="flex items-stretch gap-2">
                  <Link
                    href={`/weddings/${w.id}`}
                    className="flex min-w-0 flex-1 flex-col gap-2 rounded-lg border border-neutral-200 dark:border-neutral-700 px-4 py-3 hover:border-neutral-400 dark:hover:border-neutral-500 sm:flex-row sm:items-center sm:justify-between"
                  >
                    {/* TS-199: a long name or venue wraps instead of running off a phone screen. */}
                    <div className="min-w-0">
                      <p className="flex flex-wrap items-center gap-2 font-medium">
                        <span className="min-w-0 break-words [overflow-wrap:anywhere]">{w.name}</span>
                        {userId && w.ownerId !== userId && (
                          <span className="rounded-full bg-neutral-100 dark:bg-neutral-800 px-2 py-0.5 text-xs font-normal text-neutral-500 dark:text-neutral-400">
                            Shared with you
                          </span>
                        )}
                        <span
                          className={`rounded-full px-2 py-0.5 text-xs font-normal ${
                            w.planStatus
                              ? PLAN_STATUS_BADGE_CLASSES[w.planStatus]
                              : "bg-neutral-100 dark:bg-neutral-800 text-neutral-500 dark:text-neutral-400"
                          }`}
                        >
                          {w.planStatus ? PLAN_STATUS_LABELS[w.planStatus] : "No plan yet"}
                        </span>
                      </p>
                      <p className="break-words text-sm text-neutral-500 dark:text-neutral-400 [overflow-wrap:anywhere]">
                        {w.eventDate ? formatDate(w.eventDate) : "No date set"}
                        {w.venueName ? ` · ${w.venueName}` : ""}
                      </p>
                    </div>
                    <div className="flex flex-wrap items-center gap-3 text-sm text-neutral-500 dark:text-neutral-400 sm:text-right">
                      {totalIssues > 0 && (
                        <span className="rounded-full bg-red-100 dark:bg-red-900 px-2 py-0.5 text-xs font-medium text-red-700 dark:text-red-400">
                          {w.unassignedCount > 0 && `${w.unassignedCount} unassigned`}
                          {w.unassignedCount > 0 && w.needsReassignmentCount > 0 && " · "}
                          {w.needsReassignmentCount > 0 &&
                            `${w.needsReassignmentCount} needs reassignment`}
                        </span>
                      )}
                      {/* TS-177: invitations and people, the same as the Guests tab's header. */}
                      <span>
                        {/* TS-214: invited and attending (the Tables tab's count). */}
                        {formatGuestCounts(w.guestCount, w.peopleCount, w.attendingCount)}
                      </span>
                    </div>
                  </Link>
                  {/* TS-91: beside the row's link, not inside it -- a button nested in a link is
                      invalid and unreachable by keyboard. Owners only: the copy becomes yours. */}
                  {userId && w.ownerId === userId && (
                    <button
                      type="button"
                      onClick={() => onDuplicate(w)}
                      disabled={duplicatingId !== null}
                      aria-label={`Duplicate layout of ${w.name}`}
                      title="Start a new wedding with this one's tables and seating settings (no guests)"
                      className="shrink-0 rounded-lg border border-neutral-200 dark:border-neutral-700 px-3 text-sm text-neutral-600 dark:text-neutral-300 hover:border-neutral-400 dark:hover:border-neutral-500 disabled:opacity-50"
                    >
                      {duplicatingId === w.id ? "Duplicating…" : "Duplicate layout"}
                    </button>
                  )}
                </li>
              );
            })}
          </ul>
        </>
      )}
    </main>
  );
}
