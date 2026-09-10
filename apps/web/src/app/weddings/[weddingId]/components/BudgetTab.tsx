"use client";

import { useEffect, useState } from "react";
import { api, ApiError } from "@/lib/api-client";
import type { VendorDTO, VendorCategory, BudgetSummaryDTO } from "@seatwise/shared";

// TS-20 (FR-15.1/FR-15.2): a per-wedding vendor list plus the wedding's overall budget figure and
// a running total/remaining against it. Money is always handled here in whole dollars for
// display/entry and converted to/from integer cents at the API boundary -- the server never sees
// or stores a float (see the Vendor model comment in schema.prisma for why).
const CATEGORIES: { value: VendorCategory; label: string }[] = [
  { value: "CATERING", label: "Catering" },
  { value: "VENUE", label: "Venue" },
  { value: "FLORIST", label: "Florist" },
  { value: "PHOTOGRAPHY", label: "Photography" },
  { value: "VIDEOGRAPHY", label: "Videography" },
  { value: "MUSIC_ENTERTAINMENT", label: "Music / Entertainment" },
  { value: "ATTIRE", label: "Attire" },
  { value: "CAKE_BAKERY", label: "Cake / Bakery" },
  { value: "RENTALS", label: "Rentals" },
  { value: "TRANSPORTATION", label: "Transportation" },
  { value: "STATIONERY", label: "Stationery" },
  { value: "OTHER", label: "Other" },
];
const CATEGORY_LABEL: Record<VendorCategory, string> = Object.fromEntries(
  CATEGORIES.map((c) => [c.value, c.label])
) as Record<VendorCategory, string>;

function centsToDollarsString(cents: number | null): string {
  return cents === null ? "" : (cents / 100).toFixed(2);
}

// Returns null for a blank string (meaning "not set" for a vendor's cost, or "no budget" for the
// budget figure) rather than 0 -- an empty field is never silently treated as "free"/"$0 budget".
function dollarsStringToCents(value: string): number | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  const dollars = Number(trimmed);
  if (!Number.isFinite(dollars)) return null;
  return Math.round(dollars * 100);
}

function formatCents(cents: number): string {
  const sign = cents < 0 ? "-" : "";
  return `${sign}$${(Math.abs(cents) / 100).toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

export function BudgetTab({ weddingId, canEdit }: { weddingId: string; canEdit: boolean }) {
  const [vendors, setVendors] = useState<VendorDTO[]>([]);
  const [summary, setSummary] = useState<BudgetSummaryDTO | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [budgetInput, setBudgetInput] = useState("");
  const [savingBudget, setSavingBudget] = useState(false);

  const [name, setName] = useState("");
  const [category, setCategory] = useState<VendorCategory>("CATERING");
  const [categoryOther, setCategoryOther] = useState("");
  const [contactName, setContactName] = useState("");
  const [contactEmail, setContactEmail] = useState("");
  const [contactPhone, setContactPhone] = useState("");
  const [cost, setCost] = useState("");
  const [contractNotes, setContractNotes] = useState("");
  const [adding, setAdding] = useState(false);

  const [editingId, setEditingId] = useState<string | null>(null);
  const [editVendor, setEditVendor] = useState<Partial<VendorDTO>>({});
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    (async () => {
      try {
        const [vendorsRes, summaryRes] = await Promise.all([
          api.get<{ vendors: VendorDTO[] }>(`/api/v1/weddings/${weddingId}/vendors`),
          api.get<{ summary: BudgetSummaryDTO }>(`/api/v1/weddings/${weddingId}/budget`),
        ]);
        setVendors(vendorsRes.vendors);
        setSummary(summaryRes.summary);
        setBudgetInput(centsToDollarsString(summaryRes.summary.budgetCents));
      } catch {
        setError("Couldn't load budget & vendor info.");
      } finally {
        setLoading(false);
      }
    })();
  }, [weddingId]);

  async function onSaveBudget(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setSavingBudget(true);
    try {
      const { summary: updated } = await api.patch<{ summary: BudgetSummaryDTO }>(
        `/api/v1/weddings/${weddingId}/budget`,
        { budgetCents: dollarsStringToCents(budgetInput) }
      );
      setSummary(updated);
      setBudgetInput(centsToDollarsString(updated.budgetCents));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't save that budget figure.");
    } finally {
      setSavingBudget(false);
    }
  }

  async function onAdd(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setAdding(true);
    try {
      const { vendor } = await api.post<{ vendor: VendorDTO }>(`/api/v1/weddings/${weddingId}/vendors`, {
        name,
        category,
        categoryOther: category === "OTHER" ? categoryOther : null,
        contactName: contactName || null,
        contactEmail: contactEmail || null,
        contactPhone: contactPhone || null,
        costCents: dollarsStringToCents(cost),
        contractNotes: contractNotes || null,
      });
      setVendors([...vendors, vendor].sort((a, b) => a.name.localeCompare(b.name)));
      const { summary: updated } = await api.get<{ summary: BudgetSummaryDTO }>(
        `/api/v1/weddings/${weddingId}/budget`
      );
      setSummary(updated);
      setName("");
      setCategory("CATERING");
      setCategoryOther("");
      setContactName("");
      setContactEmail("");
      setContactPhone("");
      setCost("");
      setContractNotes("");
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't add that vendor.");
    } finally {
      setAdding(false);
    }
  }

  function startEdit(vendor: VendorDTO) {
    setEditingId(vendor.id);
    setEditVendor({ ...vendor });
  }

  // FR-7.7, extended to vendors: a stale save (someone else's edit landed first) refreshes this
  // row with the server's fresh copy and asks the user to retry, same pattern as Tables/Timeline.
  function conflictVendor(err: unknown): VendorDTO | null {
    if (err instanceof ApiError && err.status === 409 && err.data?.vendor) {
      return err.data.vendor as VendorDTO;
    }
    return null;
  }

  async function onSaveEdit(vendorId: string) {
    setSaving(true);
    setError(null);
    const expectedRevision = vendors.find((v) => v.id === vendorId)?.revision;
    try {
      const { vendor } = await api.patch<{ vendor: VendorDTO }>(
        `/api/v1/weddings/${weddingId}/vendors/${vendorId}`,
        {
          name: editVendor.name,
          category: editVendor.category,
          categoryOther: editVendor.category === "OTHER" ? editVendor.categoryOther || "" : null,
          contactName: editVendor.contactName ?? null,
          contactEmail: editVendor.contactEmail ?? null,
          contactPhone: editVendor.contactPhone ?? null,
          costCents: editVendor.costCents ?? null,
          contractNotes: editVendor.contractNotes ?? null,
          expectedRevision,
        }
      );
      setVendors(vendors.map((v) => (v.id === vendorId ? vendor : v)).sort((a, b) => a.name.localeCompare(b.name)));
      const { summary: updated } = await api.get<{ summary: BudgetSummaryDTO }>(
        `/api/v1/weddings/${weddingId}/budget`
      );
      setSummary(updated);
      setEditingId(null);
    } catch (err) {
      const fresh = conflictVendor(err);
      if (fresh) {
        setVendors(vendors.map((v) => (v.id === vendorId ? fresh : v)));
        setError(`"${fresh.name}" was just edited elsewhere — showing the latest. Try again if you still want to make this change.`);
      } else {
        setError(err instanceof ApiError ? err.message : "Couldn't save that vendor.");
      }
    } finally {
      setSaving(false);
    }
  }

  async function onRemove(id: string) {
    const prev = vendors;
    setVendors(vendors.filter((v) => v.id !== id));
    try {
      await api.delete(`/api/v1/weddings/${weddingId}/vendors/${id}`);
      const { summary: updated } = await api.get<{ summary: BudgetSummaryDTO }>(
        `/api/v1/weddings/${weddingId}/budget`
      );
      setSummary(updated);
    } catch {
      setVendors(prev);
      setError("Couldn't remove that vendor.");
    }
  }

  if (loading) return <p className="text-sm text-neutral-500 dark:text-neutral-400">Loading budget & vendors...</p>;

  const overBudget = summary?.remainingCents !== null && summary?.remainingCents !== undefined && summary.remainingCents < 0;

  return (
    <div>
      {!canEdit && (
        <p className="mb-4 rounded-md bg-neutral-100 dark:bg-neutral-800 px-3 py-2 text-sm text-neutral-600 dark:text-neutral-300">
          You have view-only access to this wedding's budget — adding, editing, and removing
          vendors is turned off.
        </p>
      )}

      {/* FR-15.2: the overall budget figure, plus a running total/remaining as vendor costs are
          recorded. Deliberately never a real financial transaction or payment -- these are
          planner-entered figures only (see FR-15.3's own scope note). */}
      <div className="mb-6 rounded-lg border border-neutral-200 dark:border-neutral-700 p-4">
        <h2 className="mb-3 text-lg font-medium">Overall budget</h2>
        {canEdit && (
          <form onSubmit={onSaveBudget} className="mb-3 flex flex-wrap items-end gap-2">
            <div>
              <label htmlFor="budget-total" className="mb-1 block text-xs font-medium">
                Budget ($)
              </label>
              <input
                id="budget-total"
                type="number"
                min={0}
                step="0.01"
                placeholder="e.g. 30000"
                className="w-40 rounded-md border border-neutral-300 dark:border-neutral-600 px-2 py-1.5 text-sm"
                value={budgetInput}
                onChange={(e) => setBudgetInput(e.target.value)}
              />
            </div>
            <button
              type="submit"
              disabled={savingBudget}
              className="rounded-md border border-neutral-300 dark:border-neutral-600 px-3 py-1.5 text-sm font-medium hover:bg-neutral-50 dark:hover:bg-neutral-800 disabled:opacity-50"
            >
              {savingBudget ? "Saving..." : "Save budget"}
            </button>
          </form>
        )}
        <div className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-3">
          <div>
            <p className="text-neutral-500 dark:text-neutral-400">Budget</p>
            <p className="text-lg font-medium">
              {summary?.budgetCents === null || summary?.budgetCents === undefined
                ? "Not set"
                : formatCents(summary.budgetCents)}
            </p>
          </div>
          <div>
            <p className="text-neutral-500 dark:text-neutral-400">Recorded so far</p>
            <p className="text-lg font-medium">{formatCents(summary?.totalCostCents ?? 0)}</p>
          </div>
          <div>
            <p className="text-neutral-500 dark:text-neutral-400">Remaining</p>
            <p className={`text-lg font-medium ${overBudget ? "text-red-600 dark:text-red-400" : ""}`}>
              {summary?.remainingCents === null || summary?.remainingCents === undefined
                ? "—"
                : formatCents(summary.remainingCents)}
            </p>
          </div>
        </div>
        {overBudget && (
          <p className="mt-2 text-sm text-red-600 dark:text-red-400">
            Recorded vendor costs are over budget by {formatCents(Math.abs(summary!.remainingCents!))}.
          </p>
        )}
      </div>

      {canEdit && (
        <>
          <h2 className="mb-3 text-lg font-medium">Add a vendor</h2>
          <form
            onSubmit={onAdd}
            className="mb-8 grid grid-cols-1 gap-3 rounded-lg border border-neutral-200 dark:border-neutral-700 p-4 sm:grid-cols-2"
          >
            <div>
              <label htmlFor="vendor-name" className="mb-1 block text-sm font-medium">
                Vendor name
              </label>
              <input
                id="vendor-name"
                className="w-full rounded-md border border-neutral-300 dark:border-neutral-600 px-3 py-2 text-sm"
                value={name}
                onChange={(e) => setName(e.target.value)}
                required
              />
            </div>
            <div>
              <label htmlFor="vendor-category" className="mb-1 block text-sm font-medium">
                Category
              </label>
              <select
                id="vendor-category"
                className="mb-2 w-full rounded-md border border-neutral-300 dark:border-neutral-600 px-3 py-2 text-sm"
                value={category}
                onChange={(e) => setCategory(e.target.value as VendorCategory)}
              >
                {CATEGORIES.map((c) => (
                  <option key={c.value} value={c.value}>
                    {c.label}
                  </option>
                ))}
              </select>
              {category === "OTHER" && (
                <input
                  aria-label="Category label"
                  placeholder="e.g. Officiant"
                  className="w-full rounded-md border border-neutral-300 dark:border-neutral-600 px-3 py-2 text-sm"
                  value={categoryOther}
                  onChange={(e) => setCategoryOther(e.target.value)}
                  required
                />
              )}
            </div>
            <div>
              <label htmlFor="vendor-contact-name" className="mb-1 block text-sm font-medium">
                Contact name (optional)
              </label>
              <input
                id="vendor-contact-name"
                className="w-full rounded-md border border-neutral-300 dark:border-neutral-600 px-3 py-2 text-sm"
                value={contactName}
                onChange={(e) => setContactName(e.target.value)}
              />
            </div>
            <div>
              <label htmlFor="vendor-cost" className="mb-1 block text-sm font-medium">
                Cost ($, optional)
              </label>
              <input
                id="vendor-cost"
                type="number"
                min={0}
                step="0.01"
                className="w-full rounded-md border border-neutral-300 dark:border-neutral-600 px-3 py-2 text-sm"
                value={cost}
                onChange={(e) => setCost(e.target.value)}
              />
            </div>
            <div>
              <label htmlFor="vendor-contact-email" className="mb-1 block text-sm font-medium">
                Contact email (optional)
              </label>
              <input
                id="vendor-contact-email"
                type="email"
                className="w-full rounded-md border border-neutral-300 dark:border-neutral-600 px-3 py-2 text-sm"
                value={contactEmail}
                onChange={(e) => setContactEmail(e.target.value)}
              />
            </div>
            <div>
              <label htmlFor="vendor-contact-phone" className="mb-1 block text-sm font-medium">
                Contact phone (optional)
              </label>
              <input
                id="vendor-contact-phone"
                className="w-full rounded-md border border-neutral-300 dark:border-neutral-600 px-3 py-2 text-sm"
                value={contactPhone}
                onChange={(e) => setContactPhone(e.target.value)}
              />
            </div>
            <div className="sm:col-span-2">
              <label htmlFor="vendor-notes" className="mb-1 block text-sm font-medium">
                Contract details / notes (optional)
              </label>
              <textarea
                id="vendor-notes"
                rows={2}
                placeholder="e.g. 50% deposit due 30 days before, final due day-of"
                className="w-full rounded-md border border-neutral-300 dark:border-neutral-600 px-3 py-2 text-sm"
                value={contractNotes}
                onChange={(e) => setContractNotes(e.target.value)}
              />
            </div>
            <button
              type="submit"
              disabled={adding}
              className="rounded-md bg-neutral-900 dark:bg-neutral-100 px-4 py-2 text-sm font-medium text-white dark:text-neutral-900 hover:bg-neutral-700 dark:hover:bg-neutral-300 disabled:opacity-50 sm:col-span-2"
            >
              {adding ? "Adding..." : "Add vendor"}
            </button>
          </form>
        </>
      )}

      {error && <p className="mb-4 text-sm text-red-600 dark:text-red-400">{error}</p>}

      <h2 className="mb-3 text-lg font-medium">Vendors ({vendors.length})</h2>
      {vendors.length === 0 ? (
        <p className="text-sm text-neutral-500 dark:text-neutral-400">No vendors recorded yet.</p>
      ) : (
        <ul className="flex flex-col gap-2">
          {vendors.map((v) => (
            <li key={v.id} className="rounded-lg border border-neutral-200 dark:border-neutral-700 px-4 py-3">
              {editingId === v.id ? (
                <div className="flex flex-col gap-2">
                  <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                    <input
                      aria-label="Edit vendor name"
                      className="rounded-md border border-neutral-300 dark:border-neutral-600 px-2 py-1 text-sm"
                      value={editVendor.name ?? ""}
                      onChange={(e) => setEditVendor({ ...editVendor, name: e.target.value })}
                    />
                    <select
                      aria-label="Edit category"
                      className="rounded-md border border-neutral-300 dark:border-neutral-600 px-2 py-1 text-sm"
                      value={editVendor.category}
                      onChange={(e) => setEditVendor({ ...editVendor, category: e.target.value as VendorCategory })}
                    >
                      {CATEGORIES.map((c) => (
                        <option key={c.value} value={c.value}>
                          {c.label}
                        </option>
                      ))}
                    </select>
                    {editVendor.category === "OTHER" && (
                      <input
                        aria-label="Edit category label"
                        className="rounded-md border border-neutral-300 dark:border-neutral-600 px-2 py-1 text-sm"
                        value={editVendor.categoryOther ?? ""}
                        onChange={(e) => setEditVendor({ ...editVendor, categoryOther: e.target.value })}
                      />
                    )}
                    <input
                      aria-label="Edit contact name"
                      placeholder="Contact name"
                      className="rounded-md border border-neutral-300 dark:border-neutral-600 px-2 py-1 text-sm"
                      value={editVendor.contactName ?? ""}
                      onChange={(e) => setEditVendor({ ...editVendor, contactName: e.target.value })}
                    />
                    <input
                      aria-label="Edit contact email"
                      placeholder="Contact email"
                      className="rounded-md border border-neutral-300 dark:border-neutral-600 px-2 py-1 text-sm"
                      value={editVendor.contactEmail ?? ""}
                      onChange={(e) => setEditVendor({ ...editVendor, contactEmail: e.target.value })}
                    />
                    <input
                      aria-label="Edit contact phone"
                      placeholder="Contact phone"
                      className="rounded-md border border-neutral-300 dark:border-neutral-600 px-2 py-1 text-sm"
                      value={editVendor.contactPhone ?? ""}
                      onChange={(e) => setEditVendor({ ...editVendor, contactPhone: e.target.value })}
                    />
                    <input
                      aria-label="Edit cost"
                      type="number"
                      min={0}
                      step="0.01"
                      placeholder="Cost ($)"
                      className="rounded-md border border-neutral-300 dark:border-neutral-600 px-2 py-1 text-sm"
                      value={centsToDollarsString(editVendor.costCents ?? null)}
                      onChange={(e) =>
                        setEditVendor({ ...editVendor, costCents: dollarsStringToCents(e.target.value) })
                      }
                    />
                  </div>
                  <textarea
                    aria-label="Edit contract notes"
                    rows={2}
                    className="w-full rounded-md border border-neutral-300 dark:border-neutral-600 px-2 py-1 text-sm"
                    value={editVendor.contractNotes ?? ""}
                    onChange={(e) => setEditVendor({ ...editVendor, contractNotes: e.target.value })}
                  />
                  <div className="flex gap-2">
                    <button
                      onClick={() => onSaveEdit(v.id)}
                      disabled={saving}
                      className="rounded-md bg-neutral-900 dark:bg-neutral-100 px-3 py-1.5 text-sm font-medium text-white dark:text-neutral-900 hover:bg-neutral-700 dark:hover:bg-neutral-300 disabled:opacity-50"
                    >
                      Save
                    </button>
                    <button
                      onClick={() => setEditingId(null)}
                      className="rounded-md border border-neutral-300 dark:border-neutral-600 px-3 py-1.5 text-sm hover:bg-neutral-50 dark:hover:bg-neutral-800"
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              ) : (
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div>
                    <p className="font-medium">
                      {v.name}
                      <span className="ml-2 rounded bg-neutral-100 dark:bg-neutral-800 px-1.5 py-0.5 text-xs text-neutral-600 dark:text-neutral-300">
                        {v.category === "OTHER" && v.categoryOther ? v.categoryOther : CATEGORY_LABEL[v.category]}
                      </span>
                    </p>
                    <p className="text-sm text-neutral-500 dark:text-neutral-400">
                      {[v.contactName, v.contactEmail, v.contactPhone].filter(Boolean).join(" · ") || "No contact info"}
                    </p>
                    {v.contractNotes && <p className="mt-1 text-sm text-neutral-500 dark:text-neutral-400">{v.contractNotes}</p>}
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="font-medium">{v.costCents === null ? "No cost set" : formatCents(v.costCents)}</span>
                    {canEdit && (
                      <>
                        <button
                          onClick={() => startEdit(v)}
                          className="rounded-md border border-neutral-300 dark:border-neutral-600 px-2 py-1 text-sm hover:bg-neutral-50 dark:hover:bg-neutral-800"
                        >
                          Edit
                        </button>
                        <button
                          onClick={() => onRemove(v.id)}
                          className="rounded-md border border-neutral-300 dark:border-neutral-600 px-2 py-1 text-sm text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-950"
                        >
                          Remove
                        </button>
                      </>
                    )}
                  </div>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
