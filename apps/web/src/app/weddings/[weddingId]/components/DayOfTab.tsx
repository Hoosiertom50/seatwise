"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, ApiError, apiErrorMessage } from "@/lib/api-client";
import { useSerialTasks } from "@/lib/serial-tasks";
import { useUnsavedChanges } from "@/lib/unsaved-changes";
import type {
  GuestDTO,
  PlanVersionDTO,
  PlanVersionDetailDTO,
  SeatingTableDTO,
} from "@seatwise/shared";

// TS-11 (Day-Of / Emergency Mode, FR-8.1/8.2/8.3/8.4): a phone-friendly view for the day of the
// wedding — find a guest fast, mark a no-show or walk-in, re-seat or swap without digging through
// the full Guests/Seating plan tabs. Every actionable control here targets ~44px (min-h-11) since
// FR-8.4 calls for this to work with a thumb, not a mouse.
export function DayOfTab({
  weddingId,
  guests,
  setGuests,
  canEdit,
}: {
  weddingId: string;
  guests: GuestDTO[];
  setGuests: React.Dispatch<React.SetStateAction<GuestDTO[]>>;
  canEdit: boolean;
}) {
  const [tables, setTables] = useState<SeatingTableDTO[]>([]);
  const [detail, setDetail] = useState<PlanVersionDetailDTO | null>(null);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [error, setErrorText] = useState<string | null>(null);
  // TS-175: the guest a message is about, when it's about one -- shown (and announced) in their row.
  const [errorGuestId, setErrorGuestId] = useState<string | null>(null);
  const setError = useCallback((message: string | null) => {
    setErrorText(message);
    setErrorGuestId(null);
  }, []);
  const setRowError = useCallback((guestId: string, message: string) => {
    setErrorText(message);
    setErrorGuestId(guestId);
  }, []);
  const [notice, setNotice] = useState<string | null>(null);
  // TS-170: every guest with a change queued or on its way (one value used to stand for all).
  const [busyIds, setBusyIds] = useState<ReadonlySet<string>>(new Set());
  const markBusy = (id: string, busy: boolean) =>
    setBusyIds((cur) => {
      const next = new Set(cur);
      if (busy) next.add(id);
      else next.delete(id);
      return next;
    });

  const [walkInFirst, setWalkInFirst] = useState("");
  const [walkInLast, setWalkInLast] = useState("");
  const [walkInTableId, setWalkInTableId] = useState("");
  const [addingWalkIn, setAddingWalkIn] = useState(false);

  const [swapAId, setSwapAId] = useState("");
  const [swapBId, setSwapBId] = useState("");
  const [swapping, setSwapping] = useState(false);
  // TS-166: seat, swap and attendance changes run one at a time, each against the plan as the one
  // before left it (see serial-tasks.ts) -- quick clicks used to undo each other on screen, or be
  // refused as if someone else had changed the plan.
  const queuePlanChange = useSerialTasks();
  const detailRef = useRef<PlanVersionDetailDTO | null>(null);
  useEffect(() => {
    detailRef.current = detail;
  }, [detail]);
  // TS-170: the guest list as it is right now, for queued changes.
  const guestsRef = useRef<GuestDTO[]>([]);
  useEffect(() => {
    guestsRef.current = guests;
  }, [guests]);
  function applyDetail(d: PlanVersionDetailDTO) {
    detailRef.current = d;
    setDetail(d);
  }
  // TS-166: a half-typed walk-in counts as unsaved input (TS-159).
  useUnsavedChanges("day-of-walk-in", walkInFirst.trim() !== "" || walkInLast.trim() !== "");

  async function load() {
    const [{ tables: tableList }, { planVersions }] = await Promise.all([
      api.get<{ tables: SeatingTableDTO[] }>(`/api/v1/weddings/${weddingId}/tables`),
      api.get<{ planVersions: PlanVersionDTO[] }>(`/api/v1/weddings/${weddingId}/plan-versions`),
    ]);
    setTables(tableList);
    // FR-5.6 (TS-8): a Comparison Draft can now have a higher versionNumber than Current without
    // replacing it, so "listed newest-first" no longer implies "first entry is Current" — find it
    // by isCurrent explicitly. Day-of mode must always act on the real Current version.
    const current = planVersions.find((v) => v.isCurrent) ?? planVersions[0];
    if (current) {
      const d = await api.get<{ planVersion: PlanVersionDetailDTO }>(
        `/api/v1/weddings/${weddingId}/plan-versions/${current.id}`
      );
      setDetail(d.planVersion);
    } else {
      setDetail(null);
    }
  }

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- TS-176: loads the day-of data when the tab opens.
    load()
      .catch(() => setError("Couldn't load day-of data."))
      .finally(() => setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [weddingId]);

  const tableLabelByGuestId = useMemo(() => {
    const map = new Map<string, string>();
    if (detail) for (const a of detail.assignments) map.set(a.guestId, a.tableLabel);
    return map;
  }, [detail]);

  const filteredGuests = useMemo(() => {
    const q = search.trim().toLowerCase();
    const sorted = [...guests].sort((a, b) => a.lastName.localeCompare(b.lastName));
    if (!q) return sorted;
    return sorted.filter((g) =>
      `${g.firstName} ${g.lastName} ${g.partyName ?? ""}`.toLowerCase().includes(q)
    );
  }, [guests, search]);

  const occupancy = useMemo(() => {
    const counts = new Map<string, number>();
    if (detail) {
      for (const a of detail.assignments) {
        const g = guests.find((g) => g.id === a.guestId);
        counts.set(a.tableId, (counts.get(a.tableId) ?? 0) + (g?.headcount ?? 1));
      }
    }
    return tables.map((t) => ({ table: t, seated: counts.get(t.id) ?? 0 }));
  }, [detail, tables, guests]);

  const attendingSeatedGuests = useMemo(() => {
    if (!detail) return [];
    return detail.assignments
      .map((a) => ({ id: a.guestId, name: a.guestName, tableLabel: a.tableLabel }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [detail]);

  function onToggleAttendance(guest: GuestDTO) {
    markBusy(guest.id, true);
    return queuePlanChange(() => toggleAttendance(guest));
  }

  async function toggleAttendance(clicked: GuestDTO) {
    // TS-170: worked out from the guest as they are when this runs, not as they were when clicked --
    // so a second click queued behind the first toggles back, as the planner expects.
    const guest = guestsRef.current.find((g) => g.id === clicked.id) ?? clicked;
    const nextAttendance = guest.dayOfAttendance === "ATTENDING" ? "NOT_ATTENDING" : "ATTENDING";
    setError(null);
    setNotice(null);
    try {
      const res = await api.post<{ planVersion: PlanVersionDetailDTO | null; guest: GuestDTO | null }>(
        `/api/v1/weddings/${weddingId}/guests/${guest.id}/attendance`,
        { attendance: nextAttendance }
      );
      // Functional update: built from the list as it is now, not as it was when this was clicked.
      // TS-175: the whole guest as saved (with their new revision), not just the attendance.
      const saved = (g: GuestDTO): GuestDTO => res.guest ?? { ...g, dayOfAttendance: nextAttendance };
      guestsRef.current = guestsRef.current.map((g) => (g.id === guest.id ? saved(g) : g));
      setGuests((cur) => cur.map((g) => (g.id === guest.id ? saved(g) : g)));
      if (res.planVersion) applyDetail(res.planVersion);
      setNotice(
        nextAttendance === "NOT_ATTENDING"
          ? `${guest.firstName} ${guest.lastName} marked not attending — their seat is now free.`
          : `${guest.firstName} ${guest.lastName} marked attending again — seat them below.`
      );
    } catch (err) {
      setRowError(guest.id, apiErrorMessage(err, [], "Couldn't update attendance."));
    } finally {
      markBusy(guest.id, false);
    }
  }

  // FR-7.7: a 409 here carries the fresh, currently-committed plan version -- refresh the view
  // with it instead of leaving stale data on screen after a conflicting save elsewhere.
  function conflictPlanVersion(err: unknown): PlanVersionDetailDTO | null {
    if (err instanceof ApiError && err.status === 409 && err.data?.planVersion) {
      return err.data.planVersion as PlanVersionDetailDTO;
    }
    return null;
  }

  function onSeatGuest(guestId: string, tableId: string) {
    if (!detail || !tableId) return;
    markBusy(guestId, true);
    return queuePlanChange(() => seatGuest(guestId, tableId));
  }

  async function seatGuest(guestId: string, tableId: string) {
    const current = detailRef.current;
    if (!current) return;
    setError(null);
    setNotice(null);
    try {
      const res = await api.post<{ planVersion: PlanVersionDetailDTO; warnings: string[] }>(
        `/api/v1/weddings/${weddingId}/plan-versions/${current.id}/assignments`,
        { guestId, tableId, expectedRevision: current.revision }
      );
      applyDetail(res.planVersion);
      if (res.warnings.length > 0) setNotice(res.warnings.join(" "));
    } catch (err) {
      const fresh = conflictPlanVersion(err);
      if (fresh) applyDetail(fresh);
      setRowError(guestId, apiErrorMessage(err, [], "Couldn't seat that guest."));
    } finally {
      markBusy(guestId, false);
    }
  }

  async function onAddWalkIn(e: React.FormEvent) {
    e.preventDefault();
    if (!walkInFirst.trim() || !walkInLast.trim()) return;
    setError(null);
    setNotice(null);
    setAddingWalkIn(true);
    // TS-151: once the guest exists, a failure is only about seating them -- the form clears and
    // says so, so pressing Add again can't create the same walk-in twice.
    let added: GuestDTO | null = null;
    try {
      const { guest } = await api.post<{ guest: GuestDTO }>(`/api/v1/weddings/${weddingId}/guests`, {
        firstName: walkInFirst,
        lastName: walkInLast,
        headcount: 1,
        dayOfAttendance: "ATTENDING",
      });
      added = guest;
      setGuests((cur) => [...cur, guest]);
      setWalkInFirst("");
      setWalkInLast("");
      if (walkInTableId && detail) {
        const tableId = walkInTableId;
        const res = await queuePlanChange(() => {
          const current = detailRef.current!;
          return api.post<{ planVersion: PlanVersionDetailDTO; warnings: string[] }>(
            `/api/v1/weddings/${weddingId}/plan-versions/${current.id}/assignments`,
            { guestId: guest.id, tableId, expectedRevision: current.revision }
          );
        });
        applyDetail(res.planVersion);
        setNotice(
          `Added walk-in ${guest.firstName} ${guest.lastName} and seated them` +
            (res.warnings.length > 0 ? ` — ${res.warnings.join(" ")}` : ".")
        );
      } else {
        setNotice(`Added walk-in ${guest.firstName} ${guest.lastName} — not yet seated.`);
      }
      setWalkInTableId("");
    } catch (err) {
      const fresh = conflictPlanVersion(err);
      if (fresh) applyDetail(fresh);
      if (added) {
        setNotice(`Added walk-in ${added.firstName} ${added.lastName} — not yet seated.`);
        setError(apiErrorMessage(err, [], "Couldn't seat them") + " Seat them from the guest list below.");
      } else {
        setError(apiErrorMessage(err, ["firstName", "lastName"], "Couldn't add that walk-in."));
      }
    } finally {
      setAddingWalkIn(false);
    }
  }

  async function onSwap() {
    if (!detail || !swapAId || !swapBId) return;
    setError(null);
    setNotice(null);
    setSwapping(true);
    try {
      const res = await queuePlanChange(() => {
        const current = detailRef.current!;
        return api.post<{ planVersion: PlanVersionDetailDTO; warnings: string[] }>(
          `/api/v1/weddings/${weddingId}/plan-versions/${current.id}/assignments/swap`,
          { guestAId: swapAId, guestBId: swapBId, expectedRevision: current.revision }
        );
      });
      applyDetail(res.planVersion);
      setNotice("Swapped." + (res.warnings.length > 0 ? ` ${res.warnings.join(" ")}` : ""));
      setSwapAId("");
      setSwapBId("");
    } catch (err) {
      const fresh = conflictPlanVersion(err);
      if (fresh) applyDetail(fresh);
      setError(apiErrorMessage(err, [], "Couldn't complete that swap."));
    } finally {
      setSwapping(false);
    }
  }

  if (loading) return <p className="text-sm text-neutral-500 dark:text-neutral-400">Loading day-of view...</p>;

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h2 className="mb-1 text-lg font-medium">Day-of mode</h2>
        <p className="text-sm text-neutral-500 dark:text-neutral-400">
          Mark no-shows and walk-ins, re-seat or swap guests fast — without a full regeneration.
          Nobody else&apos;s seat changes unless you move them.
        </p>
      </div>

      {!canEdit && (
        <p className="rounded-md bg-neutral-100 dark:bg-neutral-800 px-3 py-2 text-sm text-neutral-600 dark:text-neutral-300">
          You have view-only access to this wedding — marking attendance, seating, walk-ins, and
          swaps are turned off. You can still search and see where everyone&apos;s seated.
        </p>
      )}
      {error && !errorGuestId && (
        <p role="alert" className="text-sm text-red-600 dark:text-red-400">
          {error}
        </p>
      )}
      {notice && (
        <p className="rounded-lg border border-blue-200 dark:border-blue-800 bg-blue-50 dark:bg-blue-950 p-3 text-sm text-blue-800 dark:text-blue-300">
          {notice}
        </p>
      )}

      {!detail && (
        <p className="rounded-lg border border-neutral-200 dark:border-neutral-700 p-4 text-sm text-neutral-500 dark:text-neutral-400">
          No seating plan generated yet — attendance can still be marked below, but seating and
          swaps need a plan first (see the Seating plan tab).
        </p>
      )}

      {tables.length > 0 && (
        <div>
          <p className="mb-2 text-sm font-medium">Table occupancy</p>
          <div className="flex gap-2 overflow-x-auto pb-1">
            {occupancy.map(({ table, seated }) => (
              <div
                key={table.id}
                className="shrink-0 rounded-lg border border-neutral-200 dark:border-neutral-700 px-3 py-2 text-sm"
              >
                <p className="font-medium">{table.label}</p>
                <p className={seated >= table.capacity ? "text-red-600 dark:text-red-400" : "text-neutral-500 dark:text-neutral-400"}>
                  {seated}/{table.capacity} seated
                </p>
              </div>
            ))}
          </div>
        </div>
      )}

      <div>
        <label htmlFor="dayof-guest-search" className="mb-1 block text-sm font-medium">
          Find a guest
        </label>
        <input
          id="dayof-guest-search"
          className="min-h-11 w-full rounded-md border border-neutral-300 dark:border-neutral-600 px-3 py-3 text-base"
          placeholder="Search by name or party..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
      </div>

      <ul className="flex flex-col gap-2">
        {filteredGuests.map((g) => {
          const seatedAt = tableLabelByGuestId.get(g.id);
          const notAttending = g.dayOfAttendance === "NOT_ATTENDING";
          return (
            <li
              key={g.id}
              className={`flex flex-wrap items-center justify-between gap-2 rounded-lg border px-4 py-3 ${
                notAttending ? "border-neutral-200 dark:border-neutral-700 bg-neutral-50 dark:bg-neutral-900 opacity-60" : "border-neutral-200 dark:border-neutral-700"
              }`}
            >
              <div>
                <p className="font-medium">
                  {g.firstName} {g.lastName}
                  {g.headcount > 1 ? ` (+${g.headcount - 1})` : ""}
                </p>
                <p className="text-sm text-neutral-500 dark:text-neutral-400">
                  {notAttending
                    ? "Not attending"
                    : seatedAt
                      ? `Seated at ${seatedAt}`
                      : "Unassigned"}
                </p>
              </div>
              {canEdit && (
                <div className="flex min-h-11 flex-wrap items-center gap-2">
                  {!notAttending && detail && !seatedAt && (
                    <select
                      aria-label={`Seat ${g.firstName} ${g.lastName} at a table`}
                      className="min-h-11 rounded-md border border-neutral-300 dark:border-neutral-600 px-2 py-2 text-sm disabled:opacity-50"
                      value=""
                      disabled={busyIds.has(g.id)}
                      onChange={(e) => onSeatGuest(g.id, e.target.value)}
                    >
                      <option value="" disabled>
                        {busyIds.has(g.id) ? "Seating..." : "Seat at..."}
                      </option>
                      {tables.map((t) => (
                        <option key={t.id} value={t.id}>
                          {t.label}
                        </option>
                      ))}
                    </select>
                  )}
                  <button
                    onClick={() => onToggleAttendance(g)}
                    disabled={busyIds.has(g.id)}
                    className={`min-h-11 rounded-md border px-3 py-2 text-sm font-medium disabled:opacity-50 ${
                      notAttending
                        ? "border-neutral-300 dark:border-neutral-600 hover:bg-neutral-50 dark:hover:bg-neutral-800"
                        : "border-red-300 text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-950"
                    }`}
                  >
                    {notAttending ? "Mark attending" : "Mark not attending"}
                  </button>
                </div>
              )}
              {error && errorGuestId === g.id && (
                <p role="alert" className="basis-full text-sm text-red-600 dark:text-red-400">
                  {error}
                </p>
              )}
            </li>
          );
        })}
        {filteredGuests.length === 0 && (
          <p className="text-sm text-neutral-500 dark:text-neutral-400">No guests match &ldquo;{search}&rdquo;.</p>
        )}
      </ul>

      {canEdit && (
      <div className="rounded-lg border border-neutral-200 dark:border-neutral-700 p-4">
        <p className="mb-3 text-sm font-medium">Add a walk-in</p>
        <form onSubmit={onAddWalkIn} className="flex flex-col gap-3">
          <div className="flex flex-wrap gap-3">
            <label htmlFor="walkin-first-name" className="sr-only">
              First name
            </label>
            <input
              id="walkin-first-name"
              className="min-h-11 flex-1 rounded-md border border-neutral-300 dark:border-neutral-600 px-3 py-3 text-base"
              placeholder="First name"
              value={walkInFirst}
              onChange={(e) => setWalkInFirst(e.target.value)}
              required
            />
            <label htmlFor="walkin-last-name" className="sr-only">
              Last name
            </label>
            <input
              id="walkin-last-name"
              className="min-h-11 flex-1 rounded-md border border-neutral-300 dark:border-neutral-600 px-3 py-3 text-base"
              placeholder="Last name"
              value={walkInLast}
              onChange={(e) => setWalkInLast(e.target.value)}
              required
            />
          </div>
          {detail && (
            <select
              aria-label="Seat the walk-in at a table"
              className="min-h-11 rounded-md border border-neutral-300 dark:border-neutral-600 px-3 py-2 text-sm"
              value={walkInTableId}
              onChange={(e) => setWalkInTableId(e.target.value)}
            >
              <option value="">Seat at... (optional — can seat later)</option>
              {tables.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.label}
                </option>
              ))}
            </select>
          )}
          <button
            type="submit"
            disabled={addingWalkIn}
            className="min-h-11 rounded-md bg-neutral-900 dark:bg-neutral-100 px-4 py-2 text-sm font-medium text-white dark:text-neutral-900 hover:bg-neutral-700 dark:hover:bg-neutral-300 disabled:opacity-50"
          >
            {addingWalkIn ? "Adding..." : "Add walk-in"}
          </button>
        </form>
      </div>
      )}

      {canEdit && detail && attendingSeatedGuests.length >= 2 && (
        <div className="rounded-lg border border-neutral-200 dark:border-neutral-700 p-4">
          <p className="mb-3 text-sm font-medium">Swap two guests&apos; tables</p>
          <div className="flex flex-col gap-3 sm:flex-row">
            <select
              aria-label="First guest to swap"
              className="min-h-11 flex-1 rounded-md border border-neutral-300 dark:border-neutral-600 px-3 py-2 text-sm"
              value={swapAId}
              onChange={(e) => {
                setSwapAId(e.target.value);
                // TS-151: the same guest can't be on both sides of a swap.
                if (e.target.value === swapBId) setSwapBId("");
              }}
            >
              <option value="">First guest...</option>
              {attendingSeatedGuests.map((g) => (
                <option key={g.id} value={g.id}>
                  {g.name} ({g.tableLabel})
                </option>
              ))}
            </select>
            <select
              aria-label="Second guest to swap"
              className="min-h-11 flex-1 rounded-md border border-neutral-300 dark:border-neutral-600 px-3 py-2 text-sm"
              value={swapBId}
              onChange={(e) => setSwapBId(e.target.value)}
            >
              <option value="">Second guest...</option>
              {attendingSeatedGuests
                .filter((g) => g.id !== swapAId)
                .map((g) => (
                  <option key={g.id} value={g.id}>
                    {g.name} ({g.tableLabel})
                  </option>
                ))}
            </select>
            <button
              onClick={onSwap}
              disabled={swapping || !swapAId || !swapBId}
              className="min-h-11 shrink-0 rounded-md bg-neutral-900 dark:bg-neutral-100 px-4 py-2 text-sm font-medium text-white dark:text-neutral-900 hover:bg-neutral-700 dark:hover:bg-neutral-300 disabled:opacity-50"
            >
              {swapping ? "Swapping..." : "Swap"}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
