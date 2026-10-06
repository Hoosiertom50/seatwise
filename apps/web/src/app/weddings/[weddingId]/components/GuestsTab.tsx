"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { ConfirmDeleteButton } from "@/components/ConfirmDeleteButton";
import { api, ApiError, apiErrorMessage } from "@/lib/api-client";
import { formatMomentDate } from "@/lib/display-format";
import type {
  AgeCategory,
  GuestDTO,
  GuestImportField,
  GuestImportPreview,
  GuestSide,
  GuestTier,
  RsvpStatus,
  WeddingDTO,
} from "@seatwise/shared";
import {
  formatGuestCounts,
  parseCsv,
  toCsv,
  CsvParseError,
  findDuplicateCsvHeader,
  duplicateCsvHeaderMessage,
  decodeCsvBytes,
  CsvEncodingError,
  GUEST_TIER_LABELS,
  RSVP_STATUS_LABELS,
} from "@seatwise/shared";
import { useUnsavedChanges, useUnsavedFields } from "@/lib/unsaved-changes";
// TS-193: the same limits the server checks (packages/shared/src/field-limits.ts).
import { FIELD_LIMITS } from "@seatwise/shared";

const TIERS: GuestTier[] = ["VIP", "FAMILY", "FRIEND", "PLUS_ONE", "OTHER"];
const RSVP_STATUSES: RsvpStatus[] = ["PENDING", "CONFIRMED", "DECLINED"];
// FR-3.7: lets a Purpose table's Age Category criterion (e.g. "Kids' Table") mean something --
// always just a soft-preference input for generation, never a hard rule of its own.
const AGE_CATEGORIES: AgeCategory[] = ["ADULT", "CHILD", "INFANT"];

// FR-2.4: which guest fields a column can map to, and how each is labeled in the mapping form.
// firstName/lastName are the only two that must be mapped before a preview can be requested.
// FR-1.3a: the "side" field's label uses this wedding's own side names rather than a hardcoded
// "Bride"/"Groom" -- everything else is fixed.
// TS-143: what the server reports after emailing a guest their RSVP link automatically.
interface RsvpEmailOutcome {
  emailed: boolean;
  emailFailed: boolean;
  // TS-156
  emailLimited?: boolean;
  // TS-177
  emailLimitedToday?: boolean;
  rsvpClosed?: boolean;
  // TS-164
  confirmEmailFirst?: boolean;
  // TS-171
  recentlyEmailed?: boolean;
  recipientLimited?: boolean;
}

// TS-156: shown when the planner has hit their email limit. TS-177: says which one -- the
// account's daily allowance (every kind of email together) or the hourly limit on RSVP emails.
function emailLimitedNote(outcome: RsvpEmailOutcome): string {
  return outcome.emailLimitedToday
    ? "You've reached today's email limit for your account, so this one wasn't sent"
    : "You've sent a lot of emails in the last hour, so this one wasn't sent";
}
// TS-177 (Tom's decision): after the RSVP cutoff, Seatwise doesn't email the link.
const RSVP_CLOSED_NOTE =
  "RSVPs have closed, so this guest wasn't emailed — use \"RSVP link\" to copy it if you still want to send it.";
// TS-171: this address has already had its share of Seatwise email today.
const RECIPIENT_LIMITED_NOTE = "This address has already had several emails from Seatwise today, so this one wasn't sent";
// TS-164
const CONFIRM_EMAIL_NOTE = "Not emailed — confirm your own email address first (see the note at the top of the page)";

function buildImportFields(
  sideLabel1: string,
  sideLabel2: string
): { field: GuestImportField; label: string; required?: boolean }[] {
  return [
    { field: "guestId", label: "Guest ID (to update an existing guest)" },
    { field: "firstName", label: "First name", required: true },
    { field: "lastName", label: "Last name", required: true },
    { field: "partyName", label: "Party / household" },
    { field: "headcount", label: "Headcount" },
    { field: "tier", label: "Tier" },
    { field: "rsvpStatus", label: "RSVP status" },
    { field: "requiresAccessibleTable", label: "Requires accessible table (yes/no)" },
    { field: "dayOfAttendance", label: "Attendance (Attending/Not Attending)" },
    { field: "side", label: `Side (${sideLabel1}/${sideLabel2}/Both)` },
    { field: "ageCategory", label: "Age category (Adult/Child/Infant)" },
    { field: "notes", label: "Notes" },
    // TS-180: the export's last two columns.
    { field: "plusOneNames", label: "Plus-ones" },
    { field: "version", label: "Version (from an export)" },
  ];
}

// FR-2.4: a small always-visible sample so a first-time importer can see what a clean file looks
// like without trial-and-erroring the mapping step. Column order/exact header names never matter
// (see the mapping UI below) -- this is just one example shape, not a required template.
function buildImportExample(
  sideLabel1: string,
  sideLabel2: string
): { headers: string[]; rows: string[][] } {
  return {
    headers: [
      "First Name",
      "Last Name",
      "Party / Household",
      "Headcount",
      "Tier",
      "RSVP Status",
      "Accessible Table?",
      "Attendance",
      "Side",
      "Age Category",
      "Notes",
    ],
    rows: [
      ["Amy", "Adams", "The Adams Family", "2", "VIP", "Confirmed", "No", "Attending", sideLabel1, "Adult", ""],
      ["Ben", "Baker", "", "1", "Friend", "Pending", "No", "Attending", "Both", "Adult", "Vegetarian"],
      ["Cora", "Chen", "", "1", "Family", "Confirmed", "Yes", "Attending", sideLabel2, "Adult", ""],
    ],
  };
}

export function GuestsTab({
  weddingId,
  wedding,
  guests,
  setGuests,
  canEdit,
}: {
  weddingId: string;
  wedding: WeddingDTO | null;
  guests: GuestDTO[];
  setGuests: React.Dispatch<React.SetStateAction<GuestDTO[]>>;
  canEdit: boolean;
}) {
  const sideLabel1 = wedding?.sideLabel1 ?? "Bride";
  const sideLabel2 = wedding?.sideLabel2 ?? "Groom";
  // FR-1.3a: BRIDE/GROOM/BOTH are the stored values everywhere -- these are only the labels
  // shown for them, so renaming a side never touches which value a guest is actually stored
  // against.
  const SIDE_OPTIONS: { value: GuestSide; label: string }[] = [
    { value: "BRIDE", label: sideLabel1 },
    { value: "GROOM", label: sideLabel2 },
    { value: "BOTH", label: "Both" },
  ];
  const sideLabelFor = (value: GuestSide) => SIDE_OPTIONS.find((o) => o.value === value)?.label ?? value;
  const IMPORT_FIELDS = buildImportFields(sideLabel1, sideLabel2);
  const IMPORT_EXAMPLE = buildImportExample(sideLabel1, sideLabel2);

  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");
  const [partyName, setPartyName] = useState("");
  // TS-112: the add-guest form's optional fields start collapsed.
  const [showMoreDetails, setShowMoreDetails] = useState(false);
  // TS-182: kept as typed, so clearing the box to type a new number doesn't show 0.
  const [headcount, setHeadcount] = useState("1");
  const [tier, setTier] = useState<GuestTier>("OTHER");
  const [rsvpStatus, setRsvpStatus] = useState<RsvpStatus>("PENDING");
  const [requiresAccessibleTable, setRequiresAccessibleTable] = useState(false);
  const [side, setSide] = useState<GuestSide>("BOTH");
  const [ageCategory, setAgeCategory] = useState<AgeCategory>("ADULT");
  // TS-17 (FR-12.4): optional -- lets a planner send/resend this guest their own RSVP link later.
  const [email, setEmail] = useState("");
  const [notes, setNotes] = useState("");
  const [adding, setAdding] = useState(false);
  // TS-175: the guest a message is about, when it's about one -- it's then shown in that guest's
  // row (and announced), not at the top of a long list where it went unseen.
  // TS-182: the message and its guest are kept together, so a save on one guest can clear just
  // that guest's message (it used to clear another guest's error too).
  const [errorState, setErrorState] = useState<{ message: string; guestId: string | null } | null>(null);
  const error = errorState?.message ?? null;
  const errorGuestId = errorState?.guestId ?? null;
  const setError = useCallback((message: string | null) => {
    setErrorState(message === null ? null : { message, guestId: null });
  }, []);
  const setRowError = useCallback((guestId: string, message: string) => {
    setErrorState({ message, guestId });
  }, []);
  const clearRowError = useCallback((guestId: string) => {
    setErrorState((cur) => (cur?.guestId === guestId ? null : cur));
  }, []);
  // TS-182: the row fields save when you leave them; while one is half-typed, the page asks before
  // a reload, close or Back, like it does for the forms.
  const rowFields = useUnsavedFields();
  useEffect(() => {
    if (!canEdit) rowFields.clearAll();
  }, [canEdit, rowFields]);
  // TS-151: what a save changed elsewhere (e.g. a guest flagged Needs Reassignment).
  const [warning, setWarning] = useState<string | null>(null);
  // TS-17 (FR-12.4): which guest's RSVP-link action is in flight, and the last result shown for
  // that guest (a copy-to-clipboard confirmation or "emailed to ...") -- keyed by guestId so
  // multiple rows can each show their own status independently.
  // TS-182: a set, so getting one guest's link doesn't re-enable another guest's buttons mid-request.
  const [rsvpLinkBusy, setRsvpLinkBusy] = useState<ReadonlySet<string>>(new Set());
  const [rsvpLinkResult, setRsvpLinkResult] = useState<Record<string, string>>({});

  // FR-2.4/2.4a: bulk import. CSV headers are parsed client-side the moment a file is chosen (so
  // the mapping dropdowns can be shown immediately); the raw CSV text plus the confirmed mapping
  // are what actually get sent to the server for preview and, later, commit.
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [csvText, setCsvText] = useState<string | null>(null);
  const [csvFileName, setCsvFileName] = useState<string | null>(null);
  const [csvHeaders, setCsvHeaders] = useState<string[]>([]);
  const [mapping, setMapping] = useState<Partial<Record<GuestImportField, string>>>({});
  const [importPreview, setImportPreview] = useState<GuestImportPreview | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [committing, setCommitting] = useState(false);
  const [importError, setImportError] = useState<string | null>(null);
  // TS-159: tell the page this tab has input that leaving it would lose.
  // TS-175: only while the form is there -- once access drops to View it's hidden, and its leftover
  // text used to keep the page asking "you have unsaved changes".
  useUnsavedChanges("guests", canEdit && !!(firstName.trim() || lastName.trim() || partyName.trim() || email.trim() || notes.trim() || csvText));
  const [importResult, setImportResult] = useState<{
    createdCount: number;
    updatedCount: number;
    skippedCount?: number;
    unchangedCount?: number;
    warnings: string[];
  } | null>(null);
  // TS-180: the planner chose to overwrite guests changed in Seatwise since the file was exported.
  const [overwriteChanged, setOverwriteChanged] = useState(false);
  const [showImportExample, setShowImportExample] = useState(false);

  function onDownloadImportExample() {
    const csv = toCsv(IMPORT_EXAMPLE.headers, IMPORT_EXAMPLE.rows);
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "seatwise-guest-import-example.csv";
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  // TS-191: each preview request gets a number; an answer that comes back after the file, the
  // column choices or Cancel changed things is dropped (it used to show a preview of the old
  // choices, which the import then used).
  const previewRequest = useRef(0);
  function invalidatePreview() {
    previewRequest.current++;
    setPreviewing(false);
  }

  function resetImport() {
    invalidatePreview();
    setCsvText(null);
    setCsvFileName(null);
    setCsvHeaders([]);
    setMapping({});
    setImportPreview(null);
    setImportError(null);
    setOverwriteChanged(false);
    if (fileInputRef.current) fileInputRef.current.value = "";
  }

  async function onFileSelected(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setImportError(null);
    setImportResult(null);
    setImportPreview(null);
    // TS-191: the previous file is gone the moment another is chosen -- if the new one is refused
    // below, the old file's columns and choices used to stay on screen, ready to import.
    invalidatePreview();
    setCsvText(null);
    setCsvFileName(null);
    setCsvHeaders([]);
    setMapping({});
    setOverwriteChanged(false);
    try {
      // TS-190: read as UTF-8, or as Excel's older Windows encoding when it isn't (see decodeCsvBytes).
      // TS-198: or as UTF-16 when it starts with that byte-order mark; a file in the older Mac
      // encoding is refused (CsvEncodingError). And a file holding the "couldn't read this
      // character" mark is no longer refused here as a whole -- the preview shows the rows whose
      // imported cells hold it (a guest's own RSVP note in the export used to block the file).
      const text = decodeCsvBytes(await file.arrayBuffer());
      const { headers } = parseCsv(text);
      if (headers.length === 0) {
        setImportError("Couldn't find a header row in that file.");
        return;
      }
      // TS-180: two columns with one name can't be told apart in the column pickers below.
      const duplicate = findDuplicateCsvHeader(headers);
      if (duplicate !== null) {
        setImportError(duplicateCsvHeaderMessage(duplicate));
        return;
      }
      setCsvText(text);
      setCsvFileName(file.name);
      setCsvHeaders(headers);
      // Best-effort auto-mapping: a column whose header matches a field name/label loosely.
      const guess: Partial<Record<GuestImportField, string>> = {};
      // TS-175: the label is cut at "(" before it's normalized (it was normalized first, so the "("
      // was already gone and labels like "Attendance (Attending/Not Attending)" never matched), and
      // a few everyday names are accepted too -- the example file's own "Accessible Table?" and
      // "Attendance" columns weren't picked up.
      const squash = (text: string) => text.toLowerCase().replace(/[^a-z]/g, "");
      const aliases: Partial<Record<GuestImportField, string[]>> = {
        requiresAccessibleTable: ["accessibletable", "accessible"],
        dayOfAttendance: ["attendance"],
        partyName: ["partyhousehold", "party", "household"],
      };
      for (const { field, label } of IMPORT_FIELDS) {
        const names = [squash(field), squash(label.split("(")[0]), ...(aliases[field] ?? [])];
        const match = headers.find((h) => names.includes(squash(h)));
        if (match) guess[field] = match;
      }
      setMapping(guess);
    } catch (err) {
      // TS-180: e.g. a quote that never closes -- say what's wrong with the file.
      setImportError(
        err instanceof CsvParseError || err instanceof CsvEncodingError ? err.message : "Couldn't read that file."
      );
    }
  }

  function onMappingChange(field: GuestImportField, header: string) {
    setMapping((prev) => {
      const next = { ...prev };
      if (header === "") delete next[field];
      else next[field] = header;
      return next;
    });
    setImportPreview(null);
    invalidatePreview();
  }

  function cleanMapping(): Partial<Record<GuestImportField, string>> {
    const cleaned: Partial<Record<GuestImportField, string>> = {};
    for (const [field, header] of Object.entries(mapping)) {
      if (header) cleaned[field as GuestImportField] = header;
    }
    return cleaned;
  }

  async function onRequestPreview() {
    if (!csvText) return;
    setImportError(null);
    setImportResult(null);
    setOverwriteChanged(false);
    setPreviewing(true);
    const request = ++previewRequest.current;
    try {
      const { preview } = await api.post<{ preview: GuestImportPreview }>(
        `/api/v1/weddings/${weddingId}/guests/import/preview`,
        { csv: csvText, mapping: cleanMapping() }
      );
      if (request !== previewRequest.current) return;
      setImportPreview(preview);
    } catch (err) {
      if (request !== previewRequest.current) return;
      setImportError(err instanceof ApiError ? err.message : "Couldn't preview that file.");
    } finally {
      // A newer request (or Cancel) owns the busy state from here.
      if (request === previewRequest.current) setPreviewing(false);
    }
  }

  async function onConfirmImport() {
    if (!csvText) return;
    setImportError(null);
    setCommitting(true);
    try {
      const { result, guests: updatedGuests } = await api.post<{
        result: { createdCount: number; updatedCount: number; skippedCount?: number; unchangedCount?: number; warnings: string[] };
        guests: GuestDTO[];
      }>(`/api/v1/weddings/${weddingId}/guests/import/commit`, {
        csv: csvText,
        mapping: cleanMapping(),
        // TS-92: the versions this preview showed, so the import is refused rather than silently
        // overwriting a guest someone else edited in the meantime. TS-180: including guests changed
        // since the export, when the planner chose to overwrite them.
        expectedRevisions: Object.fromEntries(
          (importPreview?.rows ?? [])
            .filter(
              (r) =>
                // TS-190: and the guests it showed as unchanged.
                (r.kind === "update" || r.kind === "unchanged" || (r.kind === "conflict" && overwriteChanged)) &&
                r.guestId &&
                r.revision !== undefined
            )
            .map((r) => [r.guestId!, r.revision!])
        ),
        overwriteChanged,
      });
      setGuests(updatedGuests.sort((a, b) => a.lastName.localeCompare(b.lastName)));
      setImportResult(result);
      resetImport();
    } catch (err) {
      setImportError(err instanceof ApiError ? err.message : "Couldn't complete that import.");
    } finally {
      setCommitting(false);
    }
  }

  async function onAddGuest(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setAdding(true);
    try {
      const { guest, rsvpEmail, warnings } = await api.post<{ guest: GuestDTO; rsvpEmail?: RsvpEmailOutcome; warnings?: string[] }>(`/api/v1/weddings/${weddingId}/guests`, {
        firstName,
        lastName,
        partyName: partyName || null,
        // TS-182: a box left empty means the usual one.
        headcount: headcount.trim() === "" ? 1 : Number(headcount),
        tier,
        rsvpStatus,
        requiresAccessibleTable,
        side,
        ageCategory,
        email: email || null,
        notes: notes.trim() || null,
      });
      // TS-166: built from the list as it is now, so another change made meanwhile isn't lost.
      setGuests((cur) => [...cur, guest].sort((a, b) => a.lastName.localeCompare(b.lastName)));
      // TS-143: a guest added with an email was just sent their RSVP link -- say so on their row.
      if (rsvpEmail && guest.email) showAutoRsvpResult(guest.id, guest.email, rsvpEmail);
      // TS-177: e.g. the guest was saved but the plan couldn't be re-checked just then.
      setWarning(warnings?.length ? warnings.join(" ") : null);
      setFirstName("");
      setLastName("");
      setPartyName("");
      setHeadcount("1");
      setTier("OTHER");
      setRsvpStatus("PENDING");
      setRequiresAccessibleTable(false);
      setSide("BOTH");
      setAgeCategory("ADULT");
      setEmail("");
      setNotes("");
    } catch (err) {
      setError(apiErrorMessage(err, ["firstName", "lastName"], "Couldn't add that guest."));
    } finally {
      setAdding(false);
    }
  }

  async function onDeleteGuest(guestId: string) {
    const removed = guests.find((g) => g.id === guestId);
    // TS-182: a removed guest's half-typed fields are gone with their row.
    for (const field of ["firstName", "lastName", "notes", "email"]) rowFields.markDirty(`guest-row-${guestId}-${field}`, false);
    setGuests((cur) => cur.filter((g) => g.id !== guestId));
    try {
      await api.delete(`/api/v1/weddings/${weddingId}/guests/${guestId}`);
    } catch {
      // TS-166: put back just this guest, not an older copy of the whole list.
      if (removed) setGuests((cur) => [...cur, removed].sort((a, b) => a.lastName.localeCompare(b.lastName)));
      setError("Couldn't delete that guest.");
    }
  }

  // FR-7.7, extended to guests: a 409 conflict carries the fresh, currently-committed guest
  // alongside the message -- pulling it out lets every edit handler refresh that one row in one
  // step instead of a second round-trip, and shows the user the latest instead of a bare error.
  function conflictGuest(err: unknown): GuestDTO | null {
    if (err instanceof ApiError && err.status === 409 && err.data?.guest) {
      return err.data.guest as GuestDTO;
    }
    return null;
  }

  // TS-151: one save at a time per guest, each sent with the newest revision the server has
  // confirmed, and each result applied to just that guest's row of the *current* list. Before,
  // every handler rebuilt the whole list from a snapshot taken when it started (undoing any other
  // row changed meanwhile), and two quick edits to one guest sent the same revision, so the second
  // got a false "edited elsewhere" and was dropped.
  const guestsNow = useRef(guests);
  // TS-176: kept current after each render (not during it); the save handlers read it later.
  useEffect(() => {
    guestsNow.current = guests;
  }, [guests]);
  const confirmedRevision = useRef(new Map<string, number>());
  const saveChain = useRef(new Map<string, Promise<unknown>>());

  function revisionFor(guestId: string): number | undefined {
    const listed = guestsNow.current.find((g) => g.id === guestId)?.revision;
    const confirmed = confirmedRevision.current.get(guestId);
    if (listed === undefined || confirmed === undefined) return listed ?? confirmed;
    return Math.max(listed, confirmed);
  }
  function putGuest(guest: GuestDTO) {
    confirmedRevision.current.set(guest.id, guest.revision);
    setGuests((cur) => cur.map((g) => (g.id === guest.id ? guest : g)));
  }
  function patchRow(guestId: string, changes: Partial<GuestDTO>) {
    setGuests((cur) => cur.map((g) => (g.id === guestId ? { ...g, ...changes } : g)));
  }
  type GuestSaveResult = { guest: GuestDTO; rsvpEmail?: RsvpEmailOutcome; warnings?: string[] };
  function saveGuest(guestId: string, changes: Record<string, unknown>): Promise<GuestSaveResult> {
    const run = async () => {
      const result = await api.patch<GuestSaveResult>(`/api/v1/weddings/${weddingId}/guests/${guestId}`, {
        ...changes,
        expectedRevision: revisionFor(guestId),
      });
      putGuest(result.guest);
      // TS-166: a save that works clears an earlier save's error, which used to stay up for good.
      // TS-182: only this guest's own error -- not a message about someone else.
      clearRowError(guestId);
      // TS-151: say when the change knocked the guest out of their seat.
      setWarning(result.warnings?.length ? result.warnings.join(" ") : null);
      return result;
    };
    const next = (saveChain.current.get(guestId) ?? Promise.resolve()).catch(() => {}).then(run);
    saveChain.current.set(guestId, next);
    return next;
  }
  function showConflict(fresh: GuestDTO) {
    putGuest(fresh);
    setRowError(fresh.id, 
      `${fresh.firstName} ${fresh.lastName} changed since you loaded it (maybe in another tab, or by someone else) — showing the latest. Try again if you still want to make this change.`
    );
  }

  async function onUpdateRsvp(guestId: string, newStatus: RsvpStatus) {
    const before = guests.find((g) => g.id === guestId);
    patchRow(guestId, { rsvpStatus: newStatus });
    try {
      await saveGuest(guestId, { rsvpStatus: newStatus });
    } catch (err) {
      const fresh = conflictGuest(err);
      if (fresh) showConflict(fresh);
      else {
        if (before) patchRow(guestId, { rsvpStatus: before.rsvpStatus });
        setRowError(guestId, err instanceof ApiError ? err.message : "Couldn't update RSVP status.");
      }
    }
  }

  // FR-1.3a/FR-3.4: only the BRIDE/GROOM/BOTH value is ever written here -- this wedding's side
  // labels only affect how that value is displayed (see SIDE_OPTIONS above).
  async function onUpdateSide(guestId: string, newSide: GuestSide) {
    const before = guests.find((g) => g.id === guestId);
    patchRow(guestId, { side: newSide });
    try {
      await saveGuest(guestId, { side: newSide });
    } catch (err) {
      const fresh = conflictGuest(err);
      if (fresh) showConflict(fresh);
      else {
        if (before) patchRow(guestId, { side: before.side });
        setRowError(guestId, err instanceof ApiError ? err.message : "Couldn't update that guest's side.");
      }
    }
  }

  // TS-143: the line shown under a guest's row after their RSVP link was emailed automatically.
  function showAutoRsvpResult(guestId: string, email: string, outcome: RsvpEmailOutcome) {
    setRsvpLinkResult((prev) => ({
      ...prev,
      [guestId]: outcome.emailed
        ? `Emailed RSVP link to ${email}`
        : outcome.rsvpClosed
          ? RSVP_CLOSED_NOTE
          : outcome.confirmEmailFirst
          ? `${CONFIRM_EMAIL_NOTE} — or use "RSVP link" to copy it and send it yourself.`
          : outcome.emailLimited
          ? `${emailLimitedNote(outcome)} — use "RSVP link" later, or copy it and send it yourself.`
          : outcome.recipientLimited
          ? `${RECIPIENT_LIMITED_NOTE} — use "RSVP link" to copy it and send it yourself.`
          : outcome.recentlyEmailed
          ? `Already emailed the RSVP link to ${email} within the last hour.`
          : `Couldn't email ${email} — use "RSVP link" to copy it and send it yourself.`,
    }));
  }

  // TS-17 (FR-12.4): inline-editable per row, same optimistic-update-then-reconcile pattern as
  // the other per-guest edit handlers above. TS-93: uncontrolled like the name inputs (TS-108), so a
  // rejected edit writes the committed email back into the input itself.
  async function onUpdateEmail(guestId: string, input: HTMLInputElement) {
    const current = guests.find((g) => g.id === guestId);
    const normalized = input.value.trim() || null;
    patchRow(guestId, { email: normalized });
    try {
      const { guest, rsvpEmail } = await saveGuest(guestId, { email: normalized });
      // TS-143: giving a guest their first email sends their RSVP link.
      if (rsvpEmail && guest.email) showAutoRsvpResult(guest.id, guest.email, rsvpEmail);
    } catch (err) {
      const fresh = conflictGuest(err);
      if (fresh) {
        showConflict(fresh);
        input.value = fresh.email ?? "";
      } else {
        patchRow(guestId, { email: current?.email ?? null });
        input.value = current?.email ?? "";
        // TS-135: a 422's top-level message is just "Validation failed" -- show the field's own reason.
        setRowError(guestId, apiErrorMessage(err, ["email"], "Couldn't update that guest's email."));
      }
    }
  }

  // TS-129: the planner's private notes (dietary, accessibility, anything the team should know),
  // inline-editable like the email above and uncontrolled for the same reason (TS-108): every path
  // that doesn't keep the planner's text writes the committed note back into the textarea itself.
  async function onUpdateNotes(guestId: string, input: HTMLTextAreaElement) {
    const current = guests.find((g) => g.id === guestId);
    const normalized = input.value.trim() || null;
    if (!current || normalized === (current.notes ?? null)) return;
    patchRow(guestId, { notes: normalized });
    try {
      await saveGuest(guestId, { notes: normalized });
    } catch (err) {
      const fresh = conflictGuest(err);
      if (fresh) {
        showConflict(fresh);
        input.value = fresh.notes ?? "";
      } else {
        patchRow(guestId, { notes: current.notes });
        input.value = current.notes ?? "";
        setRowError(guestId, apiErrorMessage(err, ["notes"], "Couldn't update that guest's notes."));
      }
    }
  }

  // Inline name edit -- same optimistic-update-then-reconcile pattern as the other per-guest edit
  // handlers above (added after a planner flagged there was no way to fix a misspelled guest name
  // short of re-importing or deleting/re-adding; the API/DB already supported it, only the UI
  // didn't expose it). firstName/lastName are both required server-side (min length 1), so an
  // emptied-out field is never sent -- it just reverts to the last saved value on blur instead.
  // TS-108: the name inputs are uncontrolled (defaultValue), and React never pushes a changed
  // defaultValue into an already-mounted input -- so restoring state alone leaves the rejected
  // text on screen. Every path that doesn't keep the user's text writes the committed name back
  // into the input element itself.
  async function onUpdateName(guestId: string, field: "firstName" | "lastName", input: HTMLInputElement) {
    const trimmed = input.value.trim();
    const current = guests.find((g) => g.id === guestId);
    if (!current || trimmed === current[field]) return;
    if (trimmed === "") {
      setRowError(guestId, field === "firstName" ? "First name can't be blank." : "Last name can't be blank.");
      input.value = current[field];
      return;
    }
    patchRow(guestId, { [field]: trimmed });
    try {
      await saveGuest(guestId, { [field]: trimmed });
    } catch (err) {
      const fresh = conflictGuest(err);
      if (fresh) {
        showConflict(fresh);
        input.value = fresh[field];
      } else {
        patchRow(guestId, { [field]: current[field] });
        input.value = current[field];
        setRowError(guestId, 
          apiErrorMessage(
            err,
            [field],
            `Couldn't update that guest's ${field === "firstName" ? "first" : "last"} name.`
          )
        );
      }
    }
  }

  // TS-17 (FR-12.4): "get/copy" (regenerate: false) reuses an existing token or lazily creates
  // one; "regenerate" always issues a fresh one. Either way, if the guest has an email on file the
  // server also (re)sends it -- the result line reflects whichever actually happened.
  async function onRsvpLink(guestId: string, guestEmail: string | null, regenerate: boolean) {
    setRsvpLinkBusy((cur) => new Set(cur).add(guestId));
    setRsvpLinkResult((prev) => ({ ...prev, [guestId]: "" }));
    try {
      const { rsvp } = await api.post<{
        rsvp: RsvpEmailOutcome & { url: string };
      }>(
        `/api/v1/weddings/${weddingId}/guests/${guestId}/rsvp-link`,
        { regenerate }
      );
      // TS-132: if the email couldn't be sent, say so -- the planner then sends the link themselves.
      const notEmailed = rsvp.rsvpClosed
        ? `${RSVP_CLOSED_NOTE} `
        : rsvp.confirmEmailFirst
        ? `${CONFIRM_EMAIL_NOTE} — send ${guestEmail} the link yourself. `
        : rsvp.emailLimited
        ? `${emailLimitedNote(rsvp)} — send ${guestEmail} the link yourself. `
        : rsvp.recipientLimited
        ? `${RECIPIENT_LIMITED_NOTE} — send ${guestEmail} the link yourself. `
        : rsvp.recentlyEmailed
        ? `Already emailed to ${guestEmail} within the last hour, so not sent again. `
        : rsvp.emailFailed
          ? `Couldn't email ${guestEmail} — send them the link yourself. `
          : "";
      try {
        await navigator.clipboard.writeText(rsvp.url);
        setRsvpLinkResult((prev) => ({
          ...prev,
          [guestId]: rsvp.emailed ? `Link copied & emailed to ${guestEmail}` : `${notEmailed}Link copied to clipboard`,
        }));
      } catch {
        setRsvpLinkResult((prev) => ({
          ...prev,
          [guestId]: rsvp.emailed ? `Emailed to ${guestEmail} — ${rsvp.url}` : `${notEmailed}${rsvp.url}`,
        }));
      }
    } catch (err) {
      setRowError(guestId, err instanceof ApiError ? err.message : "Couldn't get that guest's RSVP link.");
    } finally {
      setRsvpLinkBusy((cur) => {
        const next = new Set(cur);
        next.delete(guestId);
        return next;
      });
    }
  }

  async function onToggleLock(guestId: string, isLocked: boolean) {
    const before = guests.find((g) => g.id === guestId);
    patchRow(guestId, { isLocked });
    try {
      await saveGuest(guestId, { isLocked });
    } catch (err) {
      const fresh = conflictGuest(err);
      if (fresh) showConflict(fresh);
      else {
        if (before) patchRow(guestId, { isLocked: before.isLocked });
        setRowError(guestId, err instanceof ApiError ? err.message : "Couldn't update that guest's lock.");
      }
    }
  }

  return (
    <div>
      {!canEdit && (
        <p className="mb-4 rounded-md bg-neutral-100 dark:bg-neutral-800 px-3 py-2 text-sm text-neutral-600 dark:text-neutral-300">
          You have view-only access to this wedding&apos;s guest list — adding, importing, and editing
          guests is turned off.
        </p>
      )}
      {canEdit && (
        <>
      <h2 className="mb-3 text-lg font-medium">Add a guest</h2>
      <form
        onSubmit={onAddGuest}
        className="mb-8 grid grid-cols-1 gap-3 rounded-lg border border-neutral-200 dark:border-neutral-700 p-4 sm:grid-cols-2"
      >
        <div>
          <label htmlFor="guest-first-name" className="mb-1 block text-sm font-medium">
            First name
          </label>
          <input
            id="guest-first-name"
            className="w-full rounded-md border border-neutral-300 dark:border-neutral-600 px-3 py-2 text-sm"
            value={firstName}
            onChange={(e) => setFirstName(e.target.value)}
            required
            maxLength={FIELD_LIMITS.personName}
          />
        </div>
        <div>
          <label htmlFor="guest-last-name" className="mb-1 block text-sm font-medium">
            Last name
          </label>
          <input
            id="guest-last-name"
            className="w-full rounded-md border border-neutral-300 dark:border-neutral-600 px-3 py-2 text-sm"
            value={lastName}
            onChange={(e) => setLastName(e.target.value)}
            required
            maxLength={FIELD_LIMITS.personName}
          />
        </div>
        {/* TS-112: only a name is required, so the other eight fields wait behind "More details"
            -- their defaults are exactly what a name-only guest gets anyway. */}
        {!showMoreDetails ? (
          <button
            type="button"
            onClick={() => {
              setShowMoreDetails(true);
              // TS-191: focus moves to the first of the new boxes (it used to be lost with the button).
              setTimeout(() => document.getElementById("guest-party-name")?.focus(), 0);
            }}
            aria-expanded={false}
            className="justify-self-start text-sm text-neutral-600 dark:text-neutral-300 underline hover:no-underline sm:col-span-2"
          >
            + More details (household, email, notes, headcount, tier, RSVP, side, age, accessibility)
          </button>
        ) : (
          <>
          <div>
            <label htmlFor="guest-party-name" className="mb-1 block text-sm font-medium">
              Party / household
            </label>
            <input
              maxLength={FIELD_LIMITS.partyName}
              id="guest-party-name"
              className="w-full rounded-md border border-neutral-300 dark:border-neutral-600 px-3 py-2 text-sm"
              placeholder="e.g. The Carter Family"
              value={partyName}
              onChange={(e) => setPartyName(e.target.value)}
            />
          </div>
          <div>
            <label htmlFor="guest-email" className="mb-1 block text-sm font-medium">
              Email
            </label>
            <input
              maxLength={FIELD_LIMITS.email}
              id="guest-email"
              type="email"
              className="w-full rounded-md border border-neutral-300 dark:border-neutral-600 px-3 py-2 text-sm"
              placeholder="Optional -- they're emailed their RSVP link when you add them"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
          </div>
          {/* TS-129 */}
          <div className="sm:col-span-2">
            <label htmlFor="guest-notes" className="mb-1 block text-sm font-medium">
              Notes
            </label>
            <textarea
              id="guest-notes"
              rows={2}
              maxLength={FIELD_LIMITS.guestNotes}
              aria-describedby="guest-notes-hint"
              className="w-full rounded-md border border-neutral-300 dark:border-neutral-600 px-3 py-2 text-sm"
              placeholder="e.g. vegetarian, nut allergy, uses a wheelchair"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
            />
            <p id="guest-notes-hint" className="mt-1 text-xs text-neutral-500 dark:text-neutral-400">
              Private to your planning team — the guest never sees this.
            </p>
          </div>
          <div>
            <label htmlFor="guest-headcount" className="mb-1 block text-sm font-medium">
              Headcount
            </label>
            <input
              inputMode="numeric"
              id="guest-headcount"
              type="number"
              min={1}
              max={20}
              className="w-full rounded-md border border-neutral-300 dark:border-neutral-600 px-3 py-2 text-sm"
              value={headcount}
              onChange={(e) => setHeadcount(e.target.value)}
            />
          </div>
          <div>
            <label htmlFor="guest-tier" className="mb-1 block text-sm font-medium">
              Tier
            </label>
            <select
              id="guest-tier"
              className="w-full rounded-md border border-neutral-300 dark:border-neutral-600 px-3 py-2 text-sm"
              value={tier}
              onChange={(e) => setTier(e.target.value as GuestTier)}
            >
              {TIERS.map((t) => (
                <option key={t} value={t}>
                  {GUEST_TIER_LABELS[t]}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label htmlFor="guest-rsvp" className="mb-1 block text-sm font-medium">
              RSVP
            </label>
            <select
              id="guest-rsvp"
              className="w-full rounded-md border border-neutral-300 dark:border-neutral-600 px-3 py-2 text-sm"
              value={rsvpStatus}
              onChange={(e) => setRsvpStatus(e.target.value as RsvpStatus)}
            >
              {RSVP_STATUSES.map((s) => (
                <option key={s} value={s}>
                  {RSVP_STATUS_LABELS[s]}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label htmlFor="guest-side" className="mb-1 block text-sm font-medium">
              Side
            </label>
            <select
              id="guest-side"
              className="w-full rounded-md border border-neutral-300 dark:border-neutral-600 px-3 py-2 text-sm"
              value={side}
              onChange={(e) => setSide(e.target.value as GuestSide)}
            >
              {SIDE_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label htmlFor="guest-age-category" className="mb-1 block text-sm font-medium">
              Age category
            </label>
            <select
              id="guest-age-category"
              className="w-full rounded-md border border-neutral-300 dark:border-neutral-600 px-3 py-2 text-sm"
              value={ageCategory}
              onChange={(e) => setAgeCategory(e.target.value as AgeCategory)}
            >
              {AGE_CATEGORIES.map((a) => (
                <option key={a} value={a}>
                  {a.charAt(0) + a.slice(1).toLowerCase()}
                </option>
              ))}
            </select>
            <p className="mt-1 text-xs text-neutral-500 dark:text-neutral-400">
              Only used as a soft preference for a Purpose table&apos;s Age Category criterion
              (e.g. a &quot;Kids&apos; Table&quot;).
            </p>
          </div>
          <label className="flex items-center gap-2 text-sm sm:col-span-2">
            <input
              type="checkbox"
              checked={requiresAccessibleTable}
              onChange={(e) => setRequiresAccessibleTable(e.target.checked)}
            />
            Requires an accessible table
          </label>
          </>
        )}
        <button
          type="submit"
          disabled={adding}
          className="rounded-md bg-neutral-900 dark:bg-neutral-100 px-4 py-2 text-sm font-medium text-white dark:text-neutral-900 hover:bg-neutral-700 dark:hover:bg-neutral-300 disabled:opacity-50 sm:col-span-2"
        >
          {adding ? "Adding..." : "Add guest"}
        </button>
      </form>

      {/* TS-182: a message about a guest who is no longer in the list is shown up here instead. */}
      {error && (!errorGuestId || !guests.some((g) => g.id === errorGuestId)) && (
        <p role="alert" className="mb-4 text-sm text-red-600 dark:text-red-400">
          {error}
        </p>
      )}
      {warning && (
        <p role="status" className="mb-4 rounded-md bg-amber-50 dark:bg-amber-950 px-3 py-2 text-sm text-amber-900 dark:text-amber-200">
          {warning}
        </p>
      )}

      <div className="mb-8 rounded-lg border border-neutral-200 dark:border-neutral-700 p-4">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-lg font-medium">Bulk import guests (CSV)</h2>
        </div>
        <p className="mb-3 text-sm text-neutral-500 dark:text-neutral-400">
          Add many guests at once, or update existing ones. Map a &quot;Guest ID&quot; column
          (from a prior export) to update those exact guests instead of creating new ones — a
          blank cell leaves that guest&apos;s existing value alone; type <code>[CLEAR]</code> in a
          Party/household, Notes or Plus-ones cell to blank it out explicitly. Nothing is saved until you
          confirm the preview below, and either everything imports or nothing does.
        </p>

        <div className="mb-3">
          <button
            type="button"
            onClick={() => setShowImportExample((v) => !v)}
            aria-expanded={showImportExample}
            className="text-sm text-neutral-600 dark:text-neutral-300 underline hover:text-neutral-900 dark:hover:text-neutral-100"
          >
            {showImportExample ? "Hide example" : "See an example"}
          </button>
          {showImportExample && (
            <div className="mt-2 rounded-md border border-neutral-200 dark:border-neutral-700 bg-neutral-50 dark:bg-neutral-900 p-3">
              <p className="mb-2 text-xs text-neutral-500 dark:text-neutral-400">
                Column order and header names don&apos;t have to match this exactly — you&apos;ll
                map each of your file&apos;s columns to a guest field below once it&apos;s chosen.
                This is just one example of a clean file:
              </p>
              <div className="overflow-x-auto">
                <table className="min-w-full text-xs">
                  <thead>
                    <tr className="text-left text-neutral-500 dark:text-neutral-400">
                      {IMPORT_EXAMPLE.headers.map((h) => (
                        <th key={h} className="whitespace-nowrap pb-1 pr-3 font-medium">
                          {h}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {IMPORT_EXAMPLE.rows.map((row, i) => (
                      <tr key={i} className="border-t border-neutral-200 dark:border-neutral-700">
                        {row.map((cell, j) => (
                          <td key={j} className="whitespace-nowrap py-1 pr-3">
                            {cell || <span className="text-neutral-400 dark:text-neutral-500">—</span>}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <p className="mt-2 text-xs text-neutral-500 dark:text-neutral-400">
                Accepted values (not case-sensitive) — Tier: VIP, Family, Friend, Plus One, Other.
                RSVP status: Pending, Confirmed, Declined. Accessible table?: Yes/No. Attendance:
                Attending, Not Attending. Side: {sideLabel1}, {sideLabel2}, or Both. Age category:
                Adult, Child, Infant.
              </p>
              <button
                type="button"
                onClick={onDownloadImportExample}
                className="mt-2 rounded-md border border-neutral-300 dark:border-neutral-600 px-2 py-1 text-xs font-medium hover:bg-white dark:hover:bg-neutral-800"
              >
                Download example CSV
              </button>
            </div>
          )}
        </div>

        <input
          ref={fileInputRef}
          type="file"
          accept=".csv,text/csv"
          onChange={onFileSelected}
          // TS-191: no new file while a preview is being checked.
          disabled={previewing}
          // TS-175: never wider than the space it is in (with Linux fonts it ran 6px off a phone screen).
          className="mb-3 block w-full max-w-full text-sm"
          // TS-53 (AC-079): no visible <label> wraps this input (the paragraph/button above it are
          // instructions and a download link, not a label element) -- axe-core's WCAG 2.1 AA "label"
          // rule flagged it as critical (no accessible name at all). Same sr-only-name fix shape as
          // the Day-of walk-in fields' own aria-label, per README.md's NFR-9.5 pass.
          aria-label="Upload a CSV file of guests to import"
        />

        {csvHeaders.length > 0 && (
          <div className="mb-4">
            <p className="mb-2 text-sm font-medium">
              {csvFileName} — map columns to guest fields:
            </p>
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
              {IMPORT_FIELDS.map(({ field, label, required }) => (
                <div key={field}>
                  {/* TS-140: tied to its select, so each column picker has an accessible name. */}
                  <label htmlFor={`import-map-${field}`} className="mb-1 block text-xs font-medium text-neutral-600 dark:text-neutral-300">
                    {label}
                    {required && <span className="text-red-600 dark:text-red-400"> *</span>}
                  </label>
                  <select
                    id={`import-map-${field}`}
                    className="w-full rounded-md border border-neutral-300 dark:border-neutral-600 px-2 py-1.5 text-sm"
                    value={mapping[field] ?? ""}
                    onChange={(e) => onMappingChange(field, e.target.value)}
                    // TS-191: the columns stay as they are while the preview is checked.
                    disabled={previewing}
                  >
                    <option value="">— not in file —</option>
                    {csvHeaders.map((h) => (
                      <option key={h} value={h}>
                        {h}
                      </option>
                    ))}
                  </select>
                </div>
              ))}
            </div>
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <button
                onClick={onRequestPreview}
                disabled={previewing || !mapping.firstName || !mapping.lastName}
                className="rounded-md border border-neutral-300 dark:border-neutral-600 px-3 py-1.5 text-sm font-medium hover:bg-neutral-50 dark:hover:bg-neutral-800 disabled:opacity-50"
              >
                {previewing ? "Checking..." : "Preview import"}
              </button>
              <button
                onClick={resetImport}
                disabled={previewing}
                className="rounded-md border border-neutral-300 dark:border-neutral-600 px-3 py-1.5 text-sm hover:bg-neutral-50 dark:hover:bg-neutral-800 disabled:opacity-50"
              >
                Cancel
              </button>
            </div>
          </div>
        )}

        {importError && <p role="alert" className="mb-3 text-sm text-red-600 dark:text-red-400">{importError}</p>}
        {importResult && (
          <div className="mb-3">
            <p className="text-sm text-green-700 dark:text-green-400">
              Import complete: {importResult.createdCount} guest(s) added, {importResult.updatedCount}{" "}
              updated
              {/* TS-180 */}
              {importResult.skippedCount ? `, ${importResult.skippedCount} left as they are (changed since the export)` : ""}
              {/* TS-190 */}
              {importResult.unchangedCount ? `, ${importResult.unchangedCount} unchanged` : ""}.
            </p>
            {importResult.warnings.length > 0 && (
              <ul className="mt-1 list-inside list-disc text-sm text-amber-700 dark:text-amber-400">
                {importResult.warnings.map((w, i) => (
                  <li key={i}>{w}</li>
                ))}
              </ul>
            )}
          </div>
        )}

        {importPreview && (
          <div>
            <p className="mb-2 text-sm">
              <strong>{importPreview.summary.newCount}</strong> new,{" "}
              <strong>{importPreview.summary.updatingCount}</strong> updating,{" "}
              {/* TS-190: rows the same as the guest already is -- left alone. */}
              {importPreview.summary.unchangedCount > 0 && (
                <>
                  <strong>{importPreview.summary.unchangedCount}</strong> unchanged,{" "}
                </>
              )}
              {/* TS-180 */}
              {importPreview.summary.conflictCount > 0 && (
                <>
                  <strong>{importPreview.summary.conflictCount}</strong> changed since the export,{" "}
                </>
              )}
              <strong>{importPreview.summary.errorCount}</strong> with errors (of{" "}
              {importPreview.summary.totalRows} row(s)).
            </p>
            <ul className="mb-3 max-h-64 overflow-y-auto rounded-md border border-neutral-200 dark:border-neutral-700">
              {importPreview.rows.map((r) => (
                <li
                  key={r.rowNumber}
                  className={`flex flex-wrap items-center gap-2 border-b border-neutral-100 dark:border-neutral-800 px-2 py-1.5 text-sm last:border-b-0 ${
                    r.kind === "error"
                      ? "bg-red-50 dark:bg-red-950"
                      : r.kind === "conflict"
                        ? "bg-amber-50 dark:bg-amber-950"
                        : r.kind === "update"
                          ? "bg-blue-50 dark:bg-blue-950"
                          : ""
                  }`}
                >
                  <span className="w-12 shrink-0 text-neutral-500 dark:text-neutral-400">Row {r.rowNumber}</span>
                  <span
                    className={`shrink-0 rounded px-1.5 py-0.5 text-xs font-medium ${
                      r.kind === "error"
                        ? "bg-red-100 dark:bg-red-900 text-red-700 dark:text-red-400"
                        : r.kind === "conflict"
                          ? "bg-amber-100 dark:bg-amber-900 text-amber-800 dark:text-amber-300"
                        : r.kind === "update"
                          ? "bg-blue-100 text-blue-700 dark:bg-blue-900 dark:text-blue-200"
                          : "bg-neutral-100 dark:bg-neutral-800 text-neutral-700 dark:text-neutral-300"
                    }`}
                  >
                    {r.kind === "conflict" ? "changed" : r.kind}
                  </span>
                  {r.kind === "error" ? (
                    <span className="text-red-700 dark:text-red-400">{r.reason}</span>
                  ) : r.kind === "conflict" ? (
                    <span>
                      {r.preview.firstName} {r.preview.lastName}:{" "}
                      <span className="text-amber-800 dark:text-amber-300">{r.reason}</span>
                    </span>
                  ) : (
                    <span>
                      {r.preview.firstName} {r.preview.lastName}
                      {r.kind === "update" ? " (updating existing guest)" : r.kind === "unchanged" ? " (no changes)" : ""}
                    </span>
                  )}
                </li>
              ))}
            </ul>
            {/* TS-180: guests changed in Seatwise since the file was exported are left alone
                unless the planner says otherwise. */}
            {importPreview.summary.conflictCount > 0 && (
              <label className="mb-3 flex items-start gap-2 text-sm">
                <input
                  type="checkbox"
                  className="mt-0.5"
                  checked={overwriteChanged}
                  onChange={(e) => setOverwriteChanged(e.target.checked)}
                />
                <span>
                  Overwrite guests changed since the export ({importPreview.summary.conflictCount}) — otherwise
                  they&apos;re left as they are in Seatwise.
                </span>
              </label>
            )}
            <button
              onClick={onConfirmImport}
              disabled={
                committing ||
                importPreview.summary.errorCount > 0 ||
                importPreview.summary.newCount +
                  importPreview.summary.updatingCount +
                  (overwriteChanged ? importPreview.summary.conflictCount : 0) ===
                  0
              }
              className="rounded-md bg-neutral-900 dark:bg-neutral-100 px-4 py-2 text-sm font-medium text-white dark:text-neutral-900 hover:bg-neutral-700 dark:hover:bg-neutral-300 disabled:opacity-50"
            >
              {committing
                ? "Importing..."
                : `Confirm import (${
                    importPreview.summary.newCount +
                    importPreview.summary.updatingCount +
                    (overwriteChanged ? importPreview.summary.conflictCount : 0)
                  } guest(s))`}
            </button>
            {importPreview.summary.errorCount > 0 && (
              <p className="mt-2 text-sm text-red-600 dark:text-red-400">
                Fix the error row(s) above (or unmap the offending column) before importing —
                nothing saves until every row is clean.
              </p>
            )}
          </div>
        )}
      </div>
        </>
      )}

      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        {/* TS-177: invitations and people, the same as the dashboard -- "Guests (N)" counted people
            while the dashboard's "N guests" counted invitations. */}
        <h2 className="text-lg font-medium">
          Guests ({formatGuestCounts(guests.length, guests.reduce((sum, g) => sum + g.headcount, 0))})
        </h2>
        {/* TS-170: a download, not a page change -- so it doesn't set off "leave this page?" for
            half-typed input, or replace the page with an error if the session has run out. */}
        <a
          href={`/api/v1/weddings/${weddingId}/guests/export`}
          download
          className="rounded-md border border-neutral-300 dark:border-neutral-600 min-h-11 px-3 py-1.5 text-sm font-medium hover:bg-neutral-50 dark:hover:bg-neutral-800"
        >
          Export guest list (CSV)
        </a>
      </div>
      {guests.length === 0 ? (
        <p className="text-sm text-neutral-500 dark:text-neutral-400">
          {/* TS-166: only someone who can add guests has a form "above". */}
          {canEdit ? "No guests yet — add your first one above." : "No guests yet."}
        </p>
      ) : (
        <ul className="flex flex-col gap-2">
          {guests.map((g) => (
            <li
              key={g.id}
              className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-neutral-200 dark:border-neutral-700 px-4 py-3"
            >
              <div className="min-w-0">
                <div className="flex flex-wrap items-center font-medium">
                  {canEdit ? (
                    <span className="flex items-center gap-1">
                      <input
                        aria-label={`First name for ${g.firstName} ${g.lastName}`}
                        className="w-24 rounded-md border border-transparent px-1 py-0.5 font-medium hover:border-neutral-200 dark:hover:border-neutral-700 focus:border-neutral-300 dark:focus:border-neutral-600 focus:outline-none"
                        key={`${g.id}-first-${g.firstName}`}
                        defaultValue={g.firstName}
                        onInput={(e) => rowFields.markDirty(`guest-row-${g.id}-firstName`, e.currentTarget.value.trim() !== g.firstName)}
                        onBlur={(e) => {
                          rowFields.markDirty(`guest-row-${g.id}-firstName`, false);
                          onUpdateName(g.id, "firstName", e.currentTarget);
                        }}
                        maxLength={FIELD_LIMITS.personName}
                      />
                      <input
                        aria-label={`Last name for ${g.firstName} ${g.lastName}`}
                        className="w-28 rounded-md border border-transparent px-1 py-0.5 font-medium hover:border-neutral-200 dark:hover:border-neutral-700 focus:border-neutral-300 dark:focus:border-neutral-600 focus:outline-none"
                        key={`${g.id}-last-${g.lastName}`}
                        defaultValue={g.lastName}
                        onInput={(e) => rowFields.markDirty(`guest-row-${g.id}-lastName`, e.currentTarget.value.trim() !== g.lastName)}
                        onBlur={(e) => {
                          rowFields.markDirty(`guest-row-${g.id}-lastName`, false);
                          onUpdateName(g.id, "lastName", e.currentTarget);
                        }}
                        maxLength={FIELD_LIMITS.personName}
                      />
                    </span>
                  ) : (
                    <span>
                      {g.firstName} {g.lastName}
                    </span>
                  )}
                  {g.headcount > 1 ? ` (+${g.headcount - 1})` : ""}
                  {g.requiresAccessibleTable && (
                    <span className="ml-2 rounded bg-blue-50 dark:bg-blue-950 px-1.5 py-0.5 text-xs text-blue-700 dark:text-blue-400">
                      accessible table
                    </span>
                  )}
                  {g.isLocked && (
                    <span
                      className="ml-2 rounded bg-neutral-800 dark:bg-neutral-700 px-1.5 py-0.5 text-xs text-white"
                      title="Locked — new plans keep this guest at their table when the rules allow. You'll see a note if they had to move."
                    >
                      locked
                    </span>
                  )}
                  {g.dayOfAttendance === "NOT_ATTENDING" && (
                    <span
                      className="ml-2 rounded bg-red-50 dark:bg-red-950 px-1.5 py-0.5 text-xs text-red-700 dark:text-red-400"
                      title="Not attending (they declined, or were marked on the day) — they don't take a seat."
                    >
                      not attending
                    </span>
                  )}
                  {/* TS-17 (FR-12.4): set only by the guest's own public submission, never by a
                      planner edit -- so this badge means exactly "responded via their link". */}
                  <span
                    className={`ml-2 rounded px-1.5 py-0.5 text-xs ${
                      g.rsvpRespondedAt
                        ? "bg-green-50 dark:bg-green-950 text-green-700 dark:text-green-400"
                        : // TS-53 (AC-079): text-neutral-500 on bg-neutral-100 measured 4.34:1 under
                          // axe-core's WCAG 2.1 AA color-contrast check (needs 4.5:1 for 12px text) --
                          // bumped one step darker to neutral-600 (~6.4:1), same fix shape README.md's
                          // own prior NFR-9.5 pass already used elsewhere (neutral-400 -> neutral-500).
                          "bg-neutral-100 dark:bg-neutral-800 text-neutral-600 dark:text-neutral-400"
                    }`}
                    title={
                      g.rsvpRespondedAt
                        ? `Responded via their RSVP link on ${formatMomentDate(g.rsvpRespondedAt)}`
                        : "Hasn't responded via their own RSVP link yet"
                    }
                  >
                    {g.rsvpRespondedAt ? "responded" : "no self-RSVP yet"}
                  </span>
                </div>
              </div>
              {/* TS-193: the row's buttons come right after the name, before the details below it, so
                  Tab goes name -> buttons -> notes and email -- the order they read on screen (the
                  buttons used to sit beside the whole block and were reached only after the email box). */}
              <div className="flex flex-wrap items-center gap-2">
                {canEdit ? (
                  <>
                    <select
                      aria-label={`Side for ${g.firstName} ${g.lastName}`}
                      className="rounded-md border border-neutral-300 dark:border-neutral-600 px-2 py-1 text-sm"
                      value={g.side}
                      onChange={(e) => onUpdateSide(g.id, e.target.value as GuestSide)}
                    >
                      {SIDE_OPTIONS.map((o) => (
                        <option key={o.value} value={o.value}>
                          {o.label}
                        </option>
                      ))}
                    </select>
                    <select
                      aria-label={`RSVP status for ${g.firstName} ${g.lastName}`}
                      className="rounded-md border border-neutral-300 dark:border-neutral-600 px-2 py-1 text-sm"
                      value={g.rsvpStatus}
                      onChange={(e) => onUpdateRsvp(g.id, e.target.value as RsvpStatus)}
                    >
                      {RSVP_STATUSES.map((s) => (
                        <option key={s} value={s}>
                          {RSVP_STATUS_LABELS[s]}
                        </option>
                      ))}
                    </select>
                    <button
                      onClick={() => onToggleLock(g.id, !g.isLocked)}
                      title="Locking keeps this guest at their current table when a new plan is generated, whenever the rules allow."
                      className="rounded-md border border-neutral-300 dark:border-neutral-600 px-2 py-1 text-sm hover:bg-neutral-50 dark:hover:bg-neutral-800"
                    >
                      {g.isLocked ? "Unlock" : "Lock"}
                    </button>
                    {/* TS-17 (FR-12.4): "get/copy" reuses an existing token (or lazily creates
                        one) and emails it if this guest has an address on file; "New link"
                        always issues a fresh token, invalidating whatever link was out there. */}
                    <button
                      onClick={() => onRsvpLink(g.id, g.email, false)}
                      disabled={rsvpLinkBusy.has(g.id)}
                      title="Copies this guest's RSVP link, and emails it to them if they have an address on file."
                      className="rounded-md border border-neutral-300 dark:border-neutral-600 px-2 py-1 text-sm hover:bg-neutral-50 dark:hover:bg-neutral-800 disabled:opacity-50"
                    >
                      {rsvpLinkBusy.has(g.id) ? "..." : "RSVP link"}
                    </button>
                    <button
                      onClick={() => onRsvpLink(g.id, g.email, true)}
                      disabled={rsvpLinkBusy.has(g.id)}
                      title="Makes a new RSVP link (the old one stops working) and emails it to the guest if they have an email address and RSVPs are still open."
                      className="rounded-md border border-neutral-300 dark:border-neutral-600 px-2 py-1 text-sm hover:bg-neutral-50 dark:hover:bg-neutral-800 disabled:opacity-50"
                    >
                      New link
                    </button>
                    <ConfirmDeleteButton
                      ariaLabel={`Remove ${g.firstName} ${g.lastName}`}
                      question={`Remove ${g.firstName} ${g.lastName} from the guest list? Their seat and any seating rules involving them are removed too, including from saved past versions of the plan. This can't be undone.`}
                      confirmLabel="Yes, remove guest"
                      onConfirm={() => onDeleteGuest(g.id)}
                    />
                  </>
                ) : (
                  <span className="text-sm text-neutral-500 dark:text-neutral-400">{RSVP_STATUS_LABELS[g.rsvpStatus]}</span>
                )}
              </div>
              <div className="basis-full">
                <p className="text-sm text-neutral-500 dark:text-neutral-400">
                  {g.partyName ? `${g.partyName} · ` : ""}
                  {GUEST_TIER_LABELS[g.tier]}
                  {g.side !== "BOTH" ? ` · ${sideLabelFor(g.side)}` : ""}
                  {g.ageCategory !== "ADULT" ? ` · ${g.ageCategory.charAt(0)}${g.ageCategory.slice(1).toLowerCase()}` : ""}
                  {g.plusOneNames ? ` · with ${g.plusOneNames}` : ""}
                </p>
                {/* TS-107: the guest's own note from their RSVP link -- read-only here, and kept
                    apart from the planner's private notes, which the guest never sees. */}
                {g.rsvpNotes && (
                  // TS-191: a long unbroken note wraps instead of running off a phone screen.
                  <p className="whitespace-pre-line break-words text-sm text-neutral-600 dark:text-neutral-400 [overflow-wrap:anywhere]">
                    <span className="font-medium">Guest&apos;s RSVP note:</span> {g.rsvpNotes}
                  </p>
                )}
                {/* TS-129: the planner's private notes -- editable by Owner/Edit. TS-180: View and
                    Comment collaborators don't get them at all (TS-154), here or in the CSV export. */}
                {canEdit ? (
                  <textarea
                    aria-label={`Notes for ${g.firstName} ${g.lastName}`}
                    title="Private to your planning team — the guest never sees this."
                    rows={1}
                    maxLength={FIELD_LIMITS.guestNotes}
                    className="mt-1 block w-72 max-w-full rounded-md border border-neutral-200 dark:border-neutral-700 px-2 py-1 text-xs"
                    placeholder="Private notes (dietary, accessibility…)"
                    key={`${g.id}-notes-${g.notes ?? ""}`}
                    defaultValue={g.notes ?? ""}
                    onInput={(e) => rowFields.markDirty(`guest-row-${g.id}-notes`, (e.currentTarget.value.trim() || null) !== (g.notes ?? null))}
                    onBlur={(e) => {
                      rowFields.markDirty(`guest-row-${g.id}-notes`, false);
                      onUpdateNotes(g.id, e.currentTarget);
                    }}
                  />
                ) : (
                  g.notes && (
                    <p className="whitespace-pre-line text-sm text-neutral-600 dark:text-neutral-400">
                      <span className="font-medium">Notes:</span> {g.notes}
                    </p>
                  )
                )}
                {canEdit ? (
                  <input
                    maxLength={FIELD_LIMITS.email}
                    type="email"
                    aria-label={`Email for ${g.firstName} ${g.lastName}`}
                    className="mt-1 w-56 rounded-md border border-neutral-200 dark:border-neutral-700 px-2 py-1 text-xs"
                    placeholder="Email (for their RSVP link)"
                    key={`${g.id}-email-${g.email ?? ""}`}
                    defaultValue={g.email ?? ""}
                    onInput={(e) => rowFields.markDirty(`guest-row-${g.id}-email`, e.currentTarget.value !== (g.email ?? ""))}
                    onBlur={(e) => {
                      rowFields.markDirty(`guest-row-${g.id}-email`, false);
                      if (e.target.value !== (g.email ?? "")) onUpdateEmail(g.id, e.currentTarget);
                    }}
                  />
                ) : (
                  g.email && <p className="mt-1 text-xs text-neutral-500 dark:text-neutral-400">{g.email}</p>
                )}
                {rsvpLinkResult[g.id] && (
                  <p role="status" className="mt-1 text-xs text-neutral-500 dark:text-neutral-400">{rsvpLinkResult[g.id]}</p>
                )}
              </div>
              {error && errorGuestId === g.id && (
                <p role="alert" className="basis-full text-sm text-red-600 dark:text-red-400">
                  {error}
                </p>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
