// Fills timeline, budget/vendors, and comments for Tom's two real weddings, so those three
// tabs have realistic data to look at without entering it by hand.
//
// SAFETY -- read this before changing anything here:
//
// This script targets ONLY the two wedding IDs listed in TARGET_WEDDING_IDS below. It never
// queries "all weddings", and never derives its target list from anything in the database.
// That is deliberate: `fill-existing-weddings.ts` in this same directory was written to fill
// "any existing wedding missing data", was run against a dev DB that had quietly accumulated
// 557 leftover Playwright fixtures, and mutated ~130 of them before it was caught (see TS-102).
// The dev DB is back up to 92 weddings as of 2026-09-18, so that hazard is live again. Adding
// a "fill every wedding" mode to this script would recreate exactly that incident.
//
// Two further guards, both borrowed from cleanup-test-weddings.ts:
//   * DRY RUN BY DEFAULT. Nothing is written unless you pass --confirm.
//   * Each wedding's ownerId is verified against EXPECTED_OWNER_ID before anything is written.
//     If a target ID ever points at a wedding that isn't Tom's, the script aborts rather than
//     writing to it.
//
// Idempotent: each of the three categories is filled only when that wedding has none of that
// category yet. Re-running never duplicates rows, and a category you've since filled by hand is
// left alone. Comments depend on timeline entries existing, so timeline is filled first.
//
// Usage (from the repo root):
//   pnpm --filter @seatwise/db fill-wedding-details            # dry run, prints a preview
//   pnpm --filter @seatwise/db fill-wedding-details --confirm  # actually writes

import "./load-env";

import {
  pool,
  createTimelineEntry,
  listTimelineEntriesForWedding,
  createVendor,
  listVendorsForWedding,
  setBudgetForWedding,
  createComment,
  listCommentsForWedding,
  resolveComment,
} from "../src/index";

// Tom's two real weddings. Confirmed against the DB on 2026-09-18: both owned by
// tom.carter@e-gineering.com, 150 guests and 21 tables each.
const TARGET_WEDDING_IDS = [
  "5f384ca5-d27c-42d6-b971-4f1d4c0f0453", // "Jim and Melissa"
  "d95acaaa-1974-40c8-bdbf-f91b0c2794f6", // "Chris and Jill"
];

const EXPECTED_OWNER_ID = "fe0f68f1-1a06-4efa-adea-b7d5668c0dba"; // Tom Carter

interface TimelineSeed {
  time: string;
  description: string;
}

interface VendorSeed {
  name: string;
  category: string;
  categoryOther?: string;
  contactName?: string;
  contactEmail?: string;
  contactPhone?: string;
  costCents?: number;
  contractNotes?: string;
}

// A comment seeded against a guest or table is matched by position in that wedding's own
// alphabetically-sorted list, not by a hardcoded row id -- the two weddings have different
// guests and tables, and hardcoded ids would break the moment either list changed.
interface CommentSeed {
  target: { kind: "GUEST"; index: number } | { kind: "TABLE"; index: number } | { kind: "TIMELINE"; index: number };
  body: string;
  replies?: string[];
  resolved?: boolean;
}

interface WeddingSeed {
  budgetCents: number;
  timeline: TimelineSeed[];
  vendors: VendorSeed[];
  comments: CommentSeed[];
}

// Deliberately different between the two weddings (different schedule shape, vendor mix, and
// budget) so that when both are open side by side it's obvious which is which, and so a bug
// that crosses wedding data shows up as visibly wrong rather than plausible.
const SEEDS: Record<string, WeddingSeed> = {
  // --- Jim and Melissa -- evening reception, 2030-10-10 ---------------------
  "5f384ca5-d27c-42d6-b971-4f1d4c0f0453": {
    budgetCents: 4_850_000, // $48,500.00
    timeline: [
      { time: "09:00", description: "Hair and makeup begins in the bridal suite" },
      { time: "11:30", description: "Photographer arrives for getting-ready shots" },
      { time: "13:00", description: "Groomsmen arrive, boutonnieres distributed" },
      { time: "14:00", description: "First look on the south lawn" },
      { time: "14:45", description: "Wedding party portraits" },
      { time: "15:30", description: "Guests begin arriving, prelude music starts" },
      { time: "16:00", description: "Ceremony begins" },
      { time: "16:40", description: "Ceremony concludes, recessional" },
      { time: "16:45", description: "Cocktail hour on the terrace" },
      { time: "17:00", description: "Family formals by the oak tree" },
      { time: "18:00", description: "Guests invited to be seated for dinner" },
      { time: "18:15", description: "Grand entrance and first dance" },
      { time: "18:30", description: "Welcome toast from the father of the bride" },
      { time: "18:45", description: "Dinner service begins (plated)" },
      { time: "19:45", description: "Best man and maid of honor toasts" },
      { time: "20:15", description: "Cake cutting" },
      { time: "20:30", description: "Parent dances, then dance floor opens" },
      { time: "22:30", description: "Late-night snack service" },
      { time: "23:30", description: "Last dance" },
      { time: "23:45", description: "Sparkler send-off" },
    ],
    vendors: [
      { name: "Hearthstone Catering", category: "CATERING", contactName: "Denise Whitfield", contactEmail: "events@hearthstonecatering.test", contactPhone: "(317) 555-0148", costCents: 1_620_000, contractNotes: "Plated service, 150 covers. 50% deposit due 30 days out. Final headcount locked 14 days prior." },
      { name: "The Ridgemont Estate", category: "VENUE", contactName: "Alan Reyes", contactEmail: "bookings@ridgemont.test", contactPhone: "(317) 555-0102", costCents: 1_150_000, contractNotes: "Includes 12hr venue access and on-site coordinator. Ceremony rain backup is the conservatory." },
      { name: "Fern & Thistle Florals", category: "FLORIST", contactName: "Marguerite Soto", contactEmail: "hello@fernandthistle.test", contactPhone: "(317) 555-0166", costCents: 385_000, contractNotes: "21 centerpieces, 8 bouquets, ceremony arch. Seasonal substitutions allowed at designer discretion." },
      { name: "Halden Photography", category: "PHOTOGRAPHY", contactName: "Ivo Halden", contactEmail: "studio@halden.test", contactPhone: "(317) 555-0119", costCents: 520_000, contractNotes: "Two shooters, 10hr coverage. Gallery delivered within 6 weeks." },
      { name: "Northlight Films", category: "VIDEOGRAPHY", contactName: "Priya Raman", contactEmail: "book@northlightfilms.test", costCents: 340_000, contractNotes: "Highlight reel plus full ceremony edit." },
      { name: "The Coppersmiths", category: "MUSIC_ENTERTAINMENT", contactName: "Russ Coyle", contactEmail: "booking@coppersmiths.test", contactPhone: "(317) 555-0173", costCents: 285_000, contractNotes: "Live 6-piece, two 60min sets. DJ covers breaks and after 22:00." },
      { name: "Marlowe & Vine Bridal", category: "ATTIRE", contactName: "Serena Ng", contactEmail: "atelier@marlowevine.test", costCents: 265_000, contractNotes: "Gown plus three fittings. Final fitting 3 weeks out." },
      { name: "Sugarhouse Bakeshop", category: "CAKE_BAKERY", contactName: "Owen Brandt", contactEmail: "orders@sugarhouse.test", contactPhone: "(317) 555-0131", costCents: 95_000, contractNotes: "Four tiers, lemon and almond. Delivery 15:00 day-of." },
      { name: "Standard Event Rentals", category: "RENTALS", contactName: "Kim Alvarado", contactEmail: "quotes@standardrentals.test", costCents: 210_000, contractNotes: "Chairs, linens, glassware, dance floor. Pickup the following morning." },
      { name: "Meridian Coach", category: "TRANSPORTATION", contactName: "Dale Foster", contactEmail: "dispatch@meridiancoach.test", costCents: 78_000, contractNotes: "Two shuttle runs from the hotel block, 15:00 and 15:45. Return loops at 22:30 and 00:00." },
      { name: "Paper Crane Studio", category: "STATIONERY", contactName: "Lucy Hammond", contactEmail: "hello@papercrane.test", costCents: 62_000, contractNotes: "Invitations, menus, escort cards, signage." },
      { name: "Ridgemont Day-Of Coordination", category: "OTHER", categoryOther: "Day-of coordinator", contactName: "Bethany Cole", contactEmail: "beth@ridgemontcoordination.test", costCents: 140_000, contractNotes: "Starts 60 days out. Runs rehearsal and full day-of timeline." },
    ],
    comments: [
      { target: { kind: "GUEST", index: 0 }, body: "Confirmed by phone — they're driving in the night before, so they'll be at the rehearsal dinner too." },
      { target: { kind: "GUEST", index: 3 }, body: "Dietary note came in late: shellfish allergy, not just a preference. Flagging for Hearthstone.", replies: ["Passed along to Denise, she's confirmed a separate plate.", "Confirmed in the final BEO. Closing this out."], resolved: true },
      { target: { kind: "GUEST", index: 7 }, body: "Still no RSVP. Melissa said she'd reach out directly this week." },
      { target: { kind: "GUEST", index: 12 }, body: "Requested to be seated away from the speakers — hearing aid. Worth honoring even if it breaks the side balance." },
      { target: { kind: "TABLE", index: 0 }, body: "Head table — keeping this one locked once the wedding party is final. Don't let regeneration touch it." },
      { target: { kind: "TABLE", index: 2 }, body: "This is the accessible table nearest the ramp. Two wheelchair spaces needed, so effective capacity is 8, not 10.", replies: ["Capacity updated to 8."], resolved: true },
      { target: { kind: "TABLE", index: 5 }, body: "Jim's college friends. They've asked to be together — treat as a soft preference, not a hard rule." },
      { target: { kind: "TABLE", index: 9 }, body: "Kids table. Melissa wants it in sightline of the parents' table rather than off in the corner." },
      { target: { kind: "TIMELINE", index: 3 }, body: "First look is tight if hair and makeup runs over. Padding it by 15 minutes would be safer." },
      { target: { kind: "TIMELINE", index: 6 }, body: "Ceremony start is firm — the officiant has a second booking that evening." },
      { target: { kind: "TIMELINE", index: 9 }, body: "Family formals overlap cocktail hour. Confirm with Ivo that the shot list fits in 45 minutes.", replies: ["Ivo says 45 is doable with 6 groupings, not more. Sent the list back to Melissa to trim."] },
      { target: { kind: "TIMELINE", index: 15 }, body: "Cake cutting right after toasts feels rushed. Consider moving to 20:45." },
      { target: { kind: "TIMELINE", index: 19 }, body: "Venue requires sparklers to be outside the north gate, not on the drive. Confirmed with Alan." },
    ],
  },

  // --- Chris and Jill -- afternoon reception, 2030-10-12 --------------------
  "d95acaaa-1974-40c8-bdbf-f91b0c2794f6": {
    budgetCents: 3_275_000, // $32,750.00
    timeline: [
      { time: "08:30", description: "Bridal party breakfast at the inn" },
      { time: "10:00", description: "Hair and makeup begins" },
      { time: "12:00", description: "Photographer arrives" },
      { time: "12:30", description: "Chris and groomsmen dress and portraits" },
      { time: "13:15", description: "Jill dresses, mother-of-the-bride first look" },
      { time: "14:00", description: "Guests begin arriving" },
      { time: "14:30", description: "Ceremony begins in the garden" },
      { time: "15:00", description: "Ceremony concludes" },
      { time: "15:10", description: "Cocktail hour, lawn games open" },
      { time: "15:30", description: "Wedding party and family portraits" },
      { time: "16:30", description: "Guests seated for the reception" },
      { time: "16:45", description: "Grand entrance" },
      { time: "17:00", description: "Buffet dinner service opens" },
      { time: "17:45", description: "Toasts — best man, matron of honor, Jill's father" },
      { time: "18:15", description: "First dance" },
      { time: "18:30", description: "Cake cutting and dessert table" },
      { time: "19:00", description: "Dance floor opens" },
      { time: "20:30", description: "Bouquet toss" },
      { time: "21:30", description: "Last dance and farewell circle" },
    ],
    vendors: [
      { name: "Wildrye Farm Kitchen", category: "CATERING", contactName: "Nate Oyelaran", contactEmail: "events@wildrye.test", contactPhone: "(812) 555-0107", costCents: 1_125_000, contractNotes: "Family-style buffet, 150 guests. Two vegetarian mains included. Final count 10 days prior." },
      { name: "Sparrow Hill Gardens", category: "VENUE", contactName: "Corinne Baptiste", contactEmail: "info@sparrowhill.test", contactPhone: "(812) 555-0123", costCents: 780_000, contractNotes: "Garden ceremony plus pavilion reception. Hard stop at 22:00 for the noise ordinance." },
      { name: "Bramble & Bloom", category: "FLORIST", contactName: "Tess Okonkwo", contactEmail: "studio@brambleandbloom.test", costCents: 240_000, contractNotes: "Garden-style, heavy on local dahlias. Arch is a rental, returned Monday." },
      { name: "Junie Wren Photo", category: "PHOTOGRAPHY", contactName: "Junie Wren", contactEmail: "hello@juniewren.test", contactPhone: "(812) 555-0190", costCents: 385_000, contractNotes: "Single shooter, 8hr. Second shooter added for ceremony only." },
      { name: "Rowan Street Records", category: "MUSIC_ENTERTAINMENT", contactName: "Micah Delgado", contactEmail: "dj@rowanstreet.test", costCents: 145_000, contractNotes: "DJ plus ceremony string duo. Ceremony audio included." },
      { name: "Ledger & Lace", category: "ATTIRE", contactName: "Amara Bright", contactEmail: "fittings@ledgerandlace.test", costCents: 185_000, contractNotes: "Gown and two bridesmaid alterations." },
      { name: "Tillman's Pie Co.", category: "CAKE_BAKERY", contactName: "Gus Tillman", contactEmail: "orders@tillmanspie.test", costCents: 48_000, contractNotes: "Pie table instead of a tiered cake, plus a small cutting cake. Delivery 13:30." },
      { name: "Fieldhouse Rentals", category: "RENTALS", contactName: "Rosa Quintero", contactEmail: "hello@fieldhouserentals.test", costCents: 165_000, contractNotes: "Farm tables, cross-back chairs, string lighting. Tent on 72hr weather hold." },
      { name: "Quill & Press", category: "STATIONERY", contactName: "Edith Marlowe", contactEmail: "orders@quillandpress.test", costCents: 41_000, contractNotes: "Letterpress invitations and day-of signage." },
      { name: "Sparrow Hill Shuttle", category: "TRANSPORTATION", contactName: "Corinne Baptiste", contactEmail: "info@sparrowhill.test", costCents: 52_000, contractNotes: "Single 14-passenger van, continuous loop 14:00-22:00." },
      { name: "Petal & Pin Hair/Makeup", category: "OTHER", categoryOther: "Hair and makeup", contactName: "Delia Souza", contactEmail: "book@petalandpin.test", costCents: 96_000, contractNotes: "Bride plus 6. On-site from 10:00." },
    ],
    comments: [
      { target: { kind: "GUEST", index: 1 }, body: "Plus-one is confirmed now — adding to the headcount for Wildrye." },
      { target: { kind: "GUEST", index: 5 }, body: "Chris's grandmother. Needs a seat close to the pavilion entrance, minimal walking on grass.", replies: ["Moved to the accessible table nearest the entrance."], resolved: true },
      { target: { kind: "GUEST", index: 9 }, body: "Vegetarian, and Jill mentioned they're also avoiding dairy. Need to confirm whether the buffet covers that." },
      { target: { kind: "GUEST", index: 14 }, body: "Declined — travelling that week. Jill wants to send a card rather than just marking it and moving on." },
      { target: { kind: "TABLE", index: 1 }, body: "Sweetheart table for Chris and Jill rather than a full head table. Capacity 2." },
      { target: { kind: "TABLE", index: 4 }, body: "Jill's work colleagues. She'd rather they not be seated next to the family tables." },
      { target: { kind: "TABLE", index: 7 }, body: "This one is under the tent edge — if the weather hold gets called, this table has to move inward.", replies: ["Noted. Rosa says we'll know by the Wednesday before."] },
      { target: { kind: "TABLE", index: 11 }, body: "Overflow table. Leaving it unlocked so regeneration can use it if the headcount shifts." },
      { target: { kind: "TIMELINE", index: 4 }, body: "The mother-of-the-bride first look was Jill's request — make sure Junie knows it's a priority shot." },
      { target: { kind: "TIMELINE", index: 6 }, body: "14:30 in the garden means full sun. Junie flagged harsh light — worth asking about moving 30 minutes later.", replies: ["Asked Corinne. The garden is booked straight through, so 14:30 stands. Junie will bring a scrim."], resolved: true },
      { target: { kind: "TIMELINE", index: 12 }, body: "Buffet opening at 17:00 assumes two lines. Confirm with Nate that it's two, not one." },
      { target: { kind: "TIMELINE", index: 18 }, body: "Hard stop is 22:00 for the noise ordinance, so last dance at 21:30 leaves no slack. Don't let this drift." },
    ],
  },
};

interface WeddingRow {
  id: string;
  name: string;
  ownerId: string;
}

function usd(cents: number): string {
  return `$${(cents / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

async function main() {
  const confirmed = process.argv.includes("--confirm");

  const { rows: weddings } = await pool.query<WeddingRow>(
    `SELECT id, name, "ownerId" FROM "weddings" WHERE id = ANY($1::text[])`,
    [TARGET_WEDDING_IDS],
  );

  if (weddings.length !== TARGET_WEDDING_IDS.length) {
    const found = new Set(weddings.map((w) => w.id));
    const missing = TARGET_WEDDING_IDS.filter((id) => !found.has(id));
    console.error(`ABORT: ${missing.length} target wedding(s) not found in this database:`);
    for (const id of missing) console.error(`  ${id}`);
    console.error(`\nCheck DATABASE_URL points at the right database before re-running.`);
    process.exitCode = 1;
    await pool.end();
    return;
  }

  // Owner guard -- see the SAFETY note at the top of this file.
  const wrongOwner = weddings.filter((w) => w.ownerId !== EXPECTED_OWNER_ID);
  if (wrongOwner.length > 0) {
    console.error(`ABORT: target wedding(s) are not owned by the expected account:`);
    for (const w of wrongOwner) console.error(`  "${w.name}" (${w.id}) ownerId=${w.ownerId}`);
    console.error(`\nExpected ownerId=${EXPECTED_OWNER_ID}. Refusing to write.`);
    process.exitCode = 1;
    await pool.end();
    return;
  }

  console.log(
    confirmed
      ? "Mode: --confirm (changes WILL be written)\n"
      : "Mode: DRY RUN (nothing will be written -- pass --confirm to apply)\n",
  );
  console.log(`Targeting ${weddings.length} wedding(s), owner verified:\n`);

  for (const wedding of weddings) {
    const seed = SEEDS[wedding.id];
    console.log(`=== "${wedding.name}" (${wedding.id})`);

    // --- Timeline ----------------------------------------------------------
    const existingTimeline = await listTimelineEntriesForWedding(wedding.id);
    if (existingTimeline.length > 0) {
      console.log(`  timeline : SKIP -- already has ${existingTimeline.length} entr${existingTimeline.length === 1 ? "y" : "ies"}`);
    } else if (!confirmed) {
      console.log(`  timeline : would add ${seed.timeline.length} entries (${seed.timeline[0].time}-${seed.timeline[seed.timeline.length - 1].time})`);
    } else {
      for (const entry of seed.timeline) {
        await createTimelineEntry(wedding.id, entry);
      }
      console.log(`  timeline : added ${seed.timeline.length} entries`);
    }

    // --- Budget + vendors --------------------------------------------------
    const existingVendors = await listVendorsForWedding(wedding.id);
    const vendorTotal = seed.vendors.reduce((sum, v) => sum + (v.costCents ?? 0), 0);
    if (existingVendors.length > 0) {
      console.log(`  budget   : SKIP -- already has ${existingVendors.length} vendor(s)`);
    } else if (!confirmed) {
      console.log(`  budget   : would set budget ${usd(seed.budgetCents)} and add ${seed.vendors.length} vendors totalling ${usd(vendorTotal)} (${usd(seed.budgetCents - vendorTotal)} remaining)`);
    } else {
      await setBudgetForWedding(wedding.id, seed.budgetCents);
      for (const vendor of seed.vendors) {
        await createVendor(wedding.id, vendor);
      }
      console.log(`  budget   : set ${usd(seed.budgetCents)}, added ${seed.vendors.length} vendors totalling ${usd(vendorTotal)} (${usd(seed.budgetCents - vendorTotal)} remaining)`);
    }

    // --- Comments ----------------------------------------------------------
    // Depends on timeline entries existing, so this runs after the timeline block above.
    const existingComments = await listCommentsForWedding(wedding.id);
    const replyCount = seed.comments.reduce((n, c) => n + (c.replies?.length ?? 0), 0);
    if (existingComments.length > 0) {
      console.log(`  comments : SKIP -- already has ${existingComments.length} comment(s)`);
    } else if (!confirmed) {
      console.log(`  comments : would add ${seed.comments.length} comments + ${replyCount} replies`);
    } else {
      const { rows: guests } = await pool.query<{ id: string }>(
        `SELECT id FROM "guests" WHERE "weddingId" = $1 ORDER BY "lastName", "firstName", id`,
        [wedding.id],
      );
      const { rows: tables } = await pool.query<{ id: string }>(
        `SELECT id FROM "seating_tables" WHERE "weddingId" = $1 ORDER BY label, id`,
        [wedding.id],
      );
      const timeline = await listTimelineEntriesForWedding(wedding.id);

      let added = 0;
      let replies = 0;
      let skipped = 0;

      for (const seedComment of seed.comments) {
        const { target } = seedComment;
        let input;

        if (target.kind === "GUEST") {
          const guest = guests[target.index];
          if (!guest) { skipped++; continue; }
          input = { targetType: "GUEST" as const, guestId: guest.id, body: seedComment.body };
        } else if (target.kind === "TABLE") {
          const table = tables[target.index];
          if (!table) { skipped++; continue; }
          input = { targetType: "TABLE" as const, tableId: table.id, body: seedComment.body };
        } else {
          const entry = timeline[target.index];
          if (!entry) { skipped++; continue; }
          input = { targetType: "TIMELINE_ENTRY" as const, timelineEntryId: entry.id, body: seedComment.body };
        }

        const created = await createComment(wedding.id, EXPECTED_OWNER_ID, input);
        added++;

        for (const replyBody of seedComment.replies ?? []) {
          await createComment(wedding.id, EXPECTED_OWNER_ID, {
            ...input,
            body: replyBody,
            parentCommentId: created.id,
          });
          replies++;
        }

        if (seedComment.resolved) {
          await resolveComment(wedding.id, created.id, EXPECTED_OWNER_ID, true);
        }
      }

      const resolvedCount = seed.comments.filter((c) => c.resolved).length;
      console.log(
        `  comments : added ${added} comments + ${replies} replies (${resolvedCount} resolved)` +
          (skipped > 0 ? ` -- ${skipped} skipped, target row missing` : ""),
      );
    }

    console.log("");
  }

  if (!confirmed) {
    console.log("Dry run complete. Nothing was written. Re-run with --confirm to apply.");
  } else {
    console.log("Done.");
  }

  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
  void pool.end();
});
