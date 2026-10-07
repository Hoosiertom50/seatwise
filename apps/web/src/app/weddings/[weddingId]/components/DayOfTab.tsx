"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, ApiError, apiErrorMessage } from "@/lib/api-client";
import { useSerialTasks } from "@/lib/serial-tasks";
import { useUnsavedChanges } from "@/lib/unsaved-changes";
import { PickThenActControl } from "@/components/PickThenActControl";
import { tableChoicesFor, seatResultMessage } from "@/lib/day-of-choices";
import type {
  GuestDTO,
  PlanVersionDTO,
  PlanVersionDetailDTO,
  RelationshipDTO,
  SeatingTableDTO,
} from "@seatwise/shared";
// TS-193: the same limits the server checks (packages/shared/src/field-limits.ts).
import { FIELD_LIMITS } from "@seatwise/shared";

// TS-197: shown when Day-of switches to a plan made since it opened (as the Seating plan tab does).
const NEWER_PLAN_MESSAGE = "A newer plan was made — you're now looking at it.";
// TS-197: a change sent to the plan that was just replaced -- nothing was saved.
const SUPERSEDED_CHANGE_MESSAGE = "That wasn't saved — a newer plan was made. Check it and try again.";

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
  // TS-197: must-sit-together rules, so "Move to…" offers only tables the whole group fits.
  const [relationships, setRelationships] = useState<RelationshipDTO[]>([]);
  const [detail, setDetail] = useState<PlanVersionDetailDTO | null>(null);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [error, setError] = useState<string | null>(null);
  // TS-175: a message about one guest is shown (and announced) in their row.
  // TS-208: kept per guest -- one guest's refusal used to be wiped the moment a change queued for
  // another guest started, so a refused move looked done. Each is cleared when that guest's next
  // change is asked for (at the click, not when the queued change runs).
  const [rowErrors, setRowErrors] = useState<Readonly<Record<string, string>>>({});
  const setRowError = useCallback((guestId: string, message: string) => {
    setRowErrors((cur) => ({ ...cur, [guestId]: message }));
  }, []);
  const clearRowError = useCallback((guestId: string) => {
    setRowErrors((cur) => {
      if (!(guestId in cur)) return cur;
      const next = { ...cur };
      delete next[guestId];
      return next;
    });
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
  // TS-199: shown in the walk-in form itself, next to the names.
  const [walkInNameError, setWalkInNameError] = useState<string | null>(null);

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
  // TS-182: only while the form is there (it's hidden without Edit access).
  useUnsavedChanges("day-of-walk-in", canEdit && (walkInFirst.trim() !== "" || walkInLast.trim() !== ""));

  async function load() {
    const [{ tables: tableList }, { planVersions }, { relationships: rules }] = await Promise.all([
      api.get<{ tables: SeatingTableDTO[] }>(`/api/v1/weddings/${weddingId}/tables`),
      api.get<{ planVersions: PlanVersionDTO[] }>(`/api/v1/weddings/${weddingId}/plan-versions`),
      api.get<{ relationships: RelationshipDTO[] }>(`/api/v1/weddings/${weddingId}/relationships`),
    ]);
    setTables(tableList);
    setRelationships(rules);
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

  // TS-197: the plan open here (`openId`, or none yet) is no longer the current one -- someone made
  // or restored a newer plan. Opens the current plan, with the tables and rules as they are now,
  // and says so -- unless another plan was opened here meanwhile, which is then left alone.
  async function switchToCurrentPlan(openId: string | null, isCancelled: () => boolean) {
    const stillOpen = () => !isCancelled() && (detailRef.current?.id ?? null) === openId;
    const { planVersions } = await api.get<{ planVersions: PlanVersionDTO[] }>(`/api/v1/weddings/${weddingId}/plan-versions`);
    if (!stillOpen()) return;
    const newCurrent = planVersions.find((v) => v.isCurrent);
    if (!newCurrent || newCurrent.id === openId) return;
    const [opened, { tables: tableList }, { relationships: rules }] = await Promise.all([
      api.get<{ planVersion: PlanVersionDetailDTO }>(`/api/v1/weddings/${weddingId}/plan-versions/${newCurrent.id}`),
      api.get<{ tables: SeatingTableDTO[] }>(`/api/v1/weddings/${weddingId}/tables`),
      api.get<{ relationships: RelationshipDTO[] }>(`/api/v1/weddings/${weddingId}/relationships`),
    ]);
    if (!stillOpen()) return;
    setTables(tableList);
    setRelationships(rules);
    applyDetail(opened.planVersion);
    setNotice(openId ? NEWER_PLAN_MESSAGE : "A seating plan was made — you're now looking at it.");
  }

  // TS-197: a refused change came back with the plan as it is now. When that's a different plan --
  // a newer one replaced the plan open here -- Day-of switches to it and says so (tables and rules
  // are reloaded too, best-effort); otherwise it's the same plan with a newer revision.
  // Returns whether it was a switch.
  function takeFreshPlan(fresh: PlanVersionDetailDTO): boolean {
    const openId = detailRef.current?.id;
    applyDetail(fresh);
    if (!openId || fresh.id === openId) return false;
    setNotice(NEWER_PLAN_MESSAGE);
    Promise.all([
      api.get<{ tables: SeatingTableDTO[] }>(`/api/v1/weddings/${weddingId}/tables`),
      api.get<{ relationships: RelationshipDTO[] }>(`/api/v1/weddings/${weddingId}/relationships`),
    ])
      .then(([{ tables: tableList }, { relationships: rules }]) => {
        setTables(tableList);
        setRelationships(rules);
      })
      .catch(() => {});
    return true;
  }

  // TS-197: the same 4-second check the Seating plan tab makes (FR-7.7): a change saved elsewhere
  // shows up here, and when the plan open here stops being the current one (or a first plan is
  // made), Day-of switches to the current plan. Paused while a change from this screen is queued or
  // on its way, and only ever takes a newer copy than the one on screen.
  const dayOfBusy = busyIds.size > 0 || addingWalkIn || swapping;
  const openPlanId = detail?.id ?? null;
  useEffect(() => {
    if (loading || dayOfBusy) return;
    let cancelled = false;
    const interval = setInterval(async () => {
      try {
        // TS-207: the tables and seating rules too, every tick -- a capacity raised, a table added
        // or removed (removing an empty one doesn't touch the plan), or a new rule on the laptop
        // used to show here only after switching plans, so lists offered tables the server then
        // refused, or none at all. (The guest list is kept fresh by the wedding page.)
        void Promise.all([
          api.get<{ tables: SeatingTableDTO[] }>(`/api/v1/weddings/${weddingId}/tables`),
          api.get<{ relationships: RelationshipDTO[] }>(`/api/v1/weddings/${weddingId}/relationships`),
        ])
          .then(([{ tables: tableList }, { relationships: rules }]) => {
            if (cancelled) return;
            setTables(tableList);
            setRelationships(rules);
          })
          .catch(() => {});
        if (!openPlanId) {
          await switchToCurrentPlan(null, () => cancelled);
          return;
        }
        const res = await api.get<{ planVersion: PlanVersionDetailDTO }>(
          `/api/v1/weddings/${weddingId}/plan-versions/${openPlanId}`
        );
        if (cancelled) return;
        if (!res.planVersion.isCurrent) {
          await switchToCurrentPlan(openPlanId, () => cancelled);
          return;
        }
        const shown = detailRef.current;
        if (shown && shown.id === openPlanId && shown.revision < res.planVersion.revision) applyDetail(res.planVersion);
      } catch {
        // Best-effort, like the Seating plan tab's check -- the next tick tries again.
      }
    }, 4000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- TS-197: switchToCurrentPlan only uses setters and refs.
  }, [openPlanId, weddingId, loading, dayOfBusy]);

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

  // TS-182: messages about guests the search is hiding (or who have gone) are shown at the top, with
  // their names, instead of nowhere.
  const shownIds = new Set(filteredGuests.map((g) => g.id));
  const hiddenRowErrors = Object.entries(rowErrors)
    .filter(([id]) => !shownIds.has(id))
    .map(([id, message]) => {
      const g = guests.find((x) => x.id === id);
      return { id, text: g ? `${g.firstName} ${g.lastName}: ${message}` : message };
    });

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

  // TS-197: the tables a guest can be moved to (or, TS-208, seated at -- and a walk-in, with null):
  // the ones the server would accept for their whole must-sit-together group -- room for everyone,
  // accessible if needed, Restricted lists respected and (TS-208) nobody there they must not sit
  // with. See day-of-choices.ts. "Seat at…" and the walk-in list used to offer every table.
  const choiceContext = useMemo(
    () => ({ guests, tables, assignments: detail?.assignments ?? [], relationships }),
    [guests, tables, detail, relationships]
  );
  const choicesFor = (guestId: string | null) => tableChoicesFor(guestId, choiceContext);
  const walkInChoices = useMemo(() => tableChoicesFor(null, choiceContext), [choiceContext]);

  const attendingSeatedGuests = useMemo(() => {
    if (!detail) return [];
    return detail.assignments
      .map((a) => ({ id: a.guestId, name: a.guestName, tableLabel: a.tableLabel }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [detail]);

  // TS-208: the messages from before are cleared here, at the click -- not when the queued change
  // runs, which used to wipe the refusal of the change queued just ahead of it.
  function clearMessagesFor(guestId: string) {
    setError(null);
    setNotice(null);
    clearRowError(guestId);
  }

  function onToggleAttendance(guest: GuestDTO) {
    clearMessagesFor(guest.id);
    markBusy(guest.id, true);
    return queuePlanChange(() => toggleAttendance(guest));
  }

  async function toggleAttendance(clicked: GuestDTO) {
    // TS-170: worked out from the guest as they are when this runs, not as they were when clicked --
    // so a second click queued behind the first toggles back, as the planner expects.
    const guest = guestsRef.current.find((g) => g.id === clicked.id) ?? clicked;
    const nextAttendance = guest.dayOfAttendance === "ATTENDING" ? "NOT_ATTENDING" : "ATTENDING";
    const hadSeat = (detailRef.current?.assignments ?? []).some((a) => a.guestId === guest.id);
    try {
      const res = await api.post<{ planVersion: PlanVersionDetailDTO | null; guest: GuestDTO | null; unchanged?: boolean }>(
        `/api/v1/weddings/${weddingId}/guests/${guest.id}/attendance`,
        { attendance: nextAttendance }
      );
      // Functional update: built from the list as it is now, not as it was when this was clicked.
      // TS-175: the whole guest as saved (with their new revision), not just the attendance.
      const saved = (g: GuestDTO): GuestDTO => res.guest ?? { ...g, dayOfAttendance: nextAttendance };
      guestsRef.current = guestsRef.current.map((g) => (g.id === guest.id ? saved(g) : g));
      setGuests((cur) => cur.map((g) => (g.id === guest.id ? saved(g) : g)));
      if (res.planVersion) applyDetail(res.planVersion);
      const name = `${guest.firstName} ${guest.lastName}`;
      // TS-207: they already had that attendance (changed on another screen, or by their own RSVP
      // link) -- nothing was changed here, and the screen says so instead of claiming it did.
      if (res.unchanged) {
        setNotice(
          nextAttendance === "NOT_ATTENDING"
            ? `${name} was already marked not attending (changed elsewhere).`
            : `${name} was already marked attending (changed elsewhere).`
        );
        return;
      }
      setNotice(
        nextAttendance === "NOT_ATTENDING"
          ? // TS-177: only say a seat was freed when they had one.
            `${name} marked not attending${hadSeat ? " — their seat is now free" : ""}.`
          : `${name} marked attending again${detailRef.current ? " — seat them below" : " — they'll need a seat once there's a plan"}.`
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

  // TS-191 (Tom's decision): `moving` is a guest who already has a seat going to another table --
  // the same move the Seating plan tab makes (one guest, nobody else's seat changes, the server
  // checks room and the seating rules).
  function onSeatGuest(guestId: string, tableId: string, moving = false) {
    if (!detail || !tableId) return;
    clearMessagesFor(guestId);
    markBusy(guestId, true);
    // TS-208: the plan on screen at the click -- a queued change isn't quietly made on a newer plan
    // that opened while it waited (the Seating plan tab already refused that).
    const planId = detail.id;
    return queuePlanChange(() => seatGuest(guestId, tableId, moving, planId));
  }

  async function seatGuest(guestId: string, tableId: string, moving: boolean, planId: string) {
    const current = detailRef.current;
    if (!current || current.id !== planId) {
      setRowError(guestId, SUPERSEDED_CHANGE_MESSAGE);
      markBusy(guestId, false);
      return;
    }
    try {
      const res = await api.post<{ planVersion: PlanVersionDetailDTO; warnings: string[] }>(
        `/api/v1/weddings/${weddingId}/plan-versions/${current.id}/assignments`,
        { guestId, tableId, expectedRevision: current.revision }
      );
      applyDetail(res.planVersion);
      // TS-197: everyone who went to that table -- a must-sit-together group moves together, and
      // the notice used to name only the guest whose row was used.
      // TS-208: said for "Seat" too (it said nothing, even when a partner was moved along):
      // "Seated A at T2." or "Moved A and B to T2.".
      const said = seatResultMessage(guestId, tableId, current.assignments, res.planVersion.assignments) ?? (moving ? "Moved." : "Seated.");
      setNotice(res.warnings.length > 0 ? `${said} ${res.warnings.join(" ")}` : said);
    } catch (err) {
      const fresh = conflictPlanVersion(err);
      // TS-197: a newer plan replaced this one -- Day-of is now showing it; the change wasn't made.
      if (fresh && takeFreshPlan(fresh)) {
        setRowError(guestId, SUPERSEDED_CHANGE_MESSAGE);
        return;
      }
      setRowError(guestId, apiErrorMessage(err, [], moving ? "Couldn't move that guest." : "Couldn't seat that guest."));
    } finally {
      markBusy(guestId, false);
    }
  }

  // TS-189: the open plan as it is now, after adding a guest moved it on a revision.
  async function refreshAfterGuestAdded(): Promise<PlanVersionDetailDTO> {
    const { planVersion } = await api.get<{ planVersion: PlanVersionDetailDTO }>(
      `/api/v1/weddings/${weddingId}/plan-versions/${detailRef.current!.id}`
    );
    applyDetail(planVersion);
    return planVersion;
  }

  async function onAddWalkIn(e: React.FormEvent) {
    e.preventDefault();
    // TS-199: a name of only spaces got past the browser's "required" check and then nothing
    // happened -- now it says why.
    if (!walkInFirst.trim() || !walkInLast.trim()) {
      setWalkInNameError(!walkInFirst.trim() ? "Enter the walk-in's first name." : "Enter the walk-in's last name.");
      return;
    }
    setWalkInNameError(null);
    setError(null);
    setNotice(null);
    setAddingWalkIn(true);
    // TS-208: only a table still offered counts (it may have filled up, or gone, since it was picked).
    const tableId = walkInChoices.some((c) => c.table.id === walkInTableId) ? walkInTableId : "";
    const firstName = walkInFirst;
    const lastName = walkInLast;
    // TS-208: the plan on screen now -- they aren't seated on a newer plan that opens meanwhile.
    const planId = detail?.id ?? null;
    // TS-151: once the guest exists, a failure is only about seating them -- the form clears and
    // says so, so pressing Add again can't create the same walk-in twice.
    // (Kept in an object: it's set inside the queued task below.)
    const progress: { added: GuestDTO | null } = { added: null };
    try {
      // TS-197: adding the guest, taking the plan as that left it, and seating them are one queued
      // task -- before, the guest was added outside the queue, so a seat change queued just ahead
      // could run in between and be refused (or this one refused) as working from an old copy.
      const seated = await queuePlanChange(async () => {
        const { guest } = await api.post<{ guest: GuestDTO }>(`/api/v1/weddings/${weddingId}/guests`, {
          firstName,
          lastName,
          headcount: 1,
          dayOfAttendance: "ATTENDING",
        });
        progress.added = guest;
        guestsRef.current = [...guestsRef.current, guest];
        setGuests((cur) => [...cur, guest]);
        setWalkInFirst("");
        setWalkInLast("");
        if (!detailRef.current) return null;
        // TS-189: adding a guest moves the plan on a revision (they're a new unseated guest) -- take
        // the plan as it is now, so seating them (or a later "Seat at…") isn't refused as out of date.
        if (!tableId) {
          // (If that reload fails, the next change is refused as out of date and refreshes then.)
          await refreshAfterGuestAdded().catch(() => {});
          return null;
        }
        const current = await refreshAfterGuestAdded();
        if (current.id !== planId) throw new Error(SUPERSEDED_CHANGE_MESSAGE);
        return api.post<{ planVersion: PlanVersionDetailDTO; warnings: string[] }>(
          `/api/v1/weddings/${weddingId}/plan-versions/${current.id}/assignments`,
          { guestId: guest.id, tableId, expectedRevision: current.revision }
        );
      });
      const guest = progress.added!;
      if (seated) {
        applyDetail(seated.planVersion);
        setNotice(
          `Added walk-in ${guest.firstName} ${guest.lastName} and seated them` +
            (seated.warnings.length > 0 ? ` — ${seated.warnings.join(" ")}` : ".")
        );
      } else {
        setNotice(`Added walk-in ${guest.firstName} ${guest.lastName} — not yet seated.`);
      }
      setWalkInTableId("");
    } catch (err) {
      const fresh = conflictPlanVersion(err);
      if (fresh) takeFreshPlan(fresh);
      const added = progress.added;
      if (added) {
        setWalkInTableId("");
        setNotice(`Added walk-in ${added.firstName} ${added.lastName} — not yet seated.`);
        // TS-208: a newer plan opened before they could be seated -- said as such.
        const why =
          err instanceof Error && err.message === SUPERSEDED_CHANGE_MESSAGE
            ? "They weren't seated — a newer plan was made."
            : apiErrorMessage(err, [], "Couldn't seat them.");
        setError(`${why} Seat them from the guest list below.`);
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
    // TS-208: the plan on screen at the click (see onSeatGuest).
    const planId = detail.id;
    try {
      const res = await queuePlanChange(() => {
        const current = detailRef.current!;
        if (current.id !== planId) throw new Error(SUPERSEDED_CHANGE_MESSAGE);
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
      // TS-197: a newer plan replaced this one -- Day-of is now showing it; nothing was swapped.
      if ((fresh && takeFreshPlan(fresh)) || (err instanceof Error && err.message === SUPERSEDED_CHANGE_MESSAGE)) {
        setSwapAId("");
        setSwapBId("");
        setError(SUPERSEDED_CHANGE_MESSAGE);
        return;
      }
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
          Mark no-shows and walk-ins, move, re-seat or swap guests fast — without a full regeneration.
          Nobody else&apos;s seat changes unless you move them — except that guests who must sit
          together always move together.
        </p>
      </div>

      {!canEdit && (
        <p className="rounded-md bg-neutral-100 dark:bg-neutral-800 px-3 py-2 text-sm text-neutral-600 dark:text-neutral-300">
          You have view-only access to this wedding — marking attendance, seating, walk-ins, and
          swaps are turned off. You can still search and see where everyone&apos;s seated.
        </p>
      )}
      {error && (
        <p role="alert" className="text-sm text-red-600 dark:text-red-400">
          {error}
        </p>
      )}
      {hiddenRowErrors.map((e) => (
        <p key={e.id} role="alert" className="text-sm text-red-600 dark:text-red-400">
          {e.text}
        </p>
      ))}
      {notice && (
        <p role="status" className="rounded-lg border border-blue-200 dark:border-blue-800 bg-blue-50 dark:bg-blue-950 p-3 text-sm text-blue-800 dark:text-blue-300">
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
          maxLength={FIELD_LIMITS.search}
          id="dayof-guest-search"
          className="min-h-11 w-full rounded-md border border-neutral-300 dark:border-neutral-600 px-3 py-3 text-base"
          placeholder="Search by name or party..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
      </div>

      {/* TS-208: said outside the list (it was a paragraph inside it), and a wedding with no guests
          says so -- it read 'No guests match “”.'. */}
      {filteredGuests.length === 0 && (
        <p className="text-sm text-neutral-500 dark:text-neutral-400">
          {guests.length === 0 ? "No guests yet." : <>No guests match &ldquo;{search}&rdquo;.</>}
        </p>
      )}
      <ul className="flex flex-col gap-2">
        {filteredGuests.map((g) => {
          const seatedAt = tableLabelByGuestId.get(g.id);
          const notAttending = g.dayOfAttendance === "NOT_ATTENDING";
          // TS-191: the other tables with enough free seats for this guest's party.
          // TS-197: ...and for their whole must-sit-together group, by every rule the server checks.
          // TS-208: for "Seat at…" too (it offered every table).
          const choices = !notAttending && detail ? choicesFor(g.id) : [];
          const choiceOptions = choices.map(({ table, free }) => ({ value: table.id, label: `${table.label} (${free} free)` }));
          const rowError = rowErrors[g.id];
          return (
            <li
              key={g.id}
              className={`flex flex-wrap items-center justify-between gap-2 rounded-lg border px-4 py-3 ${
                notAttending ? "border-neutral-200 dark:border-neutral-700 bg-neutral-50 dark:bg-neutral-900 opacity-60" : "border-neutral-200 dark:border-neutral-700"
              }`}
            >
              {/* TS-199: a long name wraps instead of pushing the row off a phone screen. */}
              <div className="min-w-0">
                <p className="break-words font-medium [overflow-wrap:anywhere]">
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
                  {/* TS-199: pick a table, then press Seat -- the arrow keys no longer seat the guest
                      at every table on the way (see PickThenActControl). */}
                  {!notAttending && detail && !seatedAt && (
                    <PickThenActControl
                      id={`dayof-move-${g.id}`}
                      label={`Seat ${g.firstName} ${g.lastName} at a table`}
                      placeholder={choices.length === 0 ? "No table has room" : "Seat at..."}
                      busy={busyIds.has(g.id)}
                      busyLabel="Seating..."
                      disabled={choices.length === 0}
                      options={choiceOptions}
                      fallbackFocusId={`dayof-attendance-${g.id}`}
                      actLabel="Seat"
                      actAriaLabel={`Seat ${g.firstName} ${g.lastName}`}
                      selectClassName="min-h-11 max-w-full rounded-md border border-neutral-300 dark:border-neutral-600 px-2 py-2 text-sm disabled:opacity-50"
                      onAct={(tableId) => onSeatGuest(g.id, tableId)}
                    />
                  )}
                  {/* TS-191 (Tom's decision): a seated guest can be moved to any other table with
                      enough free seats for their party. Swap (below) stays for full tables. */}
                  {!notAttending && detail && seatedAt && (
                    <PickThenActControl
                      id={`dayof-move-${g.id}`}
                      label={`Move ${g.firstName} ${g.lastName} to another table`}
                      placeholder={choices.length === 0 ? "No other table has room" : "Move to..."}
                      busy={busyIds.has(g.id)}
                      busyLabel="Moving..."
                      disabled={choices.length === 0}
                      options={choiceOptions}
                      // TS-208: when every table is full the list is off and can't take focus back
                      // after the move -- it goes to the guest's attendance button instead.
                      fallbackFocusId={`dayof-attendance-${g.id}`}
                      actLabel="Move"
                      actAriaLabel={`Move ${g.firstName} ${g.lastName}`}
                      selectClassName="min-h-11 max-w-full rounded-md border border-neutral-300 dark:border-neutral-600 px-2 py-2 text-sm disabled:opacity-50"
                      onAct={(tableId) => onSeatGuest(g.id, tableId, true)}
                    />
                  )}
                  <button
                    id={`dayof-attendance-${g.id}`}
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
              {rowError && (
                <p role="alert" className="basis-full text-sm text-red-600 dark:text-red-400">
                  {rowError}
                </p>
              )}
            </li>
          );
        })}
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
              maxLength={FIELD_LIMITS.personName}
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
              maxLength={FIELD_LIMITS.personName}
              id="walkin-last-name"
              className="min-h-11 flex-1 rounded-md border border-neutral-300 dark:border-neutral-600 px-3 py-3 text-base"
              placeholder="Last name"
              value={walkInLast}
              onChange={(e) => setWalkInLast(e.target.value)}
              required
            />
          </div>
          {walkInNameError && (
            <p role="alert" className="text-sm text-red-600 dark:text-red-400">
              {walkInNameError}
            </p>
          )}
          {detail && (
            <select
              aria-label="Seat the walk-in at a table"
              className="min-h-11 rounded-md border border-neutral-300 dark:border-neutral-600 px-3 py-2 text-sm"
              // TS-208: a pick that's no longer offered (the table filled up or went) counts as none.
              value={walkInChoices.some((c) => c.table.id === walkInTableId) ? walkInTableId : ""}
              onChange={(e) => setWalkInTableId(e.target.value)}
            >
              <option value="">Seat at... (optional — can seat later)</option>
              {/* TS-208: only tables a walk-in can be seated at (a free seat, not Restricted), with
                  their free seats -- it offered every table, full ones included. */}
              {walkInChoices.map(({ table, free }) => (
                <option key={table.id} value={table.id}>
                  {table.label} ({free} free)
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
