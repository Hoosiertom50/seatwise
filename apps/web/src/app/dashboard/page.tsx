"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { api, ApiError } from "@/lib/api-client";
import type { WeddingDTO } from "@seatwise/shared";
import { NotificationsBell } from "@/components/NotificationsBell";

export default function DashboardPage() {
  const router = useRouter();
  const [userName, setUserName] = useState<string | null>(null);
  const [userId, setUserId] = useState<string | null>(null);
  const [weddings, setWeddings] = useState<WeddingDTO[]>([]);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");
  const [newDate, setNewDate] = useState("");
  const [newVenue, setNewVenue] = useState("");
  // FR-1.3: "an optional note" -- always fine left blank.
  const [newNote, setNewNote] = useState("");
  const [showNote, setShowNote] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      try {
        const me = await api.get<{ user: { id: string; name: string } }>("/api/v1/auth/me");
        setUserName(me.user.name);
        setUserId(me.user.id);
        const list = await api.get<{ weddings: WeddingDTO[] }>("/api/v1/weddings");
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

  async function onCreate(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setCreating(true);
    try {
      const { wedding } = await api.post<{ wedding: WeddingDTO }>("/api/v1/weddings", {
        name: newName,
        eventDate: newDate || null,
        venueName: newVenue || null,
        note: newNote || null,
      });
      setWeddings((prev) => [wedding, ...prev]);
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
    <main className="mx-auto w-full max-w-3xl flex-1 px-6 py-10">
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

      {weddings.length === 0 ? (
        <p className="text-sm text-neutral-500">
          No weddings yet — add one above to start building a guest list.
        </p>
      ) : (
        <ul className="flex flex-col gap-2">
          {weddings.map((w) => (
            <li key={w.id}>
              <Link
                href={`/weddings/${w.id}`}
                className="flex items-center justify-between rounded-lg border border-neutral-200 px-4 py-3 hover:border-neutral-400"
              >
                <div>
                  <p className="font-medium">
                    {w.name}
                    {userId && w.ownerId !== userId && (
                      <span className="ml-2 rounded-full bg-neutral-100 px-2 py-0.5 text-xs font-normal text-neutral-500">
                        Shared with you
                      </span>
                    )}
                  </p>
                  <p className="text-sm text-neutral-500">
                    {w.eventDate ? new Date(w.eventDate).toLocaleDateString() : "No date set"}
                    {w.venueName ? ` · ${w.venueName}` : ""}
                  </p>
                </div>
                <span className="text-sm text-neutral-500">
                  {w.guestCount} guest{w.guestCount === 1 ? "" : "s"}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}
