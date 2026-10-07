"use client";

import { useEffect, useRef, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import Link from "next/link";
import { api, ApiError } from "@/lib/api-client";
import { formatDate } from "@/lib/display-format";
import { useUnsavedChangesProvider } from "@/lib/unsaved-changes";
import { loginUrlReturningTo } from "@/lib/safe-next";
import type { WeddingDTO, GuestDTO } from "@seatwise/shared";
import { GuestsTab } from "./components/GuestsTab";
import { RulesTab } from "./components/RulesTab";
import { TablesTab } from "./components/TablesTab";
import { PlanTab } from "./components/PlanTab";
import { DayOfTab } from "./components/DayOfTab";
import { CollaboratorsTab } from "./components/CollaboratorsTab";
import { ActivityTab } from "./components/ActivityTab";
import { CommentsTab } from "./components/CommentsTab";
import { TimelineTab } from "./components/TimelineTab";
import { BudgetTab } from "./components/BudgetTab";
import { GettingStarted, loadGettingStartedCounts, type GettingStartedCounts } from "./components/GettingStarted";
import { NotificationsBell } from "@/components/NotificationsBell";
import { EmailVerificationNotice } from "@/components/EmailVerificationNotice";
import { SaveStatusIndicator } from "@/components/SaveStatusIndicator";
import { saveStatusStore } from "@/lib/save-status";

type Tab =
  | "guests"
  | "rules"
  | "tables"
  | "plan"
  | "dayof"
  | "timeline"
  | "budget"
  | "comments"
  | "activity"
  | "collaborators";

const TABS: { value: Tab; label: string }[] = [
  { value: "guests", label: "Guests" },
  { value: "rules", label: "Seating rules" },
  { value: "tables", label: "Tables" },
  { value: "plan", label: "Seating plan" },
  { value: "dayof", label: "Day-of mode" },
  // TS-18: intentionally its own tab, next to Day-of mode -- a run-of-show is a different kind of
  // "plan" than the seating plan, and never derived from or dependent on guests/tables/rules.
  { value: "timeline", label: "Timeline" },
  // TS-20: also its own tab, independent of guests/tables/rules/plan the same way Timeline is --
  // a vendor list and budget figure have nothing to do with seating.
  { value: "budget", label: "Budget" },
  { value: "comments", label: "Comments" },
  { value: "activity", label: "Activity" },
  { value: "collaborators", label: "Collaborators" },
];

type AccessLevel = "OWNER" | "EDIT" | "COMMENT" | "VIEW";

// TS-170: what pendingHref holds when the browser's Back button was pressed.
const BACK = "__back__";

export default function WeddingDetailPage() {
  const { weddingId } = useParams<{ weddingId: string }>();
  const router = useRouter();

  const [wedding, setWedding] = useState<WeddingDTO | null>(null);
  // TS-175: the browser tab names the wedding once it has loaded.
  useEffect(() => {
    if (wedding) document.title = `${wedding.name} · Seatwise`;
  }, [wedding]);
  const [guests, setGuests] = useState<GuestDTO[]>([]);
  const [accessLevel, setAccessLevel] = useState<AccessLevel | null>(null);
  // TS-151: "COUPLE" or "COLLABORATOR" for a collaborator, null for the owner.
  const [role, setRole] = useState<string | null>(null);
  const [currentUserId, setCurrentUserId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>("guests");
  // TS-159: a tab change waiting on "you have unsaved changes" -- see goToTab.
  // TS-170: the browser's Back button with unsaved input asks first, like the links do.
  const unsaved = useUnsavedChangesProvider({
    onBackRequested: () => {
      // TS-199: Back while typing in a box that saves when you leave it (a guest's name, notes or
      // email; a wedding setting) -- leaving it saves it, so the box is left (which saves it) and
      // Back carries on without asking. Anything else unsaved still asks, as before.
      const active = document.activeElement;
      rememberOpener();
      if (active instanceof HTMLElement && active.hasAttribute("data-blur-save")) {
        active.blur();
        if (!unsaved.hasUnsaved()) {
          questionOpener.current = null;
          unsaved.goBackPastPage(() => router.replace("/dashboard"));
          return;
        }
      }
      setPendingHref(BACK);
    },
  });
  const [pendingTab, setPendingTab] = useState<Tab | null>(null);
  // TS-166: leaving the wedding page itself ("Back to dashboard") asks the same question; the
  // browser's own prompt only covers closing or reloading the page, not links inside the app.
  const [pendingHref, setPendingHref] = useState<string | null>(null);
  // TS-191: the control that brought up the "unsaved changes" question, so focus can go back to it
  // when the question closes (it used to fall to the top of the page).
  // TS-199: remembered by id too -- a guest row's box is often drawn anew (after a save elsewhere on
  // the row, say) while the question is up, and the old element is then gone.
  const questionOpener = useRef<{ node: HTMLElement; id: string } | null>(null);
  function rememberOpener(preferred?: HTMLElement | null) {
    const active = document.activeElement;
    const node = preferred ?? (active instanceof HTMLElement && active !== document.body ? active : null);
    questionOpener.current = node ? { node, id: node.id } : null;
  }
  function restoreFocus(target: { node: HTMLElement; id: string } | HTMLElement | null) {
    setTimeout(() => {
      // Only if focus was lost with the question (it falls to the page) -- someone who has already
      // clicked into another box keeps their place, rather than having what they type land here.
      const active = document.activeElement;
      const focusLost = !active || active === document.body || !active.isConnected;
      if (!focusLost || !target) return;
      const remembered = target instanceof HTMLElement ? { node: target, id: target.id } : target;
      const byId = remembered.id ? document.getElementById(remembered.id) : null;
      const element = byId ?? (remembered.node.isConnected ? remembered.node : null);
      element?.focus();
    }, 0);
  }
  function goToTab(next: Tab) {
    if (next === tab) return;
    if (unsaved.hasUnsaved()) {
      // A tab click asks about that tab, so that tab is the opener (Safari doesn't focus a clicked
      // button); anything else (Getting started) is whatever has focus.
      const clickedTab = document.getElementById(`tab-${next}`);
      const active = document.activeElement;
      const fromTabList = active instanceof HTMLElement && active.getAttribute("role") === "tab";
      rememberOpener(fromTabList || active === document.body ? clickedTab : undefined);
      setPendingTab(next);
    } else setTab(next);
  }
  /** True to follow the link now; false when the question is being asked first. */
  function requestLeavePage(href: string): boolean {
    if (!unsaved.hasUnsaved()) return true;
    rememberOpener();
    setPendingHref(href);
    return false;
  }
  function leaveTab() {
    if (pendingHref === BACK) {
      setPendingHref(null);
      // TS-175: opened in a fresh tab, there's no page before this one -- go to the dashboard.
      unsaved.goBackPastPage(() => router.replace("/dashboard"));
      return;
    }
    if (pendingHref) {
      const href = pendingHref;
      setPendingHref(null);
      // TS-175: replace the page's extra history entry rather than leaving it behind (Back from the
      // next page used to land on it, a dead copy of this one).
      if (unsaved.releaseForLink()) router.replace(href);
      else router.push(href);
      return;
    }
    if (!pendingTab) return;
    unsaved.clear();
    setTab(pendingTab);
    setPendingTab(null);
    // TS-191: the tab that was asked for has focus once it opens.
    questionOpener.current = null;
    restoreFocus(document.getElementById(`tab-${pendingTab}`));
  }
  // TS-182: arrow keys move along the tab list (and open that tab, asking first if needed).
  function onTabKeyDown(e: React.KeyboardEvent<HTMLDivElement>) {
    // TS-199: counted from the tab that has focus -- while "unsaved changes?" is up, the open tab
    // and the focused one differ, and arrows used to jump from the open one.
    const focusedTab = e.target instanceof HTMLElement && e.target.id.startsWith("tab-") ? e.target.id.slice(4) : null;
    const focusedIndex = TABS.findIndex((t) => t.value === focusedTab);
    const index = focusedIndex >= 0 ? focusedIndex : TABS.findIndex((t) => t.value === tab);
    let next = -1;
    if (e.key === "ArrowRight") next = (index + 1) % TABS.length;
    else if (e.key === "ArrowLeft") next = (index - 1 + TABS.length) % TABS.length;
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = TABS.length - 1;
    if (next < 0) return;
    e.preventDefault();
    const target = TABS[next].value;
    goToTab(target);
    document.getElementById(`tab-${target}`)?.focus();
  }
  function stayOnTab() {
    setPendingTab(null);
    setPendingHref(null);
    // TS-191: back to whatever brought the question up -- the clicked tab, the link, or the field
    // that was being typed in when Back was pressed.
    restoreFocus(questionOpener.current);
    questionOpener.current = null;
  }
  const [startCounts, setStartCounts] = useState<GettingStartedCounts | null>(null);
  // FR-1.6: "a change [to a collaborator's access] takes effect within five seconds, even for a
  // wedding already open in the user's browser." accessLevelRef lets the poll below compare
  // against the latest value without the interval's closure going stale between ticks.
  const accessLevelRef = useRef<AccessLevel | null>(null);
  const [accessNotice, setAccessNotice] = useState<string | null>(null);
  const [accessRevoked, setAccessRevoked] = useState(false);

  useEffect(() => {
    // TS-93: the save indicator's history belongs to the wedding it happened on.
    saveStatusStore.resetHistory();
    (async () => {
      try {
        const [w, g, me, counts] = await Promise.all([
          api.get<{ wedding: WeddingDTO; accessLevel: AccessLevel; role: string | null }>(`/api/v1/weddings/${weddingId}`),
          api.get<{ guests: GuestDTO[] }>(`/api/v1/weddings/${weddingId}/guests`),
          api.get<{ user: { id: string } }>("/api/v1/auth/me"),
          // TS-115: loaded with the page, not after it, so the Getting started strip never
          // pushes the tab row down once it's on screen.
          loadGettingStartedCounts(weddingId),
        ]);
        setWedding(w.wedding);
        setAccessLevel(w.accessLevel);
        setRole(w.role ?? null);
        accessLevelRef.current = w.accessLevel;
        setGuests(g.guests);
        setCurrentUserId(me.user.id);
        setStartCounts(counts);
      } catch (err) {
        if (err instanceof ApiError && err.status === 401) {
          router.push(loginUrlReturningTo(`/weddings/${weddingId}`));
          return;
        }
        if (err instanceof ApiError && err.status === 404) {
          setError("Wedding not found.");
          return;
        }
        setError("Couldn't load this wedding.");
      } finally {
        setLoading(false);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [weddingId]);

  // FR-1.6: poll this page's own access level every 4s (comfortably under the 5s requirement) so
  // a permission change or revocation made by the owner is reflected here even if this browser
  // tab was already open and idle -- not just enforced on this user's next request, which was
  // already true before this. Stops once access has been detected as fully revoked (nothing left
  // to poll for) or the page errored out on initial load.
  useEffect(() => {
    if (error) return;
    let redirectTimer: ReturnType<typeof setTimeout> | undefined;
    // TS-182: a poll that was already in flight when the page closed could still answer 404 and
    // start the redirect timer after the cleanup below had run -- nothing then cancelled it.
    let cancelled = false;
    // TS-199: each check is numbered; on a slow connection an older answer can arrive after a newer
    // one, and it's dropped (once a newer answer has been used) rather than putting back access
    // that has since changed.
    let lastSent = 0;
    let lastAnswered = 0;
    const interval = setInterval(async () => {
      const check = ++lastSent;
      try {
        const res = await api.get<{ wedding: WeddingDTO; accessLevel: AccessLevel; role: string | null }>(
          `/api/v1/weddings/${weddingId}`
        );
        if (cancelled || check < lastAnswered) return;
        lastAnswered = check;
        // TS-182: the role (Couple or Collaborator) can change too, and decides who may approve.
        setRole(res.role ?? null);
        if (res.accessLevel !== accessLevelRef.current) {
          const previous = accessLevelRef.current;
          accessLevelRef.current = res.accessLevel;
          setAccessLevel(res.accessLevel);
          setWedding(res.wedding);
          if (previous !== null) {
            const label =
              res.accessLevel === "OWNER"
                ? "Owner"
                : res.accessLevel === "EDIT"
                  ? "Edit"
                  : res.accessLevel === "COMMENT"
                    ? "Comment"
                    : "View";
            setAccessNotice(`Your access to this wedding was changed to ${label}.`);
          }
        }
      } catch (err) {
        if (cancelled || check < lastAnswered) return;
        if (err instanceof ApiError && err.status === 404) {
          lastAnswered = check;
          setAccessRevoked(true);
          // TS-214: a 404 is the same answer for a deleted wedding and for removed access, so the
          // message covers both -- it used to say "access removed" when the owner deleted the wedding.
          setAccessNotice("This wedding is no longer available (it may have been deleted, or your access was removed).");
          clearInterval(interval);
          // TS-166: cancelled if the planner leaves first (e.g. "Go now", then opens another
          // wedding) -- it used to fire anyway and pull them back to the dashboard.
          redirectTimer = setTimeout(() => router.push("/dashboard"), 3000);
        }
        // TS-109: a 401 is an expired session, not revoked access -- the app-wide
        // SessionExpiredNotice (fired from api-client) says so and offers sign-in, and this page
        // stays mounted so nothing on it is lost. Polling carries on, so a session restored in
        // another tab is picked up on the next tick. A transient network error is likewise
        // ignored -- the next tick tries again.
      }
    }, 4000);
    return () => {
      cancelled = true;
      clearInterval(interval);
      if (redirectTimer) clearTimeout(redirectTimer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [weddingId, error]);

  if (loading) {
    return <main className="flex flex-1 items-center justify-center text-neutral-500 dark:text-neutral-400">Loading...</main>;
  }

  if (error && !wedding) {
    return (
      <main className="flex flex-1 flex-col items-center justify-center gap-3">
        <p className="text-sm text-red-600 dark:text-red-400">{error}</p>
        <Link href="/dashboard" className="text-sm underline">
          Back to dashboard
        </Link>
      </main>
    );
  }

  // FR-1.6: access was revoked entirely while this page was already open -- stop rendering the
  // tabs below (their own data is no longer ours to see) rather than let them fail confusingly
  // against a 404, and explain what happened before redirecting.
  if (accessRevoked) {
    return (
      <main className="flex flex-1 flex-col items-center justify-center gap-3">
        <p className="text-sm text-red-600 dark:text-red-400">{accessNotice}</p>
        <p className="text-sm text-neutral-500 dark:text-neutral-400">Taking you back to your dashboard...</p>
        <Link href="/dashboard" className="text-sm underline">
          Go now
        </Link>
      </main>
    );
  }

  const canComment = accessLevel === "OWNER" || accessLevel === "EDIT" || accessLevel === "COMMENT";
  const canEdit = accessLevel === "OWNER" || accessLevel === "EDIT";
  const isOwner = accessLevel === "OWNER";

  return (
    <main className="mx-auto w-full max-w-[1600px] flex-1 px-6 py-10">
      <div className="flex items-center justify-between">
        <Link
          href="/dashboard"
          onClick={(e) => {
            if (!requestLeavePage("/dashboard")) e.preventDefault();
          }}
          className="text-sm text-neutral-500 dark:text-neutral-400 hover:underline"
        >
          &larr; Back to dashboard
        </Link>
        <div className="flex items-center gap-4">
          <SaveStatusIndicator />
          <NotificationsBell onLeave={requestLeavePage} />
        </div>
      </div>

      {/* TS-164 */}
      <div className="mt-4">
        <EmailVerificationNotice />
      </div>
      {accessNotice && !accessRevoked && (
        // FR-1.6: access changed (but was not revoked entirely) while this tab was already open --
        // a non-blocking notice, dismissable by the user, rather than the full-page redirect used
        // for a full revocation above.
        <div className="mt-3 flex items-center justify-between gap-3 rounded-md bg-amber-50 dark:bg-amber-950 px-3 py-2 text-sm text-amber-800 dark:text-amber-300">
          <span>{accessNotice}</span>
          <button
            onClick={() => setAccessNotice(null)}
            className="shrink-0 text-amber-800 dark:text-amber-300 underline hover:no-underline"
          >
            Dismiss
          </button>
        </div>
      )}
      <h1 className="mt-2 mb-1 text-2xl font-semibold break-words [overflow-wrap:anywhere]">{wedding?.name}</h1>
      <p className="mb-6 text-sm text-neutral-500 dark:text-neutral-400">
        {wedding?.eventDate ? formatDate(wedding.eventDate) : "No date set"}
        {wedding?.venueName ? ` · ${wedding.venueName}` : ""}
        {accessLevel && accessLevel !== "OWNER" && (
          <span className="ml-2 rounded-full bg-neutral-100 dark:bg-neutral-800 px-2 py-0.5 text-xs text-neutral-500 dark:text-neutral-400">
            Your access: {accessLevel === "EDIT" ? "Edit" : accessLevel === "COMMENT" ? "Comment" : "View"}
          </span>
        )}
      </p>

      {/* TS-96: where-to-start hint for a wedding with no plan yet -- editors only, since the steps
          are all edits. */}
      {canEdit && (
        <GettingStarted
          weddingId={weddingId}
          guestCount={guests.length}
          peopleCount={guests.reduce((sum, g) => sum + g.headcount, 0)}
          initialCounts={startCounts}
          refreshKey={tab}
          onGoTo={goToTab}
        />
      )}

      {/* TS-182: a real tab list for screen readers -- which tab is open, and which panel it shows.
          Left/Right (and Home/End) move between tabs, like any other tab list. */}
      {/* TS-199: tabIndex -1 -- on a phone the row scrolls sideways, and Firefox makes any scrolling
          area its own Tab stop. The selected tab is already the one stop for this row; the arrow
          keys move along it (and bring each tab into view). */}
      <div
        role="tablist"
        aria-label="Wedding sections"
        tabIndex={-1}
        onKeyDown={onTabKeyDown}
        className="mb-8 flex gap-1 overflow-x-auto border-b border-neutral-200 dark:border-neutral-700"
      >
        {TABS.map((t) => (
          <button
            key={t.value}
            id={`tab-${t.value}`}
            role="tab"
            type="button"
            aria-selected={tab === t.value}
            aria-controls="wedding-tabpanel"
            tabIndex={tab === t.value ? 0 : -1}
            onClick={() => goToTab(t.value)}
            className={`whitespace-nowrap px-4 py-2 text-sm font-medium ${
              tab === t.value
                ? "border-b-2 border-neutral-900 dark:border-neutral-100 text-neutral-900 dark:text-neutral-100"
                : "text-neutral-500 dark:text-neutral-400 hover:text-neutral-700 dark:hover:text-neutral-300"
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {/* TS-159 */}
      {(pendingTab || pendingHref) && (
        <div
          role="alertdialog"
          aria-labelledby="unsaved-question"
          className="mb-6 flex flex-wrap items-center gap-3 rounded-md bg-amber-50 dark:bg-amber-950 px-4 py-3 text-sm text-amber-900 dark:text-amber-200"
        >
          <span id="unsaved-question" className="flex-1">
            You have unsaved changes on this tab. Leave it and lose them?
          </span>
          <button
            type="button"
            autoFocus
            onClick={stayOnTab}
            className="rounded-md border border-neutral-300 dark:border-neutral-600 px-3 py-1.5 text-sm hover:bg-neutral-50 dark:hover:bg-neutral-800"
          >
            Stay on this tab
          </button>
          <button
            type="button"
            onClick={leaveTab}
            className="rounded-md bg-red-700 px-3 py-1.5 text-sm font-medium text-white hover:bg-red-800"
          >
            Leave without saving
          </button>
        </div>
      )}

      <unsaved.Provider value={unsaved.registry}>
      <div id="wedding-tabpanel" role="tabpanel" aria-labelledby={`tab-${tab}`}>
      {tab === "guests" && (
        <GuestsTab
          weddingId={weddingId}
          wedding={wedding}
          guests={guests}
          setGuests={setGuests}
          canEdit={canEdit}
        />
      )}
      {tab === "rules" && <RulesTab weddingId={weddingId} guests={guests} canEdit={canEdit} />}
      {tab === "tables" && (
        <TablesTab weddingId={weddingId} wedding={wedding} guests={guests} canEdit={canEdit} />
      )}
      {tab === "plan" && (
        <PlanTab
          weddingId={weddingId}
          guests={guests}
          canEdit={canEdit}
          // TS-151: the same rule the status route applies -- the owner, or a Couple member with
          // Comment or Edit access.
          canApprove={accessLevel === "OWNER" || (role === "COUPLE" && (accessLevel === "COMMENT" || accessLevel === "EDIT"))}
        />
      )}
      {tab === "dayof" && (
        <DayOfTab weddingId={weddingId} guests={guests} setGuests={setGuests} canEdit={canEdit} />
      )}
      {tab === "timeline" && <TimelineTab weddingId={weddingId} canEdit={canEdit} />}
      {tab === "budget" && <BudgetTab weddingId={weddingId} canEdit={canEdit} />}
      {tab === "comments" && (
        <CommentsTab
          weddingId={weddingId}
          guests={guests}
          canComment={canComment}
          canEdit={canEdit}
          currentUserId={currentUserId}
        />
      )}
      {tab === "activity" && <ActivityTab weddingId={weddingId} />}
      {tab === "collaborators" && (
        <CollaboratorsTab
          weddingId={weddingId}
          isOwner={isOwner}
          currentUserId={currentUserId}
          wedding={wedding}
          setWedding={setWedding}
        />
      )}
      </div>
      </unsaved.Provider>
    </main>
  );
}
