"use client";

import { useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import Link from "next/link";
import { api, ApiError } from "@/lib/api-client";
import type { WeddingDTO, GuestDTO } from "@seatwise/shared";
import { GuestsTab } from "./components/GuestsTab";
import { RulesTab } from "./components/RulesTab";
import { TablesTab } from "./components/TablesTab";
import { PlanTab } from "./components/PlanTab";
import { DayOfTab } from "./components/DayOfTab";

type Tab = "guests" | "rules" | "tables" | "plan" | "dayof";

const TABS: { value: Tab; label: string }[] = [
  { value: "guests", label: "Guests" },
  { value: "rules", label: "Seating rules" },
  { value: "tables", label: "Tables" },
  { value: "plan", label: "Seating plan" },
  { value: "dayof", label: "Day-of mode" },
];

export default function WeddingDetailPage() {
  const { weddingId } = useParams<{ weddingId: string }>();
  const router = useRouter();

  const [wedding, setWedding] = useState<WeddingDTO | null>(null);
  const [guests, setGuests] = useState<GuestDTO[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>("guests");

  useEffect(() => {
    (async () => {
      try {
        const [w, g] = await Promise.all([
          api.get<{ wedding: WeddingDTO }>(`/api/v1/weddings/${weddingId}`),
          api.get<{ guests: GuestDTO[] }>(`/api/v1/weddings/${weddingId}/guests`),
        ]);
        setWedding(w.wedding);
        setGuests(g.guests);
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

  return (
    <main className="mx-auto w-full max-w-3xl flex-1 px-6 py-10">
      <Link href="/dashboard" className="text-sm text-neutral-500 hover:underline">
        &larr; Back to dashboard
      </Link>
      <h1 className="mt-2 mb-1 text-2xl font-semibold">{wedding?.name}</h1>
      <p className="mb-6 text-sm text-neutral-500">
        {wedding?.eventDate ? new Date(wedding.eventDate).toLocaleDateString() : "No date set"}
        {wedding?.venueName ? ` · ${wedding.venueName}` : ""}
      </p>

      <div className="mb-8 flex gap-1 border-b border-neutral-200">
        {TABS.map((t) => (
          <button
            key={t.value}
            onClick={() => setTab(t.value)}
            className={`px-4 py-2 text-sm font-medium ${
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
        <GuestsTab weddingId={weddingId} guests={guests} setGuests={setGuests} />
      )}
      {tab === "rules" && <RulesTab weddingId={weddingId} guests={guests} />}
      {tab === "tables" && <TablesTab weddingId={weddingId} />}
      {tab === "plan" && <PlanTab weddingId={weddingId} guests={guests} />}
      {tab === "dayof" && (
        <DayOfTab weddingId={weddingId} guests={guests} setGuests={setGuests} />
      )}
    </main>
  );
}
