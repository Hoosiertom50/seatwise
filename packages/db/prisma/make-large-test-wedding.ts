// TS-245: makes a test wedding at the size caps (2,000 guests, 300 tables -- see wedding-caps.ts),
// to time Generate and Approve at that size before sharing the app. Local databases only
// (local-only.ts): it refuses to run against anything else, whatever it's passed.
//
//   pnpm --filter @seatwise/db make-large-test-wedding -- --owner you@example.com
//   pnpm --filter @seatwise/db make-large-test-wedding -- --owner you@example.com --csv ~/large-guests.csv
//
// --owner is the email of an account that already exists in the local database; the wedding is
// added to that account. --csv also writes the same 2,000 guests as a spreadsheet the Guests tab
// can import -- that's how to build the same wedding on a Neon test branch (see the README's
// publish steps), since this script never connects to Neon.
import "./local-only";
import { writeFileSync } from "node:fs";
import { pool, findUserByEmail, createWedding, createGuest, quickCreateSeatingTables } from "../src/index";

const GUESTS = 2_000;
const TABLES = 300;
const TABLES_PER_QUICK_CREATE = 100; // the most one quick-create makes
const TABLE_CAPACITY = 8; // 2,400 seats for 2,000 guests
const WEDDING_NAME = "Large test wedding";

// 50 x 40 = 2,000 different names, letters only (names with digits are refused).
const FIRST = [
  "Ava", "Ben", "Cara", "Dev", "Eli", "Faye", "Gus", "Hana", "Ian", "Jade",
  "Kai", "Lena", "Max", "Nia", "Owen", "Pia", "Quinn", "Rosa", "Sam", "Tara",
  "Uma", "Vic", "Wes", "Xena", "Yara", "Zane", "Abe", "Bea", "Cole", "Dina",
  "Emil", "Fern", "Gabe", "Hope", "Ira", "June", "Kurt", "Lila", "Milo", "Nora",
  "Otis", "Pearl", "Reid", "Sage", "Tess", "Uri", "Vera", "Wade", "Yuki", "Zoe",
];
const LAST = [
  "Adams", "Baker", "Chen", "Diaz", "Evans", "Fox", "Garcia", "Hill", "Ito", "Jones",
  "Khan", "Lopez", "Moore", "Nguyen", "Owens", "Patel", "Reyes", "Smith", "Tran", "Underwood",
  "Vance", "Wong", "Young", "Zhang", "Abbott", "Brooks", "Cruz", "Dunn", "Ellis", "Ford",
  "Grant", "Hayes", "Irwin", "Jensen", "Kim", "Lane", "Mills", "Nash", "Ortiz", "Price",
];
const SIDES = ["BRIDE", "GROOM", "BOTH"] as const;
const TIERS = ["FAMILY", "FRIEND", "FRIEND", "OTHER", "VIP"] as const;

function argValue(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function guestList() {
  const guests = [];
  for (let i = 0; i < GUESTS; i++) {
    guests.push({
      firstName: FIRST[i % FIRST.length],
      lastName: LAST[Math.floor(i / FIRST.length) % LAST.length],
      side: SIDES[i % SIDES.length],
      tier: TIERS[i % TIERS.length],
      rsvpStatus: "CONFIRMED",
    });
  }
  return guests;
}

async function main() {
  const ownerEmail = argValue("--owner");
  if (!ownerEmail) {
    console.error("Pass --owner <email> -- an account that already exists in the local database.");
    process.exit(1);
  }
  const owner = await findUserByEmail(ownerEmail);
  if (!owner) {
    console.error(`No account with the email ${ownerEmail} in the local database. Sign up on the local site first.`);
    process.exit(1);
  }
  const guests = guestList();

  const csvPath = argValue("--csv");
  if (csvPath) {
    const rows = [["First name", "Last name", "Side", "Tier", "RSVP status"]];
    for (const g of guests) rows.push([g.firstName, g.lastName, g.side, g.tier, g.rsvpStatus]);
    writeFileSync(csvPath, rows.map((r) => r.join(",")).join("\n") + "\n");
    console.log(`Wrote ${GUESTS.toLocaleString("en-US")} guests to ${csvPath}.`);
  }

  const wedding = await createWedding(owner.id, { name: WEDDING_NAME });
  // Ten at a time -- the connection pool's size.
  for (let i = 0; i < guests.length; i += 10) {
    await Promise.all(guests.slice(i, i + 10).map((g) => createGuest(wedding.id, g)));
  }
  for (let made = 0; made < TABLES; made += TABLES_PER_QUICK_CREATE) {
    await quickCreateSeatingTables(wedding.id, {
      count: TABLES_PER_QUICK_CREATE,
      capacity: TABLE_CAPACITY,
      shape: "ROUND",
      labelPrefix: "Table",
    });
  }
  console.log(
    `Made "${WEDDING_NAME}" for ${ownerEmail}: ${GUESTS.toLocaleString("en-US")} guests, ${TABLES} tables of ${TABLE_CAPACITY}. ` +
      `Open it on the local site, then time Generate and Approve on its Seating plan tab.`
  );
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
