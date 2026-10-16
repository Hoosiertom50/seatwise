// TS-272: the team's "Add a sample wedding" button -- a filled-in wedding in the presser's own
// account, so something shows on every tab but Collaborators. Based on the full wedding in
// prisma/local-test-data.ts, but smaller and with nothing that reaches anyone: no collaborators or
// invites, no guest or vendor email addresses, no RSVP or vendor links -- so it sends no email.
//
// Made through the app's own database functions and form rules (as the script is), so the data is
// what the app itself would have saved. If any step fails, the half-made wedding is deleted.
import {
  createWeddingSchema,
  createTableSchema,
  createTimelineEntrySchema,
  createVendorSchema,
  generateSeatingPlan,
  RULE_WEIGHT_CONFIG_VERSION,
  type EngineSideMixing,
  type EngineGuestTier,
  type EngineAgeCategory,
  type EnginePurposeCriterionType,
} from "@seatwise/shared";
import { createWedding, deleteWeddingForOwner } from "./queries/weddings";
import { listGuestsByWedding, updateGuestForWedding, type GuestRow } from "./queries/guests";
import { commitGuestImport } from "./queries/guest-import";
import { createRelationship, listRelationshipsForWedding } from "./queries/relationships";
import {
  createSeatingTable,
  listSeatingTablesForWedding,
  setRequiredGuestsForTable,
  updateSeatingTableForWedding,
  type SeatingTableRow,
} from "./queries/tables";
import {
  createPlanVersionWithAssignments,
  getLatestAssignmentsForWedding,
  setPlanVersionLabel,
  setPlanVersionStatus,
} from "./queries/plan-versions";
import { createTimelineEntry } from "./queries/timeline";
import { createVendor, setBudgetForWedding } from "./queries/vendors";
import { createComment, resolveComment } from "./queries/comments";

// The name rules refuse a date (a run of digits) and brackets, so every sample has this name.
export const SAMPLE_WEDDING_NAME = "Sample - Jamie & Morgan's Wedding";
export const SAMPLE_WEDDING_NOTE =
  "This is sample data from the Add a sample wedding button, for trying Seatwise out. Change anything you like, and delete it from the dashboard any time.";

type GuestSpec = {
  key: string;
  first: string;
  last: string;
  side: "BRIDE" | "GROOM" | "BOTH";
  tier: "VIP" | "FAMILY" | "FRIEND" | "PLUS_ONE" | "OTHER";
  rsvp?: "PENDING" | "CONFIRMED" | "DECLINED";
  household?: string;
  plusOnes?: string[];
  age?: "ADULT" | "CHILD" | "INFANT";
  accessible?: boolean;
  notes?: string;
};

// 44 guests (50 people with plus-ones). Declined guests are also marked Not attending, as the app
// does when an answer changes to Declined.
export const SAMPLE_GUESTS: GuestSpec[] = [
  // Jamie's side
  { key: "rosa", first: "Rosa", last: "Rivera", side: "BRIDE", tier: "VIP", rsvp: "CONFIRMED", household: "Rivera Family", notes: "Mother of the bride. Giving the first toast." },
  { key: "hector", first: "Hector", last: "Rivera", side: "BRIDE", tier: "VIP", rsvp: "CONFIRMED", household: "Rivera Family" },
  { key: "lucia", first: "Lucía", last: "Rivera", side: "BRIDE", tier: "FAMILY", rsvp: "CONFIRMED", household: "Rivera Family" },
  { key: "mateo", first: "Mateo", last: "Rivera", side: "BRIDE", tier: "FAMILY", rsvp: "CONFIRMED", household: "Rivera Family", age: "CHILD" },
  { key: "sofia", first: "Sofía", last: "Rivera", side: "BRIDE", tier: "FAMILY", rsvp: "CONFIRMED", household: "Rivera Family", age: "INFANT", notes: "Needs a high chair." },
  { key: "carmen", first: "Carmen", last: "Delgado", side: "BRIDE", tier: "FAMILY", rsvp: "CONFIRMED", household: "Delgado Household", accessible: true, notes: "Uses a wheelchair." },
  { key: "luis", first: "Luis", last: "Delgado", side: "BRIDE", tier: "FAMILY", rsvp: "CONFIRMED", household: "Delgado Household" },
  { key: "isabel", first: "Isabel", last: "Ortiz", side: "BRIDE", tier: "FAMILY", rsvp: "CONFIRMED", plusOnes: ["Marco Ortiz"] },
  { key: "elena", first: "Elena", last: "Vargas", side: "BRIDE", tier: "VIP", rsvp: "CONFIRMED", accessible: true, notes: "Grandmother. Seat near the exit; low-sodium meal." },
  { key: "ana", first: "Ana", last: "Torres", side: "BRIDE", tier: "FRIEND", rsvp: "CONFIRMED", plusOnes: ["Ben Carter"] },
  { key: "maya", first: "Maya", last: "Chen", side: "BRIDE", tier: "FRIEND", rsvp: "CONFIRMED", notes: "Maid of honor." },
  { key: "priya", first: "Priya", last: "Natarajan", side: "BRIDE", tier: "FRIEND", rsvp: "CONFIRMED" },
  { key: "olivia", first: "Olivia", last: "Brooks", side: "BRIDE", tier: "FRIEND", rsvp: "CONFIRMED" },
  { key: "hannah", first: "Hannah", last: "Lee", side: "BRIDE", tier: "FRIEND", rsvp: "PENDING" },
  { key: "jordan", first: "Jordan", last: "Blake", side: "BRIDE", tier: "PLUS_ONE", rsvp: "PENDING", notes: "Hannah's date." },
  { key: "grace", first: "Grace", last: "Kim", side: "BRIDE", tier: "FRIEND", rsvp: "DECLINED" },
  { key: "chloe", first: "Chloe", last: "Martin", side: "BRIDE", tier: "FRIEND", rsvp: "CONFIRMED", plusOnes: ["Ryan Martin"] },
  { key: "emma", first: "Emma", last: "Wilson", side: "BRIDE", tier: "FRIEND", rsvp: "PENDING" },
  { key: "zoe", first: "Zoe", last: "Adams", side: "BRIDE", tier: "FRIEND", rsvp: "CONFIRMED" },
  { key: "ella", first: "Ella", last: "Gómez", side: "BRIDE", tier: "FAMILY", rsvp: "CONFIRMED", household: "Gómez Family", age: "CHILD" },
  { key: "leo", first: "Leo", last: "Gómez", side: "BRIDE", tier: "FAMILY", rsvp: "CONFIRMED", household: "Gómez Family", age: "CHILD", notes: "Peanut allergy." },
  { key: "teresa", first: "Teresa", last: "Morales", side: "BRIDE", tier: "FAMILY", rsvp: "DECLINED", notes: "Traveling abroad that week." },
  { key: "victor", first: "Victor", last: "Morales", side: "BRIDE", tier: "FAMILY", rsvp: "PENDING" },
  // Morgan's side
  { key: "margaret", first: "Margaret", last: "Ellis", side: "GROOM", tier: "VIP", rsvp: "CONFIRMED", household: "Ellis Family" },
  { key: "richard", first: "Richard", last: "Ellis", side: "GROOM", tier: "VIP", rsvp: "CONFIRMED", household: "Ellis Family" },
  { key: "owen", first: "Owen", last: "Ellis", side: "GROOM", tier: "FAMILY", rsvp: "CONFIRMED", household: "Ellis Family", age: "CHILD" },
  { key: "fiona", first: "Fiona", last: "Byrne", side: "GROOM", tier: "FAMILY", rsvp: "CONFIRMED", household: "Byrne Family" },
  { key: "patrick", first: "Patrick", last: "Byrne", side: "GROOM", tier: "FAMILY", rsvp: "CONFIRMED", household: "Byrne Family" },
  { key: "aidan", first: "Aidan", last: "Byrne", side: "GROOM", tier: "FAMILY", rsvp: "CONFIRMED", household: "Byrne Family", age: "CHILD" },
  { key: "noah", first: "Noah", last: "Bennett", side: "GROOM", tier: "FRIEND", rsvp: "CONFIRMED", plusOnes: ["Ava Bennett"] },
  { key: "ethan", first: "Ethan", last: "Clark", side: "GROOM", tier: "FRIEND", rsvp: "CONFIRMED" },
  { key: "lucas", first: "Lucas", last: "Hall", side: "GROOM", tier: "FRIEND", rsvp: "CONFIRMED" },
  { key: "logan", first: "Logan", last: "Wright", side: "GROOM", tier: "FRIEND", rsvp: "CONFIRMED" },
  { key: "jack", first: "Jack", last: "Turner", side: "GROOM", tier: "FRIEND", rsvp: "CONFIRMED" },
  { key: "henry", first: "Henry", last: "Scott", side: "GROOM", tier: "FRIEND", rsvp: "CONFIRMED", notes: "Best man." },
  { key: "samuel", first: "Samuel", last: "Green", side: "GROOM", tier: "FRIEND", rsvp: "CONFIRMED" },
  { key: "benjamin", first: "Benjamin", last: "Adams", side: "GROOM", tier: "FRIEND", rsvp: "DECLINED" },
  { key: "dan", first: "Dan", last: "Baker", side: "GROOM", tier: "OTHER", rsvp: "CONFIRMED" },
  { key: "david", first: "David", last: "Carter", side: "GROOM", tier: "OTHER", rsvp: "CONFIRMED", plusOnes: ["Sarah Carter"] },
  // Both sides
  { key: "michael", first: "Michael", last: "O'Brien", side: "BOTH", tier: "VIP", rsvp: "CONFIRMED", notes: "Officiant." },
  { key: "rachel", first: "Rachel", last: "Price", side: "BOTH", tier: "OTHER", rsvp: "CONFIRMED" },
  { key: "alex", first: "Alex", last: "Morgan-Lee", side: "BOTH", tier: "FRIEND", rsvp: "CONFIRMED", household: "Morgan-Lee household", plusOnes: ["Jess Morgan-Lee"] },
  { key: "sam", first: "Sam", last: "Taylor", side: "BOTH", tier: "FRIEND", rsvp: "PENDING" },
  { key: "nora", first: "Nora", last: "Fitzgerald", side: "BOTH", tier: "OTHER", rsvp: "CONFIRMED", notes: "Locked in place: sits with the band crew." },
];

// Accessible, Restricted (with its required guests), Single-Side-Only, two with a Purpose, plain ones.
const SAMPLE_TABLES: Array<Record<string, unknown>> = [
  { label: "Head Table", capacity: 8, shape: "RECTANGULAR", isRestricted: true, purpose: "Family of the couple and the officiant" },
  { label: "Table 1", capacity: 10, shape: "ROUND", isAccessible: true },
  { label: "Table 2", capacity: 10, shape: "ROUND" },
  { label: "Family Table", capacity: 10, shape: "ROUND", singleSideOnly: true },
  { label: "Kids' Table", capacity: 8, shape: "SQUARE", purpose: "Kids' table, near the parents", purposeCriterionType: "AGE_CATEGORY", purposeCriterionValue: "CHILD" },
  { label: "Friends Table", capacity: 10, shape: "ROUND", purpose: "College friends", purposeCriterionType: "TIER", purposeCriterionValue: "FRIEND" },
  { label: "Table 3", capacity: 10, shape: "OVAL" },
];
const HEAD_TABLE_GUESTS = ["rosa", "hector", "margaret", "richard", "michael", "rachel"];

// Seating rules of every kind, including a chain of "must sit together".
const SAMPLE_RULES: Array<[string, string, "MUST_SIT_TOGETHER" | "MUST_NOT_SIT_TOGETHER" | "AVOID" | "PREFER_NEAR"]> = [
  ["maya", "priya", "MUST_SIT_TOGETHER"],
  ["priya", "olivia", "MUST_SIT_TOGETHER"],
  ["carmen", "luis", "MUST_SIT_TOGETHER"],
  ["ethan", "lucas", "MUST_NOT_SIT_TOGETHER"],
  ["logan", "jack", "AVOID"],
  ["henry", "samuel", "PREFER_NEAR"],
  ["hannah", "jordan", "PREFER_NEAR"],
];

// The wedding day, with one entry after midnight.
const SAMPLE_TIMELINE: Array<[string, string, boolean?]> = [
  ["13:00", "Hair and makeup done"],
  ["14:30", "Photos with the wedding party"],
  ["16:00", "Ceremony begins"],
  ["16:45", "Cocktail hour on the terrace"],
  ["18:00", "Dinner is served"],
  ["19:30", "First dance and toasts"],
  ["21:00", "Cake cutting"],
  ["23:30", "Last dance"],
  ["00:30", "Last shuttle leaves for the hotel", true],
];

// Costs, an "Other" category, arrival times (one after midnight), one with no cost. No contact
// email addresses, so nothing can be sent to them.
const SAMPLE_VENDORS: Array<Record<string, unknown>> = [
  { name: "Harvest Table Catering", category: "CATERING", contactName: "Dana Hughes", contactPhone: "(317) 555-0142", costCents: 1250000, arrivalTime: "14:00", contractNotes: "Final headcount due two weeks before. 50% deposit paid." },
  { name: "Lakeside Pavilion", category: "VENUE", contactName: "Marcus Lane", contactPhone: "317-555-0199 ext. 4", costCents: 600000, arrivalTime: "09:00" },
  { name: "Petal & Stem", category: "FLORIST", costCents: 280000, arrivalTime: "12:30" },
  { name: "Golden Hour Photography", category: "PHOTOGRAPHY", contactName: "Ines Park", costCents: 350000, arrivalTime: "13:00" },
  { name: "DJ Nova", category: "MUSIC_ENTERTAINMENT", costCents: 150000, arrivalTime: "15:30", contractNotes: "Keep the speakers away from Table 1." },
  { name: "Snap Happy Booth", category: "OTHER", categoryOther: "Photo booth", costCents: 80000, arrivalTime: "18:30" },
  { name: "Midnight Shuttle Co.", category: "TRANSPORTATION", costCents: 45000, arrivalTime: "01:30", contractNotes: "Two runs back to the hotel after midnight." },
  { name: "Sweet Layers Bakery", category: "CAKE_BAKERY" },
];
const SAMPLE_BUDGET_CENTS = 3500000;

// The sample guests as a guest-import file, in the format the import's own sample file uses
// (docs/sample-guest-import.csv).
const SAMPLE_IMPORT_MAPPING = {
  firstName: "First Name",
  lastName: "Last Name",
  partyName: "Household",
  headcount: "Headcount",
  tier: "Tier",
  rsvpStatus: "RSVP Status",
  requiresAccessibleTable: "Accessible Table?",
  dayOfAttendance: "Attendance",
  side: "Side",
  ageCategory: "Age Category",
  notes: "Notes",
  plusOneNames: "Plus-ones",
};
const TIER_TEXT = { VIP: "VIP", FAMILY: "Family", FRIEND: "Friend", PLUS_ONE: "Plus-one", OTHER: "Other" } as const;
const SIDE_TEXT = { BRIDE: "Bride", GROOM: "Groom", BOTH: "Both" } as const;
const asWord = (value: string) => value[0] + value.slice(1).toLowerCase();
const csvCell = (value: string) => (/[",\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value);

export function sampleGuestCsv(): string {
  const rows = SAMPLE_GUESTS.map((s) => [
    s.first,
    s.last,
    s.household ?? "",
    String(1 + (s.plusOnes?.length ?? 0)),
    TIER_TEXT[s.tier],
    asWord(s.rsvp ?? "PENDING"),
    s.accessible ? "Yes" : "No",
    s.rsvp === "DECLINED" ? "Not attending" : "Attending",
    SIDE_TEXT[s.side],
    asWord(s.age ?? "ADULT"),
    s.notes ?? "",
    (s.plusOnes ?? []).join(", "),
  ]);
  return [Object.values(SAMPLE_IMPORT_MAPPING), ...rows].map((r) => r.map(csvCell).join(",")).join("\n");
}

/** An ISO date (YYYY-MM-DD) `days` after `from`. */
function addDays(from: string, days: number): string {
  const d = new Date(`${from}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** Generate, the way the Seating plan tab's Generate button does it (plan-versions/generate route). */
async function generate(weddingId: string, sideMixing: EngineSideMixing): Promise<string> {
  const [guests, relationships, tables, current] = await Promise.all([
    listGuestsByWedding(weddingId),
    listRelationshipsForWedding(weddingId),
    listSeatingTablesForWedding(weddingId),
    getLatestAssignmentsForWedding(weddingId),
  ]);
  const attending = guests.filter((g) => g.dayOfAttendance === "ATTENDING");
  const attendingIds = new Set(attending.map((g) => g.id));
  const requiredAt = new Map<string, string>();
  for (const t of tables) for (const id of t.requiredGuestIds) requiredAt.set(id, t.id);
  const result = generateSeatingPlan(
    attending.map((g) => ({
      id: g.id,
      name: `${g.firstName} ${g.lastName}`,
      headcount: g.headcount,
      requiresAccessibleTable: g.requiresAccessibleTable,
      isLocked: g.isLocked,
      currentTableId: current.get(g.id)?.tableId ?? null,
      currentSeatOrder: current.get(g.id)?.seatOrder ?? null,
      side: g.side as "BRIDE" | "GROOM" | "BOTH",
      tier: g.tier as EngineGuestTier,
      ageCategory: g.ageCategory as EngineAgeCategory,
      requiredTableId: requiredAt.get(g.id) ?? null,
    })),
    relationships
      .filter((r) => attendingIds.has(r.guestAId) && attendingIds.has(r.guestBId))
      .map((r) => ({ guestAId: r.guestAId, guestBId: r.guestBId, type: r.type })),
    tables.map((t) => ({
      id: t.id,
      label: t.label,
      capacity: t.capacity,
      isRestricted: t.isRestricted,
      isAccessible: t.isAccessible,
      isLocked: t.isLocked,
      singleSideOnly: t.singleSideOnly,
      purposeCriterion:
        t.purposeCriterionType && t.purposeCriterionValue
          ? { type: t.purposeCriterionType as EnginePurposeCriterionType, value: t.purposeCriterionValue }
          : null,
    })),
    sideMixing
  );
  if (result.errors.length > 0) throw new Error(`Sample wedding: Generate refused: ${result.errors.join("; ")}`);
  const { planVersionId } = await createPlanVersionWithAssignments(weddingId, {
    isComplete: result.isComplete,
    warnings: result.warnings,
    assignments: result.assignments,
    unassignedGuestIds: result.unassignedGuestIds,
    sideMixingSetting: sideMixing,
    ruleConfigVersion: RULE_WEIGHT_CONFIG_VERSION,
    makeCurrent: true,
  });
  return planVersionId;
}

async function fillSampleWedding(w: string, ownerId: string, sideMixing: EngineSideMixing): Promise<void> {
  // The guests go in through the app's own guest import (one file, a few queries) rather than one
  // at a time -- a few hundred queries fewer, which matters on the live database.
  await commitGuestImport(w, sampleGuestCsv(), SAMPLE_IMPORT_MAPPING, undefined, ownerId);
  const byName = new Map((await listGuestsByWedding(w)).map((x) => [`${x.firstName} ${x.lastName}`, x]));
  const g: Record<string, GuestRow> = {};
  for (const s of SAMPLE_GUESTS) {
    const guest = byName.get(`${s.first} ${s.last}`);
    if (!guest) throw new Error(`Sample wedding: ${s.first} ${s.last} wasn't imported.`);
    g[s.key] = guest;
  }

  const t: Record<string, SeatingTableRow> = {};
  for (const spec of SAMPLE_TABLES) {
    const table = await createSeatingTable(w, createTableSchema.parse(spec));
    t[table.label] = table;
  }
  await setRequiredGuestsForTable(t["Head Table"].id, w, HEAD_TABLE_GUESTS.map((k) => g[k].id));

  // Plan 1: before any seating rules -- the older draft.
  const v1 = await generate(w, sideMixing);
  await setPlanVersionLabel(v1, w, "First draft (before the seating rules)");

  for (const [a, b, type] of SAMPLE_RULES) await createRelationship(w, { guestAId: g[a].id, guestBId: g[b].id, type });

  // Plan 2: with the rules -- the current plan, approved.
  const v2 = await generate(w, sideMixing);
  await setPlanVersionLabel(v2, w, "Final plan");
  await setPlanVersionStatus(v2, w, "APPROVED", ownerId);

  // A locked table (keeping who plan 2 seated there) and a guest locked in their seat.
  await updateSeatingTableForWedding(t["Table 2"].id, w, { isLocked: true });
  await updateGuestForWedding(g.nora.id, w, { isLocked: true });

  const entries: Record<string, string> = {};
  for (const [time, description, nextDay] of SAMPLE_TIMELINE) {
    const e = await createTimelineEntry(w, createTimelineEntrySchema.parse({ time, description, nextDay: nextDay ?? false }));
    entries[description] = e.id;
  }

  for (const spec of SAMPLE_VENDORS) await createVendor(w, createVendorSchema.parse(spec));
  await setBudgetForWedding(w, SAMPLE_BUDGET_CENTS);

  // Comment threads (all by the presser -- there's no one else on the wedding), one resolved.
  const c1 = await createComment(w, ownerId, { targetType: "GUEST", guestId: g.elena.id, body: "Can we make sure Grandma Elena is close to the restrooms?" });
  await createComment(w, ownerId, { targetType: "GUEST", body: "Yes, Table 1 is right by the hallway.", parentCommentId: c1.id });
  const c2 = await createComment(w, ownerId, { targetType: "TABLE", tableId: t["Kids' Table"].id, body: "Should the kids' table be near the dance floor?" });
  await createComment(w, ownerId, { targetType: "TABLE", body: "Near it, but not right next to the speakers.", parentCommentId: c2.id });
  await resolveComment(w, c2.id, ownerId, true);
  await createComment(w, ownerId, { targetType: "GUEST", guestId: g.ethan.id, body: "Ethan and Lucas had a falling out. Keep them apart?" });
  await createComment(w, ownerId, { targetType: "TIMELINE_ENTRY", timelineEntryId: entries["Ceremony begins"], body: "The officiant needs 10 minutes before this to set up." });
}

/**
 * TS-272: makes a sample wedding owned by `ownerId` and returns its id. `today` (YYYY-MM-DD, the
 * presser's date) sets the wedding about six months out, with the RSVP cutoff two weeks before.
 * Who may do this is checked by the caller. If any step fails, the wedding is deleted again.
 */
export async function createSampleWedding(ownerId: string, today: string): Promise<string> {
  const eventDate = addDays(today, 182);
  const wedding = await createWedding(
    ownerId,
    createWeddingSchema.parse({
      name: SAMPLE_WEDDING_NAME,
      eventDate,
      venueName: "Lakeside Pavilion",
      note: SAMPLE_WEDDING_NOTE,
      sideMixing: "BALANCED_MIX",
      sideLabel1: "Jamie's side",
      sideLabel2: "Morgan's side",
      rsvpCutoffDate: addDays(eventDate, -14),
    })
  );
  try {
    await fillSampleWedding(wedding.id, ownerId, wedding.sideMixing as EngineSideMixing);
  } catch (err) {
    // PR #120 review: if the half-made wedding can't be deleted, say so -- it's still in the
    // account (and on its dashboard to delete by hand), so the caller keeps it counted.
    const removed = await deleteWeddingForOwner(wedding.id, ownerId).then(() => true, () => false);
    if (!removed) throw new SampleWeddingLeftBehindError(err);
    throw err;
  }
  return wedding.id;
}

/** PR #120 review: making a sample wedding failed and the half-made one couldn't be removed. */
export class SampleWeddingLeftBehindError extends Error {
  constructor(readonly original: unknown) {
    super(`A sample wedding failed part-way and couldn't be removed: ${original instanceof Error ? original.message : String(original)}`);
    this.name = "SampleWeddingLeftBehindError";
  }
}
