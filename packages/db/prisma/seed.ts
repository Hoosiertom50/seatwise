// Local dev seed data.
//
// Why this exists: `npx prisma migrate reset` drops and recreates the database from scratch, and
// this project has no other backup/restore path for local dev data -- so every reset used to leave
// a genuinely empty database (no user, no weddings) with nothing to click through. Wiring this up
// as the project's `prisma.seed` command (see package.json) means `migrate reset` runs it
// automatically right after resetting, so a reset always leaves you with a working demo login and
// some realistic-looking sample data instead of a blank slate. It can also be run on its own at any
// time with `pnpm db:seed`.
//
// This is dev-only sample data, not a fixture used by the Playwright framework or CI -- those have
// their own isolated setup/cleanup (see e2e/fixtures and playwright-framework/tests). Safe to run
// against a non-empty database too: it looks for its demo user by email first and reuses it rather
// than failing on a duplicate, though the two sample weddings are only created the first time (a
// second run just logs that they already exist rather than creating duplicates).

// Must be the very first import -- see load-env.ts for why. It loads packages/db/.env
// (DATABASE_URL, etc.) before the "../src/index" import below reads process.env.DATABASE_URL.
import "./load-env";

import bcrypt from "bcryptjs";
import {
  pool,
  createUser,
  findUserByEmail,
  createWedding,
  createGuest,
  quickCreateSeatingTables,
  createPlanVersionWithAssignments,
  createVendor,
  createTimelineEntry,
} from "../src/index";

const DEMO_EMAIL = "demo@seatwise.test";
const DEMO_PASSWORD = "seatwise-demo";
const DEMO_NAME = "Demo Planner";

async function ensureDemoUser() {
  const existing = await findUserByEmail(DEMO_EMAIL);
  if (existing) {
    console.log(`Demo user already exists (${DEMO_EMAIL}), reusing it.`);
    return existing;
  }
  const passwordHash = await bcrypt.hash(DEMO_PASSWORD, 10);
  const user = await createUser({ email: DEMO_EMAIL, passwordHash, name: DEMO_NAME });
  console.log(`Created demo user: ${DEMO_EMAIL}`);
  return user;
}

async function weddingAlreadySeeded(ownerId: string, name: string): Promise<boolean> {
  const { rows } = await pool.query(
    `SELECT id FROM "weddings" WHERE "ownerId" = $1 AND name = $2 LIMIT 1`,
    [ownerId, name]
  );
  return rows.length > 0;
}

async function seedAlexAndJordan(ownerId: string) {
  const name = "Alex & Jordan's Wedding";
  if (await weddingAlreadySeeded(ownerId, name)) {
    console.log(`"${name}" already exists, skipping.`);
    return;
  }

  const wedding = await createWedding(ownerId, {
    name,
    eventDate: "2026-10-17",
    venueName: "The Grandview Estate",
    note: "Outdoor ceremony, tented reception if it rains.",
    sideMixing: "BALANCED_MIX",
    sideLabel1: "Alex's side",
    sideLabel2: "Jordan's side",
  });

  const guests = await Promise.all([
    createGuest(wedding.id, { firstName: "Priya", lastName: "Nair", tier: "FAMILY", side: "BRIDE", rsvpStatus: "CONFIRMED" }),
    createGuest(wedding.id, { firstName: "Sam", lastName: "Okafor", tier: "FAMILY", side: "BRIDE", rsvpStatus: "CONFIRMED" }),
    createGuest(wedding.id, { firstName: "Lena", lastName: "Cho", tier: "FRIEND", side: "GROOM", rsvpStatus: "CONFIRMED", headcount: 2, plusOneNames: "Marco Diaz" }),
    createGuest(wedding.id, { firstName: "Marco", lastName: "Diaz", tier: "FRIEND", side: "GROOM", rsvpStatus: "PENDING" }),
    createGuest(wedding.id, { firstName: "Ruth", lastName: "Bennett", tier: "VIP", side: "BOTH", rsvpStatus: "CONFIRMED" }),
    createGuest(wedding.id, { firstName: "Theo", lastName: "Bennett", tier: "VIP", side: "BOTH", rsvpStatus: "DECLINED" }),
    createGuest(wedding.id, { firstName: "Ivy", lastName: "Park", tier: "OTHER", side: "BRIDE", rsvpStatus: "PENDING", ageCategory: "CHILD" }),
  ]);

  const tables = await quickCreateSeatingTables(wedding.id, {
    count: 3,
    capacity: 8,
    shape: "ROUND",
    labelPrefix: "Table",
  });

  // Seat most guests, leave a couple unassigned so the portfolio dashboard has something to flag.
  const assignments = [
    { guestId: guests[0].id, tableId: tables[0].id },
    { guestId: guests[1].id, tableId: tables[0].id },
    { guestId: guests[2].id, tableId: tables[1].id },
    { guestId: guests[4].id, tableId: tables[2].id },
  ];
  await createPlanVersionWithAssignments(wedding.id, {
    isComplete: false,
    warnings: [],
    assignments,
    unassignedGuestIds: [guests[3].id, guests[5].id, guests[6].id],
  });

  await createVendor(wedding.id, {
    name: "Grandview Catering Co.",
    category: "CATERING",
    contactEmail: "events@grandviewcatering.example",
    costCents: 850000,
    contractNotes: "50% deposit paid; balance due 30 days out.",
  });
  await createVendor(wedding.id, {
    name: "Bloom & Vine Florals",
    category: "FLORIST",
    costCents: 220000,
  });

  await createTimelineEntry(wedding.id, { time: "15:00", description: "Ceremony begins" });
  await createTimelineEntry(wedding.id, { time: "16:00", description: "Cocktail hour" });
  await createTimelineEntry(wedding.id, { time: "17:30", description: "Reception & dinner" });
  await createTimelineEntry(wedding.id, { time: "20:00", description: "First dance" });

  console.log(`Seeded "${name}" (${guests.length} guests, ${tables.length} tables, 1 plan version, 2 vendors, 4 timeline entries).`);
}

async function seedRiveraKim(ownerId: string) {
  const name = "Rivera–Kim Wedding";
  if (await weddingAlreadySeeded(ownerId, name)) {
    console.log(`"${name}" already exists, skipping.`);
    return;
  }

  const wedding = await createWedding(ownerId, {
    name,
    eventDate: "2027-03-06",
    venueName: "Harbor Pavilion",
    sideMixing: "FULLY_MIXED",
  });

  const guests = await Promise.all([
    createGuest(wedding.id, { firstName: "Dana", lastName: "Rivera", tier: "FAMILY", side: "BRIDE", rsvpStatus: "CONFIRMED" }),
    createGuest(wedding.id, { firstName: "Noah", lastName: "Kim", tier: "FAMILY", side: "GROOM", rsvpStatus: "CONFIRMED" }),
    createGuest(wedding.id, { firstName: "Grace", lastName: "Lund", tier: "FRIEND", side: "BOTH", rsvpStatus: "PENDING" }),
  ]);

  const tables = await quickCreateSeatingTables(wedding.id, {
    count: 1,
    capacity: 10,
    shape: "ROUND",
    labelPrefix: "Table",
  });

  await createPlanVersionWithAssignments(wedding.id, {
    isComplete: false,
    warnings: [],
    assignments: [{ guestId: guests[0].id, tableId: tables[0].id }],
    unassignedGuestIds: [guests[1].id, guests[2].id],
  });

  console.log(`Seeded "${name}" (${guests.length} guests, ${tables.length} table, 1 plan version, still early planning).`);
}

async function main() {
  const user = await ensureDemoUser();
  await seedAlexAndJordan(user.id);
  await seedRiveraKim(user.id);

  console.log("");
  console.log("Seed complete. Log in with:");
  console.log(`  email:    ${DEMO_EMAIL}`);
  console.log(`  password: ${DEMO_PASSWORD}`);
}

main()
  .catch((err) => {
    console.error("Seed failed:", err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await pool.end();
  });
