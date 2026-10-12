// Sample data for a hands-on test of a local production build (Tom's 4-browser + iPhone review,
// 10-08-2026). See docs/local-test-checklist.md for how it's used.
//
// What it makes (all of it on the reserved address domain @demo.seatwise.test -- ".test" can never
// be a real mail domain, and nothing else in the project uses this one: the Playwright suite and
// its cleanup scripts use @example.invalid, and seed.ts uses demo@seatwise.test):
//   - four confirmed accounts: the owner, plus a Couple member (Edit), a Comment collaborator and
//     a View collaborator;
//   - one full wedding that has something on every tab, and a second, nearly empty one for trying
//     Generate and the guest import from scratch (with docs/sample-guest-import.csv).
// Each account gets a fresh random password, printed once to the terminal and never saved anywhere.
//
// Safe to run again: it first deletes every account on @demo.seatwise.test and the weddings they
// own, then makes everything fresh (with new passwords). Nothing else in the database is touched.
// Everything is made through the app's own database functions and checked with the app's own form
// rules, so the data is what the app itself would have saved (revisions, encrypted notes and
// links, email-confirmation dates and so on).
//
// Helpers for a production build, whose email log hides the secret part of every link:
//   --confirm-link <email>   prints a fresh "confirm your email" link for that account
//   --reset-link <email>     prints a fresh password-reset link for that account
//   --invite-link <email>    re-sends (replaces) the pending invite to that address and prints its link
// These make the same links the app's own emails carry, for any account in the local database.
//
//   pnpm db:local-test-data                         # (re)make the sample data
//   pnpm db:local-test-data --reset-link you@x.com  # one of the helpers above
//
// Local databases only (local-only.ts) -- the passwords it prints would otherwise be live ones.
import "./local-only";
import { randomInt } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parse as parseEnvFile } from "dotenv";
import bcrypt from "bcryptjs";
import {
  createWeddingSchema,
  createGuestSchema,
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
import {
  pool,
  createUser,
  findUserByEmail,
  createEmailVerificationToken,
  verifyEmailWithToken,
  createPasswordResetToken,
  createWedding,
  createGuest,
  updateGuestForWedding,
  createSeatingTable,
  updateSeatingTableForWedding,
  setRequiredGuestsForTable,
  quickCreateSeatingTables,
  listGuestsByWedding,
  listRelationshipsForWedding,
  listSeatingTablesForWedding,
  getLatestAssignmentsForWedding,
  createRelationship,
  createPlanVersionWithAssignments,
  setPlanVersionLabel,
  setPlanVersionStatus,
  getPlanVersionDetail,
  addCollaborator,
  createInvite,
  createTimelineEntry,
  createVendor,
  setBudgetForWedding,
  ensureVendorShareToken,
  ensureGuestRsvpToken,
  submitGuestRsvp,
  createComment,
  resolveComment,
  notifyWeddingCollaborators,
  listNotificationsForUser,
  markNotificationRead,
  classifyGuestImport,
  type GuestRow,
  type SeatingTableRow,
} from "../src/index";

// Emails the sample data sets off (comment notifications) are printed, never sent -- whatever
// mail settings the environment has. Read when each email goes out, so setting it here is in time.
process.env.EMAIL_TRANSPORT = "log";

// The web app's own settings (apps/web/.env*, in the order a production build reads them). The
// app's ENCRYPTION_KEY is the one that must lock guest notes and RSVP/vendor links, or the app
// shows them as "[unable to decrypt]" -- and packages/db/.env may hold a different one. (The key
// is read when the first note is locked, so settling it here, after the imports, is in time.)
const WEB_DIR = path.join(__dirname, "..", "..", "..", "apps", "web");
const DB_ENV_FILE = path.join(__dirname, "..", ".env");
function readEnvFile(file: string): Record<string, string> {
  try {
    return parseEnvFile(fs.readFileSync(file));
  } catch {
    return {};
  }
}
function webSetting(name: string): string | undefined {
  for (const file of [".env.production.local", ".env.local", ".env.production", ".env"]) {
    const value = readEnvFile(path.join(WEB_DIR, file))[name];
    if (value !== undefined) return value;
  }
  return undefined;
}
const notes: string[] = [];
{
  const fromDbFile = readEnvFile(DB_ENV_FILE).ENCRYPTION_KEY;
  const current = process.env.ENCRYPTION_KEY;
  const webKey = webSetting("ENCRYPTION_KEY");
  // A key exported in the shell is what `next start` would use too, so it's kept. Otherwise the
  // web app's own key is used (the value from packages/db/.env is only a fallback).
  if (webKey && (current === undefined || current === fromDbFile) && webKey !== current) {
    process.env.ENCRYPTION_KEY = webKey;
    notes.push("Used the web app's ENCRYPTION_KEY (from apps/web/.env*), so guest notes and links read back in the app.");
  }
  const webDb = webSetting("DATABASE_URL");
  if (webDb && webDb !== process.env.DATABASE_URL) {
    notes.push("WARNING: apps/web/.env points at a different DATABASE_URL than this script used -- the app won't see this data.");
  }
}


const DEMO_DOMAIN = "demo.seatwise.test";
const demoEmail = (local: string) => `${local}@${DEMO_DOMAIN}`;
const SAMPLE_CSV = path.resolve(__dirname, "..", "..", "..", "docs", "sample-guest-import.csv");

// The address the app runs at (what its links use), and the Mac's address on the Wi-Fi for the iPhone.
const APP_URL = (process.env.APP_URL || webSetting("APP_URL") || "http://localhost:3000").replace(/\/+$/, "");
function lanAddress(): string | null {
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list ?? []) {
      if (a.family === "IPv4" && !a.internal && /^(10|172\.(1[6-9]|2\d|3[01])|192\.168)\./.test(a.address)) return a.address;
    }
  }
  return null;
}

// Emails set off along the way are counted rather than printed, so the sign-in details stay readable.
let emailsLogged = 0;
const plainLog = console.log.bind(console);
console.log = (...args: unknown[]) => {
  if (typeof args[0] === "string" && args[0].startsWith("[email-log]")) {
    emailsLogged++;
    return;
  }
  plainLog(...args);
};

// Easy to type on a phone: no 0/O, 1/l/I look-alikes, in three groups of four.
function newPassword(): string {
  const alphabet = "abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const group = () => Array.from({ length: 4 }, () => alphabet[randomInt(alphabet.length)]).join("");
  return `${group()}-${group()}-${group()}`;
}

// ---------------------------------------------------------------------------------------------
// Helpers for a production build (see the top of the file)

async function printLinkFor(kind: string, email: string): Promise<void> {
  if (kind === "--invite-link") {
    const { rows } = await pool.query(
      `SELECT i."weddingId", i.role, i."permissionLevel", w."ownerId", w.name FROM "wedding_invites" i
       JOIN "weddings" w ON w.id = i."weddingId"
       WHERE lower(i.email) = lower($1) AND i.status = 'PENDING' ORDER BY i."createdAt" DESC LIMIT 1`,
      [email]
    );
    const invite = rows[0];
    if (!invite) throw new Error(`No pending invite to ${email}.`);
    const fresh = await createInvite(invite.weddingId, invite.ownerId, email, invite.permissionLevel, invite.role);
    plainLog(`Invite to "${invite.name}" for ${email} (the earlier link for it no longer works):`);
    plainLog(`  ${APP_URL}/invites/${fresh.token}`);
    return;
  }
  const user = await findUserByEmail(email);
  if (!user) throw new Error(`No account with the email ${email}.`);
  if (kind === "--confirm-link") {
    plainLog(`Confirm-your-email link for ${user.email} (works once, for 48 hours):`);
    plainLog(`  ${APP_URL}/verify-email/${await createEmailVerificationToken(user.id)}`);
  } else {
    plainLog(`Password-reset link for ${user.email} (works once, for 60 minutes):`);
    plainLog(`  ${APP_URL}/reset-password/${await createPasswordResetToken(user.id)}`);
  }
}

// ---------------------------------------------------------------------------------------------
// Removing the last run's data

async function removeDemoData(): Promise<void> {
  const { rows: users } = await pool.query<{ id: string }>(`SELECT id FROM "users" WHERE email LIKE '%@' || $1`, [DEMO_DOMAIN]);
  if (users.length === 0) return;
  const ids = users.map((u) => u.id);
  // Every row under a wedding is deleted with it (onDelete: Cascade); a wedding's owner can't be
  // deleted while it has weddings, so those go first. Weddings only owned by these accounts.
  const { rows: weddings } = await pool.query<{ name: string }>(`DELETE FROM "weddings" WHERE "ownerId" = ANY($1) RETURNING name`, [ids]);
  await pool.query(`DELETE FROM "users" WHERE id = ANY($1)`, [ids]);
  plainLog(`Removed the last run's sample data: ${users.length} account(s), ${weddings.length} wedding(s).`);
}

// ---------------------------------------------------------------------------------------------
// Accounts

interface Account {
  id: string;
  name: string;
  email: string;
  password: string;
  what: string;
}

async function makeAccount(name: string, local: string, what: string): Promise<Account> {
  const email = demoEmail(local);
  const password = newPassword();
  const user = await createUser({ email, passwordHash: await bcrypt.hash(password, 10), name });
  // Confirmed the way the app does it: a confirmation link, used.
  if (!(await verifyEmailWithToken(await createEmailVerificationToken(user.id)))) throw new Error(`Couldn't confirm ${email}.`);
  return { id: user.id, name, email, password, what };
}

// ---------------------------------------------------------------------------------------------
// Generate, the way the Seating plan tab's Generate button does it (plan-versions/generate route)

async function generate(weddingId: string, sideMixing: EngineSideMixing, makeCurrent: boolean): Promise<string> {
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
  if (result.errors.length > 0) throw new Error(`Generate refused: ${result.errors.join("; ")}`);
  const { planVersionId } = await createPlanVersionWithAssignments(weddingId, {
    isComplete: result.isComplete,
    warnings: result.warnings,
    assignments: result.assignments,
    unassignedGuestIds: result.unassignedGuestIds,
    sideMixingSetting: sideMixing,
    ruleConfigVersion: RULE_WEIGHT_CONFIG_VERSION,
    makeCurrent,
  });
  return planVersionId;
}

// ---------------------------------------------------------------------------------------------
// The full wedding

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
  email?: string;
  notes?: string;
};

// About 60 guests (68 people with plus-ones) across both sides. Declined guests are also marked
// Not attending, as the app does when an answer changes to Declined.
const GUESTS: GuestSpec[] = [
  // Jamie's side
  { key: "rosa", first: "Rosa", last: "Rivera", side: "BRIDE", tier: "VIP", rsvp: "CONFIRMED", household: "Rivera Family", email: "rosa.rivera", notes: "Mother of the bride. Giving the first toast." },
  { key: "hector", first: "Hector", last: "Rivera", side: "BRIDE", tier: "VIP", rsvp: "CONFIRMED", household: "Rivera Family" },
  { key: "lucia", first: "Lucía", last: "Rivera", side: "BRIDE", tier: "FAMILY", rsvp: "CONFIRMED", household: "Rivera Family" },
  { key: "mateo", first: "Mateo", last: "Rivera", side: "BRIDE", tier: "FAMILY", rsvp: "CONFIRMED", household: "Rivera Family", age: "CHILD" },
  { key: "sofia", first: "Sofía", last: "Rivera", side: "BRIDE", tier: "FAMILY", rsvp: "CONFIRMED", household: "Rivera Family", age: "INFANT", notes: "Needs a high chair." },
  { key: "carmen", first: "Carmen", last: "Delgado", side: "BRIDE", tier: "FAMILY", rsvp: "CONFIRMED", household: "Delgado Household", accessible: true, notes: "Uses a wheelchair." },
  { key: "luis", first: "Luis", last: "Delgado", side: "BRIDE", tier: "FAMILY", rsvp: "CONFIRMED", household: "Delgado Household" },
  { key: "isabel", first: "Isabel", last: "Ortiz", side: "BRIDE", tier: "FAMILY", rsvp: "CONFIRMED", plusOnes: ["Marco Ortiz"], email: "isabel.ortiz" },
  { key: "elena", first: "Elena", last: "Vargas", side: "BRIDE", tier: "VIP", rsvp: "CONFIRMED", accessible: true, notes: "Grandmother. Seat near the exit; low-sodium meal." },
  { key: "ana", first: "Ana", last: "Torres", side: "BRIDE", tier: "FRIEND", rsvp: "CONFIRMED", plusOnes: ["Ben Carter"] },
  { key: "maya", first: "Maya", last: "Chen", side: "BRIDE", tier: "FRIEND", rsvp: "CONFIRMED", notes: "Maid of honor." },
  { key: "priya", first: "Priya", last: "Natarajan", side: "BRIDE", tier: "FRIEND", rsvp: "CONFIRMED" },
  { key: "olivia", first: "Olivia", last: "Brooks", side: "BRIDE", tier: "FRIEND", rsvp: "CONFIRMED" },
  { key: "hannah", first: "Hannah", last: "Lee", side: "BRIDE", tier: "FRIEND", rsvp: "PENDING", email: "hannah.lee" },
  { key: "jordan", first: "Jordan", last: "Blake", side: "BRIDE", tier: "PLUS_ONE", rsvp: "PENDING", notes: "Hannah's date." },
  { key: "grace", first: "Grace", last: "Kim", side: "BRIDE", tier: "FRIEND", rsvp: "DECLINED" },
  { key: "chloe", first: "Chloe", last: "Martin", side: "BRIDE", tier: "FRIEND", rsvp: "CONFIRMED", plusOnes: ["Ryan Martin"] },
  { key: "emma", first: "Emma", last: "Wilson", side: "BRIDE", tier: "FRIEND", rsvp: "PENDING" },
  { key: "zoe", first: "Zoe", last: "Adams", side: "BRIDE", tier: "FRIEND", rsvp: "CONFIRMED" },
  { key: "leah", first: "Leah", last: "Patel", side: "BRIDE", tier: "OTHER", rsvp: "CONFIRMED", household: "Bright Labs team" },
  { key: "nina", first: "Nina", last: "Shah", side: "BRIDE", tier: "OTHER", rsvp: "PENDING", household: "Bright Labs team" },
  { key: "daniel", first: "Daniel", last: "Gómez", side: "BRIDE", tier: "FAMILY", rsvp: "CONFIRMED", household: "Gómez Family" },
  { key: "paula", first: "Paula", last: "Gómez", side: "BRIDE", tier: "FAMILY", rsvp: "CONFIRMED", household: "Gómez Family" },
  { key: "ella", first: "Ella", last: "Gómez", side: "BRIDE", tier: "FAMILY", rsvp: "CONFIRMED", household: "Gómez Family", age: "CHILD" },
  { key: "leo", first: "Leo", last: "Gómez", side: "BRIDE", tier: "FAMILY", rsvp: "CONFIRMED", household: "Gómez Family", age: "CHILD", notes: "Peanut allergy." },
  { key: "teresa", first: "Teresa", last: "Morales", side: "BRIDE", tier: "FAMILY", rsvp: "DECLINED", notes: "Traveling abroad that week." },
  { key: "victor", first: "Victor", last: "Morales", side: "BRIDE", tier: "FAMILY", rsvp: "PENDING", email: "victor.morales" },
  { key: "diego", first: "Diego", last: "Ramos", side: "BRIDE", tier: "FRIEND", rsvp: "CONFIRMED" },
  { key: "lily", first: "Lily", last: "Evans", side: "BRIDE", tier: "FRIEND", rsvp: "CONFIRMED" },
  { key: "ruby", first: "Ruby", last: "Clarke", side: "BRIDE", tier: "OTHER", rsvp: "CONFIRMED" },
  // Morgan's side
  { key: "margaret", first: "Margaret", last: "Ellis", side: "GROOM", tier: "VIP", rsvp: "CONFIRMED", household: "Ellis Family", email: "margaret.ellis" },
  { key: "richard", first: "Richard", last: "Ellis", side: "GROOM", tier: "VIP", rsvp: "CONFIRMED", household: "Ellis Family" },
  { key: "claire", first: "Claire", last: "Ellis", side: "GROOM", tier: "FAMILY", rsvp: "CONFIRMED", household: "Ellis Family" },
  { key: "owen", first: "Owen", last: "Ellis", side: "GROOM", tier: "FAMILY", rsvp: "CONFIRMED", household: "Ellis Family", age: "CHILD" },
  { key: "walter", first: "Walter", last: "Ellis", side: "GROOM", tier: "VIP", rsvp: "CONFIRMED", accessible: true, notes: "Hard of hearing. Seat away from the speakers." },
  { key: "fiona", first: "Fiona", last: "Byrne", side: "GROOM", tier: "FAMILY", rsvp: "CONFIRMED", household: "Byrne Family" },
  { key: "patrick", first: "Patrick", last: "Byrne", side: "GROOM", tier: "FAMILY", rsvp: "CONFIRMED", household: "Byrne Family" },
  { key: "aidan", first: "Aidan", last: "Byrne", side: "GROOM", tier: "FAMILY", rsvp: "CONFIRMED", household: "Byrne Family", age: "CHILD" },
  { key: "noah", first: "Noah", last: "Bennett", side: "GROOM", tier: "FRIEND", rsvp: "CONFIRMED", plusOnes: ["Ava Bennett"] },
  { key: "ethan", first: "Ethan", last: "Clark", side: "GROOM", tier: "FRIEND", rsvp: "CONFIRMED" },
  { key: "lucas", first: "Lucas", last: "Hall", side: "GROOM", tier: "FRIEND", rsvp: "CONFIRMED" },
  { key: "mason", first: "Mason", last: "Young", side: "GROOM", tier: "FRIEND", rsvp: "PENDING", email: "mason.young" },
  { key: "logan", first: "Logan", last: "Wright", side: "GROOM", tier: "FRIEND", rsvp: "CONFIRMED" },
  { key: "jack", first: "Jack", last: "Turner", side: "GROOM", tier: "FRIEND", rsvp: "CONFIRMED" },
  { key: "henry", first: "Henry", last: "Scott", side: "GROOM", tier: "FRIEND", rsvp: "CONFIRMED", notes: "Best man." },
  { key: "samuel", first: "Samuel", last: "Green", side: "GROOM", tier: "FRIEND", rsvp: "CONFIRMED" },
  { key: "benjamin", first: "Benjamin", last: "Adams", side: "GROOM", tier: "FRIEND", rsvp: "DECLINED" },
  { key: "dan", first: "Dan", last: "Baker", side: "GROOM", tier: "OTHER", rsvp: "CONFIRMED", email: "dan.baker" },
  { key: "matthew", first: "Matthew", last: "Nelson", side: "GROOM", tier: "OTHER", rsvp: "PENDING" },
  { key: "david", first: "David", last: "Carter", side: "GROOM", tier: "OTHER", rsvp: "CONFIRMED", plusOnes: ["Sarah Carter"] },
  { key: "james", first: "James", last: "Mitchell", side: "GROOM", tier: "FRIEND", rsvp: "CONFIRMED" },
  { key: "andrew", first: "Andrew", last: "Pérez", side: "GROOM", tier: "FRIEND", rsvp: "CONFIRMED" },
  { key: "joseph", first: "Joseph", last: "Roberts", side: "GROOM", tier: "OTHER", rsvp: "PENDING" },
  { key: "thomas", first: "Thomas", last: "Murphy", side: "GROOM", tier: "FAMILY", rsvp: "CONFIRMED", household: "Murphy Family" },
  { key: "kevin", first: "Kevin", last: "Murphy", side: "GROOM", tier: "FAMILY", rsvp: "CONFIRMED", household: "Murphy Family" },
  { key: "brian", first: "Brian", last: "Cook", side: "GROOM", tier: "FRIEND", rsvp: "DECLINED", notes: "Said no on the phone." },
  // Both sides
  { key: "michael", first: "Michael", last: "O'Brien", side: "BOTH", tier: "VIP", rsvp: "CONFIRMED", notes: "Officiant." },
  { key: "rachel", first: "Rachel", last: "Price", side: "BOTH", tier: "OTHER", rsvp: "CONFIRMED" },
  { key: "alex", first: "Alex", last: "Morgan-Lee", side: "BOTH", tier: "FRIEND", rsvp: "CONFIRMED", household: "Morgan-Lee household", plusOnes: ["Jess Morgan-Lee", "Riley Morgan-Lee"] },
  { key: "sam", first: "Sam", last: "Taylor", side: "BOTH", tier: "FRIEND", rsvp: "PENDING" },
  { key: "nora", first: "Nora", last: "Fitzgerald", side: "BOTH", tier: "OTHER", rsvp: "CONFIRMED", notes: "Locked in place: sits with the band crew." },
];

async function makeFullWedding(owner: Account, couple: Account, commenter: Account, viewer: Account) {
  const weddingInput = createWeddingSchema.parse({
    name: "Jamie & Morgan's Wedding",
    eventDate: "2026-11-14",
    venueName: "Lakeside Pavilion",
    // The owner-only note (only the owner sees it -- and whoever the wedding is handed off to).
    note: "Owner-only note: venue balance due 10-30-2026. Keep the head table to 8.",
    sideMixing: "BALANCED_MIX",
    sideLabel1: "Jamie's side",
    sideLabel2: "Morgan's side",
    rsvpCutoffDate: "2026-11-01",
  });
  const wedding = await createWedding(owner.id, weddingInput);
  const w = wedding.id;
  const sideMixing = wedding.sideMixing as EngineSideMixing;

  // Access: a Couple member with Edit, a Comment and a View collaborator, and an invite still pending.
  await addCollaborator(w, owner.id, couple.email, "EDIT", "COUPLE");
  await addCollaborator(w, owner.id, commenter.email, "COMMENT", "COLLABORATOR");
  await addCollaborator(w, owner.id, viewer.email, "VIEW", "COLLABORATOR");
  const invite = await createInvite(w, owner.id, demoEmail("new.helper"), "EDIT", "COLLABORATOR");

  // Guests
  const g: Record<string, GuestRow> = {};
  for (const s of GUESTS) {
    const declined = s.rsvp === "DECLINED";
    const input = createGuestSchema.parse({
      firstName: s.first,
      lastName: s.last,
      partyName: s.household ?? null,
      headcount: 1 + (s.plusOnes?.length ?? 0),
      tier: s.tier,
      rsvpStatus: s.rsvp ?? "PENDING",
      requiresAccessibleTable: s.accessible ?? false,
      dayOfAttendance: declined ? "NOT_ATTENDING" : "ATTENDING",
      notes: s.notes ?? null,
      side: s.side,
      ageCategory: s.age ?? "ADULT",
      email: s.email ? demoEmail(s.email) : null,
      plusOneNames: s.plusOnes?.join(", ") ?? null,
    });
    g[s.key] = await createGuest(w, input);
  }

  // Tables: accessible, Restricted (with its required guests), Single-Side-Only, two with a
  // Purpose, plain ones -- and Table 2 is locked once plan 2 has seated people there.
  const tableSpecs: Array<Record<string, unknown>> = [
    { label: "Head Table", capacity: 8, shape: "RECTANGULAR", isRestricted: true, purpose: "Family of the couple and the officiant" },
    { label: "Table 1", capacity: 10, shape: "ROUND", isAccessible: true },
    { label: "Table 2", capacity: 10, shape: "ROUND" },
    { label: "Family Table", capacity: 10, shape: "ROUND", singleSideOnly: true },
    { label: "Kids' Table", capacity: 8, shape: "SQUARE", purpose: "Kids' table, near the parents", purposeCriterionType: "AGE_CATEGORY", purposeCriterionValue: "CHILD" },
    { label: "Friends Table", capacity: 10, shape: "ROUND", purpose: "College friends", purposeCriterionType: "TIER", purposeCriterionValue: "FRIEND" },
    { label: "Table 3", capacity: 10, shape: "ROUND" },
    { label: "Table 4", capacity: 10, shape: "OVAL" },
  ];
  const t: Record<string, SeatingTableRow> = {};
  for (const spec of tableSpecs) {
    const table = await createSeatingTable(w, createTableSchema.parse(spec));
    t[table.label] = table;
  }
  await setRequiredGuestsForTable(t["Head Table"].id, w, ["rosa", "hector", "margaret", "richard", "michael", "rachel"].map((k) => g[k].id));

  // Plan 1: generated before any seating rules -- the older draft.
  const v1 = await generate(w, sideMixing, true);
  await setPlanVersionLabel(v1, w, "First draft (before the seating rules)");

  // Seating rules of every kind, including a chain of "must sit together".
  const rules: Array<[string, string, "MUST_SIT_TOGETHER" | "MUST_NOT_SIT_TOGETHER" | "AVOID" | "PREFER_NEAR"]> = [
    ["maya", "priya", "MUST_SIT_TOGETHER"],
    ["priya", "olivia", "MUST_SIT_TOGETHER"],
    ["carmen", "luis", "MUST_SIT_TOGETHER"],
    ["ethan", "lucas", "MUST_NOT_SIT_TOGETHER"],
    ["logan", "jack", "AVOID"],
    ["henry", "samuel", "PREFER_NEAR"],
    ["hannah", "jordan", "PREFER_NEAR"],
  ];
  for (const [a, b, type] of rules) await createRelationship(w, { guestAId: g[a].id, guestBId: g[b].id, type });

  // Plan 2: with the rules -- the current plan, approved.
  const v2 = await generate(w, sideMixing, true);
  await setPlanVersionLabel(v2, w, "Final plan");
  let approved = true;
  try {
    await setPlanVersionStatus(v2, w, "APPROVED", owner.id);
  } catch (err) {
    approved = false;
    notes.push(`WARNING: plan 2 couldn't be approved (${(err as Error).message}).`);
  }

  // Lock Table 2 (keeping the guests plan 2 seated there) and one guest in their seat. Done after
  // plan 2, so the approved plan seats everyone and the next Generate shows what a lock keeps.
  await updateSeatingTableForWedding(t["Table 2"].id, w, { isLocked: true });
  await updateGuestForWedding(g.nora.id, w, { isLocked: true });

  // Plan 3: a comparison draft -- plan 2 with one guest moved to another plain table (or two
  // swapped, when there's no free seat), so Compare has something to show.
  const v2detail = await getPlanVersionDetail(v2, w);
  const inRules = new Set(rules.flatMap(([a, b]) => [g[a].id, g[b].id]));
  const byId = new Map(Object.values(g).map((x) => [x.id, x]));
  const seats = v2detail?.assignments ?? [];
  const movable = (tableId: string) =>
    seats.find((a) => {
      const guest = byId.get(a.guestId);
      return a.tableId === tableId && !inRules.has(a.guestId) && guest?.headcount === 1 && guest.ageCategory === "ADULT" && a.guestId !== g.nora.id;
    });
  const used = (tableId: string) => seats.filter((a) => a.tableId === tableId).reduce((n, a) => n + (byId.get(a.guestId)?.headcount ?? 1), 0);
  const plain = ["Table 3", "Table 4", "Friends Table", "Family Table"].map((label) => t[label]);
  let change: { moves: Map<string, string>; label: string } | null = null;
  for (const from of plain) {
    const mover = movable(from.id);
    if (!mover || change) continue;
    for (const to of plain) {
      if (to === from) continue;
      if (used(to.id) < to.capacity) {
        change = { moves: new Map([[mover.guestId, to.id]]), label: `${mover.guestName} moved to ${to.label}` };
        break;
      }
      const other = movable(to.id);
      if (other) {
        change = { moves: new Map([[mover.guestId, to.id], [other.guestId, from.id]]), label: `${mover.guestName} and ${other.guestName} swapped` };
        break;
      }
    }
  }
  let v3: string;
  if (v2detail && change) {
    const moves = change.moves;
    ({ planVersionId: v3 } = await createPlanVersionWithAssignments(w, {
      isComplete: v2detail.isComplete,
      warnings: [],
      assignments: seats.map((a) => ({ guestId: a.guestId, tableId: moves.get(a.guestId) ?? a.tableId })),
      unassignedGuestIds: v2detail.unassignedGuestIds,
      sideMixingSetting: sideMixing,
      ruleConfigVersion: RULE_WEIGHT_CONFIG_VERSION,
      makeCurrent: false,
    }));
    await setPlanVersionLabel(v3, w, `Comparison: ${change.label}`);
  } else {
    v3 = await generate(w, sideMixing, false);
    await setPlanVersionLabel(v3, w, "Comparison draft");
  }

  // Timeline, with one entry after midnight.
  const timeline: Array<[string, string, boolean?]> = [
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
  const entries: Record<string, string> = {};
  for (const [time, description, nextDay] of timeline) {
    const e = await createTimelineEntry(w, createTimelineEntrySchema.parse({ time, description, nextDay: nextDay ?? false }));
    entries[description] = e.id;
  }

  // Vendors: costs, an "Other" category, arrival times (one before 5 AM, so it shows as the next
  // day), one with no cost -- and a budget.
  const vendorSpecs: Array<Record<string, unknown>> = [
    { name: "Harvest Table Catering", category: "CATERING", contactName: "Dana Hughes", contactEmail: demoEmail("dana.hughes"), contactPhone: "(317) 555-0142", costCents: 1250000, arrivalTime: "14:00", contractNotes: "Final headcount due 11-01-2026. 50% deposit paid." },
    { name: "Lakeside Pavilion", category: "VENUE", contactName: "Marcus Lane", contactPhone: "317-555-0199 ext. 4", costCents: 600000, arrivalTime: "09:00" },
    { name: "Petal & Stem", category: "FLORIST", costCents: 280000, arrivalTime: "12:30" },
    { name: "Golden Hour Photography", category: "PHOTOGRAPHY", contactName: "Ines Park", costCents: 350000, arrivalTime: "13:00" },
    { name: "DJ Nova", category: "MUSIC_ENTERTAINMENT", costCents: 150000, arrivalTime: "15:30", contractNotes: "Keep the speakers away from Table 1." },
    { name: "Snap Happy Booth", category: "OTHER", categoryOther: "Photo booth", costCents: 80000, arrivalTime: "18:30" },
    { name: "Midnight Shuttle Co.", category: "TRANSPORTATION", costCents: 45000, arrivalTime: "01:30", contractNotes: "Two runs back to the hotel after midnight." },
    { name: "Sweet Layers Bakery", category: "CAKE_BAKERY" },
  ];
  const vendors: Record<string, string> = {};
  for (const spec of vendorSpecs) {
    const v = await createVendor(w, createVendorSchema.parse(spec));
    vendors[v.name] = v.id;
  }
  const vendorToken = await ensureVendorShareToken(vendors["Harvest Table Catering"], w);
  await setBudgetForWedding(w, 3500000);

  // RSVP links for a few guests; Hannah has already answered through hers.
  const rsvpTokens: Record<string, string> = {};
  for (const key of ["hannah", "victor", "isabel", "mason"]) rsvpTokens[key] = (await ensureGuestRsvpToken(g[key].id, w))!;
  const answered = await submitGuestRsvp(rsvpTokens.hannah, {
    rsvpStatus: "CONFIRMED",
    headcount: 1,
    rsvpNotes: "Can't wait! Vegetarian meal, please.",
  });
  await notifyWeddingCollaborators(w, null, "RSVP_RECEIVED", `${answered.firstName} ${answered.lastName} is coming.`);

  // Comment threads with replies (each one notifies the others), one resolved.
  const c1 = await createComment(w, couple.id, { targetType: "GUEST", guestId: g.elena.id, body: "Can we make sure Grandma Elena is close to the restrooms?" });
  await createComment(w, owner.id, { targetType: "GUEST", body: "Yes, Table 1 is right by the hallway.", parentCommentId: c1.id });
  const c2 = await createComment(w, commenter.id, { targetType: "TABLE", tableId: t["Kids' Table"].id, body: "Should the kids' table be near the dance floor?" });
  await createComment(w, couple.id, { targetType: "TABLE", body: "Near it, but not right next to the speakers.", parentCommentId: c2.id });
  await resolveComment(w, c2.id, owner.id, true);
  const c3 = await createComment(w, commenter.id, { targetType: "GUEST", guestId: g.ethan.id, body: "Ethan and Lucas had a falling out. Keep them apart?" });
  await createComment(w, owner.id, { targetType: "GUEST", body: "Done: there's a must-not-sit-together rule now.", parentCommentId: c3.id });
  await createComment(w, owner.id, { targetType: "TIMELINE_ENTRY", timelineEntryId: entries["Ceremony begins"], body: "The officiant needs 10 minutes before this to set up." });

  // One of the owner's notifications already read, the rest unread.
  const ownerNotifications = await listNotificationsForUser(owner.id);
  if (ownerNotifications.length > 0) await markNotificationRead(ownerNotifications[ownerNotifications.length - 1].id, owner.id);

  const guests = await listGuestsByWedding(w);
  return {
    name: wedding.name,
    guestCount: guests.length,
    people: guests.reduce((n, x) => n + x.headcount, 0),
    approved,
    planIds: [v1, v2, v3],
    inviteToken: invite.token,
    vendorToken,
    rsvpTokens,
    guestNames: Object.fromEntries(Object.entries(g).map(([k, x]) => [k, `${x.firstName} ${x.lastName}`])),
  };
}

// ---------------------------------------------------------------------------------------------
// The nearly empty wedding, for Generate and the guest import from scratch

async function makeEmptyWedding(owner: Account) {
  const wedding = await createWedding(
    owner.id,
    createWeddingSchema.parse({ name: "Taylor & Quinn's Wedding", eventDate: "2027-05-22", venueName: "Old Mill Barn" })
  );
  await quickCreateSeatingTables(wedding.id, { count: 4, capacity: 8, shape: "ROUND", labelPrefix: "Table" });
  // The sample file, checked by the import's own preview (nothing is imported).
  const csv = fs.readFileSync(SAMPLE_CSV, "utf8");
  const preview = await classifyGuestImport(wedding.id, csv, {
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
  });
  if (preview.summary.errorCount > 0) {
    const bad = preview.rows.filter((r) => r.kind === "error").map((r) => `row ${r.rowNumber}: ${r.reason}`);
    notes.push(`WARNING: the sample file has rows the import refuses: ${bad.join("; ")}`);
  }
  return { name: wedding.name, csvRows: preview.summary.totalRows, csvNew: preview.summary.newCount };
}

// ---------------------------------------------------------------------------------------------

async function main() {
  const helper = ["--confirm-link", "--reset-link", "--invite-link"].find((flag) => process.argv.includes(flag));
  if (helper) {
    const email = process.argv[process.argv.indexOf(helper) + 1];
    if (!email || email.startsWith("--")) throw new Error(`Give the email address after ${helper}.`);
    await printLinkFor(helper, email);
    return;
  }

  await removeDemoData();
  const owner = await makeAccount("Morgan Ellis", "owner", "Owner of both weddings");
  const couple = await makeAccount("Jamie Rivera", "couple", "Couple member, Edit access");
  const commenter = await makeAccount("Priya Shah", "commenter", "Collaborator, Comment access");
  const viewer = await makeAccount("Lee Okafor", "viewer", "Collaborator, View access");

  const full = await makeFullWedding(owner, couple, commenter, viewer);
  const empty = await makeEmptyWedding(owner);

  const lan = lanAddress();
  const line = "-".repeat(78);
  plainLog(`\n${line}\nSample data for the local test is ready. Write these down -- the passwords aren't saved anywhere\nand change every time this script runs.\n${line}`);
  for (const a of [owner, couple, commenter, viewer]) {
    plainLog(`  ${a.email.padEnd(34)} ${a.password}   ${a.name} -- ${a.what}`);
  }
  plainLog(`\nWeddings (both owned by ${owner.email}):`);
  plainLog(`  "${full.name}": ${full.guestCount} guests (${full.people} people), 8 tables, 3 plan versions` +
    `${full.approved ? " (plan 2 approved and current)" : ""}, timeline, vendors, budget, comments.`);
  plainLog(`  "${empty.name}": 4 empty tables, no guests -- for Import and Generate from scratch.`);
  plainLog(`\nLinks (on the iPhone, use ${lan ? `http://${lan}:${new URL(APP_URL).port || "80"}` : "the Mac's Wi-Fi address"} in place of ${new URL(APP_URL).origin}):`);
  plainLog(`  App:                          ${APP_URL}/login`);
  plainLog(`  RSVP link, ${full.guestNames.victor} (pending):    ${APP_URL}/rsvp/${full.rsvpTokens.victor}`);
  plainLog(`  RSVP link, ${full.guestNames.isabel} (party of 2):  ${APP_URL}/rsvp/${full.rsvpTokens.isabel}`);
  plainLog(`  RSVP link, ${full.guestNames.hannah} (answered):      ${APP_URL}/rsvp/${full.rsvpTokens.hannah}`);
  plainLog(`  Vendor page, Harvest Table Catering:  ${APP_URL}/vendor/${full.vendorToken}`);
  plainLog(`  Pending invite for ${demoEmail("new.helper")} (Edit): ${APP_URL}/invites/${full.inviteToken}`);
  plainLog(`\nSample guest file for Import (${empty.csvRows} rows, ${empty.csvNew} ready to add): ${SAMPLE_CSV}`);
  plainLog(`\nLinks the production build's email log hides ([hidden]) -- run from the repo folder:`);
  plainLog(`  pnpm db:local-test-data --confirm-link <email>   pnpm db:local-test-data --reset-link <email>`);
  plainLog(`  pnpm db:local-test-data --invite-link <email>`);
  if (emailsLogged > 0) plainLog(`\n(${emailsLogged} notification email(s) the sample comments set off were printed-only, not sent.)`);
  for (const n of notes) plainLog(`\n${n}`);
  plainLog(line);
}

main()
  .catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
