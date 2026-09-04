"use client";

import { useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import Link from "next/link";
import { api, ApiError } from "@/lib/api-client";
import type { WeddingDTO, GuestDTO, GuestTier, RsvpStatus } from "@seatwise/shared";

const TIERS: GuestTier[] = ["VIP", "FAMILY", "FRIEND", "PLUS_ONE", "OTHER"];
const RSVP_STATUSES: RsvpStatus[] = ["PENDING", "CONFIRMED", "DECLINED"];

export default function WeddingDetailPage() {
  const { weddingId } = useParams<{ weddingId: string }>();
  const router = useRouter();

  const [wedding, setWedding] = useState<WeddingDTO | null>(null);
  const [guests, setGuests] = useState<GuestDTO[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");
  const [partyName, setPartyName] = useState("");
  const [headcount, setHeadcount] = useState(1);
  const [tier, setTier] = useState<GuestTier>("OTHER");
  const [rsvpStatus, setRsvpStatus] = useState<RsvpStatus>("PENDING");
  const [requiresAccessibleTable, setRequiresAccessibleTable] = useState(false);
  const [adding, setAdding] = useState(false);

  async function load() {
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
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [weddingId]);

  async function onAddGuest(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setAdding(true);
    try {
      const { guest } = await api.post<{ guest: GuestDTO }>(`/api/v1/weddings/${weddingId}/guests`, {
        firstName,
        lastName,
        partyName: partyName || null,
        headcount,
        tier,
        rsvpStatus,
        requiresAccessibleTable,
      });
      setGuests((prev) => [...prev, guest].sort((a, b) => a.lastName.localeCompare(b.lastName)));
      setFirstName("");
      setLastName("");
      setPartyName("");
      setHeadcount(1);
      setTier("OTHER");
      setRsvpStatus("PENDING");
      setRequiresAccessibleTable(false);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't add that guest.");
    } finally {
      setAdding(false);
    }
  }

  async function onDeleteGuest(guestId: string) {
    const prev = guests;
    setGuests(guests.filter((g) => g.id !== guestId));
    try {
      await api.delete(`/api/v1/weddings/${weddingId}/guests/${guestId}`);
    } catch {
      setGuests(prev);
      setError("Couldn't delete that guest.");
    }
  }

  async function onUpdateRsvp(guestId: string, newStatus: RsvpStatus) {
    const prev = guests;
    setGuests(guests.map((g) => (g.id === guestId ? { ...g, rsvpStatus: newStatus } : g)));
    try {
      await api.patch(`/api/v1/weddings/${weddingId}/guests/${guestId}`, { rsvpStatus: newStatus });
    } catch {
      setGuests(prev);
      setError("Couldn't update RSVP status.");
    }
  }

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
      <p className="mb-8 text-sm text-neutral-500">
        {wedding?.eventDate ? new Date(wedding.eventDate).toLocaleDateString() : "No date set"}
        {wedding?.venueName ? ` · ${wedding.venueName}` : ""}
      </p>

      <h2 className="mb-3 text-lg font-medium">Add a guest</h2>
      <form
        onSubmit={onAddGuest}
        className="mb-8 grid grid-cols-1 gap-3 rounded-lg border border-neutral-200 p-4 sm:grid-cols-2"
      >
        <div>
          <label className="mb-1 block text-sm font-medium">First name</label>
          <input
            className="w-full rounded-md border border-neutral-300 px-3 py-2 text-sm"
            value={firstName}
            onChange={(e) => setFirstName(e.target.value)}
            required
          />
        </div>
        <div>
          <label className="mb-1 block text-sm font-medium">Last name</label>
          <input
            className="w-full rounded-md border border-neutral-300 px-3 py-2 text-sm"
            value={lastName}
            onChange={(e) => setLastName(e.target.value)}
            required
          />
        </div>
        <div>
          <label className="mb-1 block text-sm font-medium">Party / household</label>
          <input
            className="w-full rounded-md border border-neutral-300 px-3 py-2 text-sm"
            placeholder="e.g. The Carter Family"
            value={partyName}
            onChange={(e) => setPartyName(e.target.value)}
          />
        </div>
        <div>
          <label className="mb-1 block text-sm font-medium">Headcount</label>
          <input
            type="number"
            min={1}
            max={20}
            className="w-full rounded-md border border-neutral-300 px-3 py-2 text-sm"
            value={headcount}
            onChange={(e) => setHeadcount(Number(e.target.value))}
          />
        </div>
        <div>
          <label className="mb-1 block text-sm font-medium">Tier</label>
          <select
            className="w-full rounded-md border border-neutral-300 px-3 py-2 text-sm"
            value={tier}
            onChange={(e) => setTier(e.target.value as GuestTier)}
          >
            {TIERS.map((t) => (
              <option key={t} value={t}>
                {t.replace("_", " ")}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className="mb-1 block text-sm font-medium">RSVP</label>
          <select
            className="w-full rounded-md border border-neutral-300 px-3 py-2 text-sm"
            value={rsvpStatus}
            onChange={(e) => setRsvpStatus(e.target.value as RsvpStatus)}
          >
            {RSVP_STATUSES.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </div>
        <label className="flex items-center gap-2 text-sm sm:col-span-2">
          <input
            type="checkbox"
            checked={requiresAccessibleTable}
            onChange={(e) => setRequiresAccessibleTable(e.target.checked)}
          />
          Requires an accessible table
        </label>
        <button
          type="submit"
          disabled={adding}
          className="rounded-md bg-neutral-900 px-4 py-2 text-sm font-medium text-white hover:bg-neutral-700 disabled:opacity-50 sm:col-span-2"
        >
          {adding ? "Adding..." : "Add guest"}
        </button>
      </form>

      {error && <p className="mb-4 text-sm text-red-600">{error}</p>}

      <h2 className="mb-3 text-lg font-medium">
        Guests ({guests.reduce((sum, g) => sum + g.headcount, 0)})
      </h2>
      {guests.length === 0 ? (
        <p className="text-sm text-neutral-500">No guests yet — add your first one above.</p>
      ) : (
        <ul className="flex flex-col gap-2">
          {guests.map((g) => (
            <li
              key={g.id}
              className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-neutral-200 px-4 py-3"
            >
              <div>
                <p className="font-medium">
                  {g.firstName} {g.lastName}
                  {g.headcount > 1 ? ` (+${g.headcount - 1})` : ""}
                  {g.requiresAccessibleTable && (
                    <span className="ml-2 rounded bg-blue-50 px-1.5 py-0.5 text-xs text-blue-700">
                      accessible table
                    </span>
                  )}
                </p>
                <p className="text-sm text-neutral-500">
                  {g.partyName ? `${g.partyName} · ` : ""}
                  {g.tier.replace("_", " ")}
                </p>
              </div>
              <div className="flex items-center gap-2">
                <select
                  className="rounded-md border border-neutral-300 px-2 py-1 text-sm"
                  value={g.rsvpStatus}
                  onChange={(e) => onUpdateRsvp(g.id, e.target.value as RsvpStatus)}
                >
                  {RSVP_STATUSES.map((s) => (
                    <option key={s} value={s}>
                      {s}
                    </option>
                  ))}
                </select>
                <button
                  onClick={() => onDeleteGuest(g.id)}
                  className="rounded-md border border-neutral-300 px-2 py-1 text-sm text-red-600 hover:bg-red-50"
                >
                  Remove
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}
