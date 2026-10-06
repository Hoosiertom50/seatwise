"use client";

import { useEffect, useState, useRef } from "react";
import { ConfirmDeleteButton } from "@/components/ConfirmDeleteButton";
import { api, ApiError, apiErrorMessage } from "@/lib/api-client";
import { formatClockTime, OPEN_EDIT_MESSAGE } from "@/lib/display-format";
import { matchVendorSuggestions } from "@/lib/vendor-suggestions";
import type {
  VendorDTO,
  VendorCategory,
  BudgetSummaryDTO,
  VendorShareLinkDTO,
  VendorSuggestionDTO,
} from "@seatwise/shared";
import { useUnsavedChanges } from "@/lib/unsaved-changes";

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
// TS-175: "$1,500.50" is read as 1500.50 -- dollar signs, commas and spaces are dropped first. It
// used to be read as no amount at all ("1,500" became "not set" without a word).
function dollarsStringToCents(value: string): number | null {
  const cleaned = value.replace(/[$,\s]/g, "");
  if (!cleaned) return null;
  const dollars = Number(cleaned);
  if (!Number.isFinite(dollars)) return null;
  return Math.round(dollars * 100);
}

/** TS-175: why an amount box can't be saved as typed, or null when it can (blank is fine). */
function amountProblem(value: string, what: string): string | null {
  const cleaned = value.replace(/[$,\s]/g, "");
  if (!cleaned || /^(\d+(\.\d{0,2})?|\.\d{1,2})$/.test(cleaned)) return null;
  return `${what} must be an amount in dollars, like 1500 or 1,500.50.`;
}

function formatCents(cents: number): string {
  const sign = cents < 0 ? "-" : "";
  // TS-182: always US formatting -- amounts are dollars, and a browser set to another language used
  // to show e.g. "$1.234,50".
  return `${sign}$${(Math.abs(cents) / 100).toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

// TS-180: one order for the vendor list -- on load and after every change. The list used to come
// in in the database's order and be re-sorted differently after an edit, so vendors jumped about.
function sortVendors(list: VendorDTO[]): VendorDTO[] {
  return [...list].sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
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
  const [arrivalTime, setArrivalTime] = useState("");
  const [adding, setAdding] = useState(false);
  // TS-97: vendors from the planner's other weddings, suggested as they type a name.
  const [suggestions, setSuggestions] = useState<VendorSuggestionDTO[]>([]);
  const [pickedSuggestion, setPickedSuggestion] = useState<string | null>(null);
  // TS-114: per-vendor feedback after a share-link action ("Link copied", or the bare link when
  // the clipboard isn't available), keyed by vendor id.
  const [shareResult, setShareResult] = useState<Record<string, string>>({});
  const [shareBusy, setShareBusy] = useState<string | null>(null);

  const [editingId, setEditingId] = useState<string | null>(null);
  const [editVendor, setEditVendor] = useState<Partial<VendorDTO>>({});
  // TS-151: the cost exactly as typed while editing -- turned into cents only on save. Reformatting
  // every keystroke ("1" -> "1.00") made a real cost impossible to type.
  const [editCostText, setEditCostText] = useState("");
  // TS-159: tell the page this tab has input that leaving it would lose.
  // TS-166: including a budget figure typed but not yet saved.
  const budgetEdited = summary !== null && budgetInput !== centsToDollarsString(summary.budgetCents);
  const budgetEditedRef = useRef(budgetEdited);
  useEffect(() => {
    budgetEditedRef.current = budgetEdited;
  }, [budgetEdited]);
  // TS-175: an open edit box counts only once something in it has changed.
  const editingVendor = vendors.find((v) => v.id === editingId);
  const editChanged =
    !!editingVendor &&
    (editCostText !== centsToDollarsString(editingVendor.costCents) ||
      (Object.keys(editVendor) as (keyof VendorDTO)[]).some((k) => (editVendor[k] ?? null) !== (editingVendor[k] ?? null)));
  // TS-182: only while the forms are there (they're hidden without Edit access).
  useUnsavedChanges(
    "budget",
    canEdit && !!(name.trim() || contactName.trim() || contactEmail.trim() || contactPhone.trim() || cost || contractNotes.trim() || arrivalTime || editChanged || budgetEdited)
  );
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    (async () => {
      try {
        const [vendorsRes, summaryRes] = await Promise.all([
          api.get<{ vendors: VendorDTO[] }>(`/api/v1/weddings/${weddingId}/vendors`),
          api.get<{ summary: BudgetSummaryDTO }>(`/api/v1/weddings/${weddingId}/budget`),
        ]);
        // TS-180: in the same order the list keeps after every change (see sortVendors).
        setVendors(sortVendors(vendorsRes.vendors));
        setSummary(summaryRes.summary);
        setBudgetInput(centsToDollarsString(summaryRes.summary.budgetCents));
      } catch {
        setError("Couldn't load budget & vendor info.");
      } finally {
        setLoading(false);
      }
    })();
    // TS-180: loaded again when access changes -- someone promoted from View to Edit had vendors
    // loaded without their contract notes, and saving an edit then wiped the notes.
  }, [weddingId, canEdit]);

  useEffect(() => {
    if (!canEdit) return;
    // Suggestions are a convenience: if they can't load, the form works exactly as before.
    api
      .get<{ suggestions: VendorSuggestionDTO[] }>(
        `/api/v1/vendor-suggestions?excludeWeddingId=${encodeURIComponent(weddingId)}`
      )
      .then((res) => setSuggestions(res.suggestions))
      .catch(() => setSuggestions([]));
  }, [weddingId, canEdit]);

  const matchingSuggestions = matchVendorSuggestions(
    suggestions,
    name,
    vendors.map((v) => v.name)
  );

  // TS-97: fills in what carries over from another wedding. Cost, contract notes and arrival time
  // are this wedding's own, so they're left exactly as they are.
  function pickSuggestion(s: VendorSuggestionDTO) {
    setName(s.name);
    setCategory(s.category);
    setCategoryOther(s.categoryOther ?? "");
    setContactName(s.contactName ?? "");
    setContactEmail(s.contactEmail ?? "");
    setContactPhone(s.contactPhone ?? "");
    setPickedSuggestion(s.name);
  }

  // TS-166: the totals are refreshed after a vendor change on their own -- if only this refresh
  // fails, the change itself still worked. It used to share the save's error handling, so a
  // vendor that was added showed "Couldn't add" (and the form stayed filled, inviting a
  // duplicate), and a vendor that was removed was put back on screen.
  async function refreshSummary() {
    try {
      const { summary: updated } = await api.get<{ summary: BudgetSummaryDTO }>(
        `/api/v1/weddings/${weddingId}/budget`
      );
      // TS-170: the totals always come in fresh. The budget figure (and the version it's based on)
      // only does when the planner isn't in the middle of typing a new one -- otherwise a
      // collaborator's newer figure would quietly become the base for this planner's save, and
      // the conflict check that protects it (TS-92) would never fire.
      setSummary((cur) =>
        cur && budgetEditedRef.current ? { ...updated, budgetCents: cur.budgetCents, budgetRevision: cur.budgetRevision } : updated
      );
      if (!budgetEditedRef.current) setBudgetInput(centsToDollarsString(updated.budgetCents));
    } catch {
      setError("Saved — but the budget totals couldn't be refreshed. Reload the page to see them.");
    }
  }

  async function onSaveBudget(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    const problem = amountProblem(budgetInput, "The budget");
    if (problem) return setError(problem);
    setSavingBudget(true);
    try {
      const { summary: updated } = await api.patch<{ summary: BudgetSummaryDTO }>(
        `/api/v1/weddings/${weddingId}/budget`,
        // TS-92: the version this figure is based on -- a stale one is refused, never overwrites.
        { budgetCents: dollarsStringToCents(budgetInput), expectedRevision: summary?.budgetRevision }
      );
      setSummary(updated);
      setBudgetInput(centsToDollarsString(updated.budgetCents));
    } catch (err) {
      // TS-92: someone else changed the budget first -- show their figure in the box, so the
      // number on screen is what's actually on record.
      const fresh = err instanceof ApiError && err.status === 409 ? (err.data?.summary as BudgetSummaryDTO | undefined) : undefined;
      if (fresh) {
        setSummary(fresh);
        setBudgetInput(centsToDollarsString(fresh.budgetCents));
      }
      setError(err instanceof ApiError ? err.message : "Couldn't save that budget figure.");
    } finally {
      setSavingBudget(false);
    }
  }

  async function onAdd(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    const problem = amountProblem(cost, "Cost");
    if (problem) return setError(problem);
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
        arrivalTime: arrivalTime || null,
      });
      setVendors((cur) => sortVendors([...cur, vendor]));
      setName("");
      setCategory("CATERING");
      setCategoryOther("");
      setContactName("");
      setContactEmail("");
      setContactPhone("");
      setCost("");
      setContractNotes("");
      setArrivalTime("");
      setPickedSuggestion(null);
      await refreshSummary();
    } catch (err) {
      setError(apiErrorMessage(err, ["name", "categoryOther", "contactEmail", "costCents", "arrivalTime", "contractNotes"], "Couldn't add that vendor."));
    } finally {
      setAdding(false);
    }
  }

  function startEdit(vendor: VendorDTO) {
    // TS-182: opening another vendor used to throw away a changed open edit without a word.
    if (editChanged && editingId !== vendor.id) {
      setError(OPEN_EDIT_MESSAGE);
      return;
    }
    setEditingId(vendor.id);
    setEditVendor({ ...vendor });
    setEditCostText(centsToDollarsString(vendor.costCents));
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
    setError(null);
    const problem = amountProblem(editCostText, "Cost");
    if (problem) return setError(problem);
    setSaving(true);
    const loaded = vendors.find((v) => v.id === vendorId);
    const expectedRevision = loaded?.revision;
    // TS-180: only what was changed in the edit box is sent, so a field this person never touched
    // (or never saw -- contract notes are hidden from View access) can't be overwritten by a save.
    const edited: Record<string, unknown> = {
      name: editVendor.name,
      category: editVendor.category,
      categoryOther: editVendor.category === "OTHER" ? editVendor.categoryOther || "" : null,
      contactName: editVendor.contactName ?? null,
      contactEmail: editVendor.contactEmail ?? null,
      contactPhone: editVendor.contactPhone ?? null,
      costCents: dollarsStringToCents(editCostText),
      contractNotes: editVendor.contractNotes ?? null,
      arrivalTime: editVendor.arrivalTime ?? null,
    };
    const changes = Object.fromEntries(
      Object.entries(edited).filter(([key, value]) => !loaded || (loaded[key as keyof VendorDTO] ?? null) !== (value ?? null))
    );
    // A category change always carries its label (or its clearing), which the server checks together.
    if ("category" in changes || "categoryOther" in changes) {
      changes.category = edited.category;
      changes.categoryOther = edited.categoryOther;
    }
    try {
      const { vendor } = await api.patch<{ vendor: VendorDTO }>(
        `/api/v1/weddings/${weddingId}/vendors/${vendorId}`,
        { ...changes, expectedRevision }
      );
      setVendors((cur) => sortVendors(cur.map((v) => (v.id === vendorId ? vendor : v))));
      setEditingId(null);
      await refreshSummary();
    } catch (err) {
      const fresh = conflictVendor(err);
      if (fresh) {
        setVendors((cur) => cur.map((v) => (v.id === vendorId ? fresh : v)));
        // TS-175: close the editor, as Timeline does. It used to stay open with the old values,
        // and a second Save then wrote them over the other person's change.
        setEditingId(null);
        setError(`"${fresh.name}" changed since you loaded it (maybe in another tab, or by someone else) — showing the latest. Try again if you still want to make this change.`);
      } else {
        // TS-151: say which field was refused, not just "Validation failed".
        setError(apiErrorMessage(err, ["name", "categoryOther", "contactEmail", "costCents", "arrivalTime", "contractNotes"], "Couldn't save that vendor."));
      }
    } finally {
      setSaving(false);
    }
  }

  // TS-114: get (or, with regenerate, replace) a vendor's private read-only link and copy it.
  async function onShareLink(vendorId: string, regenerate: boolean) {
    setError(null);
    setShareBusy(vendorId);
    try {
      const { link } = await api.post<{ link: VendorShareLinkDTO }>(
        `/api/v1/weddings/${weddingId}/vendors/${vendorId}/share-link`,
        { regenerate }
      );
      setVendors((current) => current.map((v) => (v.id === vendorId ? { ...v, shareLinkActive: true } : v)));
      let copied = false;
      try {
        await navigator.clipboard.writeText(link.url);
        copied = true;
      } catch {
        // No clipboard (e.g. an insecure context) -- show the link so it can be copied by hand.
      }
      setShareResult((r) => ({
        ...r,
        [vendorId]: `${regenerate ? "New link — the old one no longer works. " : ""}${copied ? "Link copied: " : ""}${link.url}`,
      }));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't get that vendor's link.");
    } finally {
      setShareBusy(null);
    }
  }

  async function onTurnOffLink(vendorId: string) {
    setError(null);
    try {
      await api.delete(`/api/v1/weddings/${weddingId}/vendors/${vendorId}/share-link`);
      setVendors((current) => current.map((v) => (v.id === vendorId ? { ...v, shareLinkActive: false } : v)));
      setShareResult((r) => ({ ...r, [vendorId]: "Link turned off — it no longer works." }));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't turn off that link.");
    }
  }

  async function onRemove(id: string) {
    const removed = vendors.find((v) => v.id === id);
    setVendors((cur) => cur.filter((v) => v.id !== id));
    try {
      await api.delete(`/api/v1/weddings/${weddingId}/vendors/${id}`);
    } catch {
      // Put just this vendor back (not an older copy of the whole list).
      if (removed) setVendors((cur) => sortVendors([...cur, removed]));
      setError("Couldn't remove that vendor.");
      return;
    }
    await refreshSummary();
  }

  if (loading) return <p className="text-sm text-neutral-500 dark:text-neutral-400">Loading budget & vendors...</p>;

  const overBudget = summary?.remainingCents !== null && summary?.remainingCents !== undefined && summary.remainingCents < 0;

  return (
    <div>
      {!canEdit && (
        <p className="mb-4 rounded-md bg-neutral-100 dark:bg-neutral-800 px-3 py-2 text-sm text-neutral-600 dark:text-neutral-300">
          You have view-only access to this wedding&apos;s budget — adding, editing, and removing
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
                // TS-175: a text box, not a number box -- a number box reports "1,500" as empty.
                type="text"
                inputMode="decimal"
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
                onChange={(e) => {
                  setName(e.target.value);
                  setPickedSuggestion(null);
                }}
                autoComplete="off"
                required
              />
              {matchingSuggestions.length > 0 && (
                <div className="mt-1 rounded-md border border-neutral-200 dark:border-neutral-700 p-1">
                  <p id="vendor-suggestions-label" className="px-2 py-1 text-xs text-neutral-500 dark:text-neutral-400">
                    From your other weddings
                  </p>
                  <ul aria-labelledby="vendor-suggestions-label">
                    {matchingSuggestions.map((s) => (
                      <li key={s.name}>
                        <button
                          type="button"
                          onClick={() => pickSuggestion(s)}
                          aria-label={`Use ${s.name} from your other weddings`}
                          className="w-full rounded px-2 py-1 text-left text-sm hover:bg-neutral-100 dark:hover:bg-neutral-800"
                        >
                          {s.name}{" "}
                          <span className="text-xs text-neutral-500 dark:text-neutral-400">
                            · {s.category === "OTHER" && s.categoryOther ? s.categoryOther : CATEGORY_LABEL[s.category]}
                          </span>
                        </button>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              {pickedSuggestion && (
                <p role="status" className="mt-1 text-xs text-neutral-500 dark:text-neutral-400">
                  Filled in {pickedSuggestion}&apos;s details from your other weddings. Add this wedding&apos;s cost and
                  contract details below.
                </p>
              )}
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
                type="text"
                inputMode="decimal"
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
            <div>
              <label htmlFor="vendor-arrival-time" className="mb-1 block text-sm font-medium">
                Arrival time on the day (optional)
              </label>
              <input
                id="vendor-arrival-time"
                type="time"
                className="w-full rounded-md border border-neutral-300 dark:border-neutral-600 px-3 py-2 text-sm"
                value={arrivalTime}
                onChange={(e) => setArrivalTime(e.target.value)}
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

      {error && <p role="alert" className="mb-4 text-sm text-red-600 dark:text-red-400">{error}</p>}

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
                      aria-label="Edit arrival time"
                      type="time"
                      className="rounded-md border border-neutral-300 dark:border-neutral-600 px-2 py-1 text-sm"
                      value={editVendor.arrivalTime ?? ""}
                      onChange={(e) => setEditVendor({ ...editVendor, arrivalTime: e.target.value || null })}
                    />
                    <input
                      aria-label="Edit cost"
                      type="text"
                      inputMode="decimal"
                      placeholder="Cost ($)"
                      className="rounded-md border border-neutral-300 dark:border-neutral-600 px-2 py-1 text-sm"
                      value={editCostText}
                      onChange={(e) => setEditCostText(e.target.value)}
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
                    {v.arrivalTime && (
                      <p className="text-sm text-neutral-500 dark:text-neutral-400">Arrives {formatClockTime(v.arrivalTime)}</p>
                    )}
                    {v.contractNotes && <p className="mt-1 whitespace-pre-line text-sm text-neutral-500 dark:text-neutral-400">{v.contractNotes}</p>}
                    {shareResult[v.id] && (
                      <p className="mt-1 break-all text-xs text-neutral-500 dark:text-neutral-400">{shareResult[v.id]}</p>
                    )}
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-medium">{v.costCents === null ? "No cost set" : formatCents(v.costCents)}</span>
                    {canEdit && (
                      <>
                        {/* TS-114: the vendor's private read-only link (timeline, their details, other
                            vendors' names and arrival times -- never costs or notes). */}
                        <button
                          onClick={() => onShareLink(v.id, false)}
                          disabled={shareBusy === v.id}
                          aria-label={`Share link for ${v.name}`}
                          title="Copies a private link to a read-only page for this vendor: the timeline, their details, and the other vendors' arrival times. Never costs or notes."
                          className="rounded-md border border-neutral-300 dark:border-neutral-600 px-2 py-1 text-sm hover:bg-neutral-50 dark:hover:bg-neutral-800 disabled:opacity-50"
                        >
                          Share link
                        </button>
                        {v.shareLinkActive && (
                          <>
                            <button
                              onClick={() => onShareLink(v.id, true)}
                              disabled={shareBusy === v.id}
                              aria-label={`New link for ${v.name}`}
                              title="Makes a new link; the old one stops working."
                              className="rounded-md border border-neutral-300 dark:border-neutral-600 px-2 py-1 text-sm hover:bg-neutral-50 dark:hover:bg-neutral-800 disabled:opacity-50"
                            >
                              New link
                            </button>
                            <ConfirmDeleteButton
                              label="Turn off link"
                              ariaLabel={`Turn off the link for ${v.name}`}
                              question={`Turn off ${v.name}'s link? It stops working right away. You can make a new one later.`}
                              confirmLabel="Yes, turn it off"
                              onConfirm={() => onTurnOffLink(v.id)}
                            />
                          </>
                        )}
                        <button
                          onClick={() => startEdit(v)}
                          // TS-175: says which vendor, for screen readers.
                          aria-label={`Edit ${v.name}`}
                          className="rounded-md border border-neutral-300 dark:border-neutral-600 px-2 py-1 text-sm hover:bg-neutral-50 dark:hover:bg-neutral-800"
                        >
                          Edit
                        </button>
                        <ConfirmDeleteButton
                          ariaLabel={`Remove ${v.name}`}
                          question={`Remove ${v.name} and everything recorded for them, such as cost and contract notes? This can't be undone.`}
                          confirmLabel="Yes, remove vendor"
                          onConfirm={() => onRemove(v.id)}
                        />
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
