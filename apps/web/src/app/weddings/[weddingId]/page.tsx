"use client";

import { useEffect, useRef, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import Link from "next/link";
import { api, ApiError } from "@/lib/api-client";
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
import { NotificationsBell } from "@/components/NotificationsBell";

type Tab =
  | "guests"
  | "rules"
  | "tables"
  | "plan"
  | "dayof"
  | "timeline"
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
  { value: "comments", label: "Comments" },
  { value: "activity", label: "Activity" },
  { value: "collaborators", label: "Collaborators" },
];

type AccessLevel = "OWNER" | "EDIT" | "COMMENT" | "VIEW";

export default function WeddingDetailPage() {
  const { weddingId } = useParams<{ weddingId: string }>();
  const router = useRouter();

  const [wedding, setWedding] = useState<WeddingDTO | null>(null);
  const [guests, setGuests] = useState<GuestDTO[]>([]);
  const [accessLevel, setAccessLevel] = useState<AccessLevel | null>(null);
  const [currentUserId, setCurrentUserId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>("guests");
  // FR-1.6: "a change [to a collaborator's access] takes effect within five seconds, even for a
  // wedding already open in the user's browser." accessLevelRef lets the poll below compare
  // against the latest value without the interval's closure going stale between ticks.
  const accessLevelRef = useRef<AccessLevel | null>(null);
  const [accessNotice, setAccessNotice] = useState<string | null>(null);
  const [accessRevoked, setAccessRevoked] = useState(false);

  useEffect(() => {
    (async () => {
      try {
        const [w, g, me] = await Promise.all([
          api.get<{ wedding: WeddingDTO; accessLevel: AccessLevel }>(`/api/v1/weddings/${weddingId}`),
          api.get<{ guests: GuestDTO[] }>(`/api/v1/weddings/${weddingId}/guests`),
          api.get<{ user: { id: string } }>("/api/v1/auth/me"),
        ]);
        setWedding(w.wedding);
        setAccessLevel(w.accessLevel);
        accessLevelRef.current = w.accessLevel;
        setGuests(g.guests);
        setCurrentUserId(me.user.id);
      } catch (err) {
        if (err instanceof ApiError && err.status === 401) {
          router.push("/login");
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
    const interval = setInterval(async () => {
      try {
        const res = await api.get<{ wedding: WeddingDTO; accessLevel: AccessLevel }>(
          `/api/v1/weddings/${weddingId}`
        );
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
        if (err instanceof ApiError && (err.status === 404 || err.status === 401)) {
          setAccessRevoked(true);
          setAccessNotice("Your access to this wedding has been removed.");
          clearInterval(interval);
          setTimeout(() => router.push("/dashboard"), 3000);
        }
        // A transient network error is ignored -- the next tick tries again.
      }
    }, 4000);
    return () => clearInterval(interval);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [weddingId, error]);

  if (loading) {
    return <main className="flex flex-1 items-center justify-center text-neutral-500">Loading...</main>;
  }

  if (error && !wedding) {
    return (
      <main className="flex flex-1 flex-col items-center justify-center gap-3">
        <p className="text-sm text-red-600">{error}</p>
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
        <p className="text-sm text-red-600">{accessNotice}</p>
        <p className="text-sm text-neutral-500">Taking you back to your dashboard...</p>
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
    <main className="mx-auto w-full max-w-3xl flex-1 px-6 py-10">
      <div className="flex items-center justify-between">
        <Link href="/dashboard" className="text-sm text-neutral-500 hover:underline">
          &larr; Back to dashboard
        </Link>
        <NotificationsBell />
      </div>
      {accessNotice && !accessRevoked && (
        // FR-1.6: access changed (but was not revoked entirely) while this tab was already open --
        // a non-blocking notice, dismissable by the user, rather than the full-page redirect used
        // for a full revocation above.
        <div className="mt-3 flex items-center justify-between gap-3 rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-800">
          <span>{accessNotice}</span>
          <button
            onClick={() => setAccessNotice(null)}
            className="shrink-0 text-amber-800 underline hover:no-underline"
          >
            Dismiss
          </button>
        </div>
      )}
      <h1 className="mt-2 mb-1 text-2xl font-semibold">{wedding?.name}</h1>
      <p className="mb-6 text-sm text-neutral-500">
        {wedding?.eventDate ? new Date(wedding.eventDate).toLocaleDateString() : "No date set"}
        {wedding?.venueName ? ` · ${wedding.venueName}` : ""}
        {accessLevel && accessLevel !== "OWNER" && (
          <span className="ml-2 rounded-full bg-neutral-100 px-2 py-0.5 text-xs text-neutral-500">
            Your access: {accessLevel === "EDIT" ? "Edit" : accessLevel === "COMMENT" ? "Comment" : "View"}
          </span>
        )}
      </p>

      <div className="mb-8 flex gap-1 overflow-x-auto border-b border-neutral-200">
        {TABS.map((t) => (
          <button
            key={t.value}
            onClick={() => setTab(t.value)}
            className={`whitespace-nowrap px-4 py-2 text-sm font-medium ${
              tab === t.value
                ? "border-b-2 border-neutral-900 text-neutral-900"
                : "text-neutral-500 hover:text-neutral-700"
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

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
      {tab === "plan" && <PlanTab weddingId={weddingId} guests={guests} canEdit={canEdit} />}
      {tab === "dayof" && (
        <DayOfTab weddingId={weddingId} guests={guests} setGuests={setGuests} canEdit={canEdit} />
      )}
      {tab === "timeline" && <TimelineTab weddingId={weddingId} canEdit={canEdit} />}
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
          wedding={wedding}
          setWedding={setWedding}
        />
      )}
    </main>
  );
}
