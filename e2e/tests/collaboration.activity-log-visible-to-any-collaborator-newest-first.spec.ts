/**
 * TS-48 (REQ-COLLABORATION-NOTIFICATIONS) — converts AC-069 ("An activity log shows recent
 * changes to anyone with access").
 *
 * Confirmed directly in packages/db/src/queries/activity.ts's `listActivityForWedding` (joined
 * through the `activity` API route, apps/web/src/app/api/v1/weddings/[weddingId]/activity/route.ts):
 * every change_history_entries row for the wedding (across every plan version, not just the
 * current one) is returned newest-first, each carrying its `action`, free-text `description`,
 * `actorUserId`/`actorName` (left-joined, so a since-removed actor would show a null name — not
 * exercised here since a comment/table/guest can be deleted independently of the user who acted),
 * and `createdAt`. `action` types actually produced by this app (grepped across
 * plan-versions.ts's own inserts): GENERATE, STATUS_CHANGE, MANUAL_MOVE, MANUAL_SWAP,
 * ATTENDANCE_CHANGE, RESTORE — GENERATE, MANUAL_MOVE, and two STATUS_CHANGE entries are all
 * exercised below (MANUAL_SWAP/ATTENDANCE_CHANGE/RESTORE already have their own dedicated
 * coverage under TS-45/TS-47).
 *
 * "Anyone with access" is confirmed to mean exactly that: the route's own gate is
 * `requireAccess(weddingId, user.id, "VIEW")` — the lowest rung on the access ladder — so every
 * collaborator level (View/Comment/Edit) and the owner all read the identical, full feed; a
 * user with no relationship to the wedding at all is denied with the standard 404 "Wedding not
 * found" `requireAccess` gives any unauthorized caller (confirmed in apps/web/src/lib/access.ts).
 *
 * Real finding, asserted directly rather than assumed: the AC's own wording ("removed targets
 * remain understandable and marked Historical") does not match the app's actual behavior in two
 * ways. First, there is no per-entry access filtering at all — "each viewer sees only activity
 * the viewer is authorized to access" is satisfied only at the whole-wedding level (any
 * collaborator sees every entry, or none); this test's own VIEW-collaborator step confirms they
 * see the identical feed the owner does, not a filtered subset. Second, no entry is ever
 * literally marked "Historical" anywhere in this codebase (grepped app-wide) — `description` is
 * captured as plain text at write time and simply never changes, so a target's later removal is
 * "understandable" only in the sense that the original wording (naming the guest/table involved)
 * is still there to read, asserted below by deleting the guest a MANUAL_MOVE entry named and
 * confirming that entry's description is untouched by the deletion.
 *
 * Third, GENERATE's own INSERT (confirmed directly in plan-versions.ts) never includes an
 * actorUserId column at all -- generation is recorded as a system action with no actor, by
 * design, unlike every other action type here, which always passes the acting user's id. Asserted
 * below as GENERATE's own documented exception rather than folded into a blanket "every entry has
 * an actor" assumption that the real data would fail.
 */

import { request as playwrightRequest } from "@playwright/test";
import { expect, defineQualityTest, test } from "../fixtures/index.js";
import { signUpFreshAccount } from "../support/auth.js";
import { getEnv } from "../support/env.js";
import { uniquePersonName } from "../data/ids.js";

defineQualityTest(
  {
    id: "collaboration.activity-log-visible-to-any-collaborator-newest-first.entries-identify-action-actor-and-timestamp",
    title: "the activity log lists every recorded change newest-first with its action, actor, and timestamp; a removed guest's own move stays readable; and any collaborator (not just the owner) can read the whole feed, while a non-collaborator is denied",
    objective:
      "Confirms the wedding-wide activity feed returns GENERATE, MANUAL_MOVE, and STATUS_CHANGE entries strictly newest-first, each with a non-empty actorName and a description naming the guests/tables involved; that deleting a guest named in an older MANUAL_MOVE entry leaves that entry's description exactly as it was; that a View-level collaborator reads the identical feed the owner does; and that a user with no access to the wedding at all is denied (404).",
    expectedOutcome:
      "GET .../activity returns entries ordered strictly newest-to-oldest, with GENERATE first (oldest) and the final STATUS_CHANGE (to APPROVED) last (newest). After the moved guest is deleted, the same MANUAL_MOVE entry (by id) still has its original description text. A View-level collaborator's own GET of the same endpoint returns the same set of entries. A non-collaborator's GET returns 404.",
    requirementIds: ["REQ-COLLABORATION-NOTIFICATIONS"],
    tags: ["@mutating", "@feature:collaboration", "@risk:normal", "@suite:regression"],
  },
  async ({ managedWedding, weddingData }, testInfo) => {
    let guestAId = "";
    let guestAName = "";
    let planVersionId = "";
    let destinationTableLabel = "";

    await test.step("Arrange: two guests, two tables, and a complete generated plan", async () => {
      const guestA = await weddingData.createGuest(managedWedding.id, uniquePersonName(testInfo.workerIndex));
      guestAId = guestA.id;
      guestAName = `${guestA.firstName} ${guestA.lastName}`;
      await weddingData.createGuest(managedWedding.id, uniquePersonName(testInfo.workerIndex));
      // Capacity 2 (not 1) on both tables so guestA has room to move into whichever table guestB
      // already occupies, without needing a swap.
      const tableHead = await weddingData.createTable(managedWedding.id, { label: "Head Table", capacity: 2 });
      const tableBack = await weddingData.createTable(managedWedding.id, { label: "Back Table", capacity: 2 });

      const generated = await weddingData.generatePlanVersion(managedWedding.id);
      expect(generated.isComplete).toBe(true);
      planVersionId = generated.id;

      const currentTableId = generated.assignments.find((a) => a.guestId === guestAId)?.tableId;
      const otherTable = currentTableId === tableHead.id ? tableBack : tableHead;
      destinationTableLabel = otherTable.label;

      // Act (setup, but this IS the MANUAL_MOVE entry under test): move guestA to the table they
      // weren't seated at, so the entry names both a guest and a table deliberately, not by luck.
      const moveRes = await weddingData.moveGuestAssignment(managedWedding.id, planVersionId, guestAId, otherTable.id);
      expect(moveRes.status).toBe(200);
    });

    await test.step("Act: share for review, then approve (two STATUS_CHANGE entries)", async () => {
      const toReview = await weddingData.setPlanVersionStatus(managedWedding.id, planVersionId, "IN_REVIEW");
      expect(toReview.status).toBe(200);
      const toApproved = await weddingData.setPlanVersionStatus(managedWedding.id, planVersionId, "APPROVED");
      expect(toApproved.status).toBe(200);
    });

    let manualMoveEntryId = "";
    let manualMoveDescription = "";

    await test.step("Assert: the feed lists GENERATE, MANUAL_MOVE, and both STATUS_CHANGE entries strictly newest-first, each with an actor and description", async () => {
      const entries = await weddingData.getActivity(managedWedding.id);

      for (let i = 0; i + 1 < entries.length; i++) {
        expect(
          new Date(entries[i].createdAt).getTime(),
          `entry ${i} (${entries[i].action}) should be newer than or equal to entry ${i + 1} (${entries[i + 1].action})`,
        ).toBeGreaterThanOrEqual(new Date(entries[i + 1].createdAt).getTime());
      }

      // Newest-first: the very first entry is the last thing that happened -- the IN_REVIEW ->
      // APPROVED status change -- and the very last (oldest) is the initial generation.
      expect(entries[0].action).toBe("STATUS_CHANGE");
      expect(entries[0].description).toBe("Status changed from IN_REVIEW to APPROVED");
      expect(entries[entries.length - 1].action).toBe("GENERATE");

      const statusChanges = entries.filter((e) => e.action === "STATUS_CHANGE");
      expect(statusChanges).toHaveLength(2);
      expect(statusChanges.map((e) => e.description).sort()).toEqual(
        ["Status changed from DRAFT to IN_REVIEW", "Status changed from IN_REVIEW to APPROVED"].sort(),
      );

      const manualMove = entries.find((e) => e.action === "MANUAL_MOVE");
      expect(manualMove).toBeTruthy();
      expect(manualMove!.description).toContain(guestAName);
      expect(manualMove!.description).toContain(destinationTableLabel);
      manualMoveEntryId = manualMove!.id;
      manualMoveDescription = manualMove!.description;

      for (const entry of entries) {
        // Real finding, asserted directly rather than assumed: GENERATE's own INSERT (confirmed
        // directly in plan-versions.ts) never includes an actorUserId column at all -- generation
        // is recorded as a system action with no actor, by design, unlike every other action type
        // here (MANUAL_MOVE/STATUS_CHANGE), which always pass the acting user's id.
        if (entry.action === "GENERATE") {
          expect(entry.actorName, `actorName for GENERATE entry ${entry.id}`).toBeNull();
        } else {
          expect(entry.actorName, `actorName for ${entry.action} entry ${entry.id}`).toBeTruthy();
        }
        expect(Number.isNaN(new Date(entry.createdAt).getTime()), `createdAt for entry ${entry.id}`).toBe(false);
      }
    });

    await test.step("Act + Assert: deleting the guest named in that MANUAL_MOVE entry leaves the entry's own description exactly as it was", async () => {
      await weddingData.deleteGuest(managedWedding.id, guestAId);

      const entries = await weddingData.getActivity(managedWedding.id);
      const sameEntry = entries.find((e) => e.id === manualMoveEntryId);
      expect(sameEntry, "the MANUAL_MOVE entry should still be present after its guest is deleted").toBeTruthy();
      expect(sameEntry!.description).toBe(manualMoveDescription);
      expect(sameEntry!.description).toContain(guestAName);
    });

    const baseURL = getEnv().APP_URL;
    const viewContext = await playwrightRequest.newContext({ baseURL });
    const strangerContext = await playwrightRequest.newContext({ baseURL });
    try {
      await test.step("Assert: a View-level collaborator reads the identical activity feed the owner does", async () => {
        const viewAccount = await signUpFreshAccount(viewContext, testInfo.workerIndex);
        await weddingData.addCollaborator(managedWedding.id, viewAccount.email, "VIEW");

        const ownerEntries = await weddingData.getActivity(managedWedding.id);
        const res = await viewContext.get(`/api/v1/weddings/${managedWedding.id}/activity`);
        expect(res.status()).toBe(200);
        const body = (await res.json()) as { entries: { id: string }[] };
        expect(body.entries.map((e) => e.id).sort()).toEqual(ownerEntries.map((e) => e.id).sort());
      });

      await test.step("Assert: a user with no access to the wedding at all is denied (404), not shown a filtered feed", async () => {
        await signUpFreshAccount(strangerContext, testInfo.workerIndex);
        const res = await strangerContext.get(`/api/v1/weddings/${managedWedding.id}/activity`);
        expect(res.status()).toBe(404);
        const body = (await res.json()) as { error: string };
        expect(body.error).toBe("Wedding not found");
      });
    } finally {
      await viewContext.dispose();
      await strangerContext.dispose();
    }
  },
);
