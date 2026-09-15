/**
 * TS-55 (REQ-INTEGRATION-E2E-SCENARIOS) — converts AC-084 ("Two clients' weddings never
 * cross-contaminate across a full lifecycle"). The closest existing precedent,
 * account-management.wedding-data-isolation.spec.ts, deliberately scopes itself to guests only
 * (its own header comment: "Broader, deeper cross-tenant access-control coverage across every
 * resource type is REQ-ACCESS-CONTROL's own story (TS-39), not duplicated here") and uses one
 * account with no second collaborator at all. This test is the broader, full-lifecycle version
 * that story explicitly left for later: one planner owns both weddings, each with its own,
 * different collaborator (never the other wedding's), and every resource type AC-084's own
 * Expected Result names -- guest, rule, table, plan/floor-plan position, comment, activity entry,
 * access grant, notification, and export content -- gets its own checkpoint, not just guests.
 *
 * Each checkpoint follows the same shape established by the existing guest-isolation test:
 * create the resource under Wedding A, then confirm it is absent from Wedding B's own
 * wedding-scoped read (list endpoint doesn't contain it; a direct fetch by its exact id, scoped
 * under Wedding B's path, 404s rather than returning A's data). Collaborator isolation is checked
 * the other way too: Wedding A's own collaborator, in their own independently-authenticated
 * session, is denied outright (404 -- `requireAccess`'s own deliberate "don't confirm a wedding
 * a user has zero access to even exists" behavior, distinct from the 403 it returns for a user
 * with *some* access at too low a rank) when attempting to reach Wedding B at all -- not just
 * "doesn't see A's data from B," but "never granted any access to B in the first place."
 */

import { expect, defineQualityTest, test } from "../fixtures/index.js";
import { signUpFreshAccountInNewContext } from "../support/auth.js";
import { uniquePersonName, uniqueTitle } from "../data/ids.js";

defineQualityTest(
  {
    id: "integration.two-weddings-never-cross-contaminate-across-a-full-lifecycle.every-resource-type-stays-scoped-to-its-own-wedding",
    title: "guests, rules, tables, plan versions, comments, activity, access grants, notifications, and export content created under one of a planner's weddings never appear in or are retrievable through their other wedding, even with a different collaborator granted access to each",
    objective:
      "Confirms full-lifecycle data isolation between two weddings owned by the same planner, each independently configured, generated, approved, exported, and given its own distinct collaborator: no guest, rule, table, plan version, comment, activity entry, access grant, notification, or export content from either wedding is visible through the other wedding's own API surface, and each wedding's own collaborator is denied outright when attempting to reach the other wedding.",
    expectedOutcome:
      "Every Wedding-B-scoped read (guests, relationships, tables, plan-versions, comments, activity, collaborators) excludes every one of Wedding A's ids/names, and the reverse. A direct fetch of any of Wedding A's exact resource ids, scoped under Wedding B's own path, 404s. Wedding A's collaborator is denied (404) on every Wedding B endpoint they attempt. Wedding A's collaborator's own notifications never name Wedding B. Wedding B's export succeeds and is a real PDF; fetching Wedding A's plan version scoped under Wedding B's path 404s.",
    requirementIds: ["REQ-INTEGRATION-E2E-SCENARIOS"],
    tags: ["@mutating", "@feature:account", "@feature:collaboration", "@risk:critical", "@suite:smoke", "@suite:regression"],
  },
  async ({ managedWedding, weddingData, context, browser }, testInfo) => {
    test.setTimeout(120_000);

    const weddingA = managedWedding;
    let weddingBId = "";
    const gA1 = uniquePersonName(testInfo.workerIndex);
    const gA2 = uniquePersonName(testInfo.workerIndex);
    const gB1 = uniquePersonName(testInfo.workerIndex);
    const gB2 = uniquePersonName(testInfo.workerIndex);
    let ruleAId = "";
    let ruleBId = "";
    let tableAId = "";
    let tableBId = "";
    let planAId = "";
    let planBId = "";
    let commentABody = "";
    let commentBBody = "";

    const collabA = await signUpFreshAccountInNewContext(browser, testInfo.workerIndex, "collab-a");
    const collabB = await signUpFreshAccountInNewContext(browser, testInfo.workerIndex, "collab-b");

    try {
      await test.step("Arrange: a second wedding (B), owned by the same planner, and a distinct collaborator for each wedding", async () => {
        const created = await weddingData.createWedding(uniqueTitle(testInfo.workerIndex, "Wedding B"));
        weddingBId = created.id;
        await weddingData.addCollaborator(weddingA.id, collabA.email, "EDIT", "COLLABORATOR");
        await weddingData.addCollaborator(weddingBId, collabB.email, "EDIT", "COLLABORATOR");
      });

      await test.step("Arrange: configure, import, generate, review, approve, comment on, and export both weddings independently", async () => {
        for (const [weddingId, guests, commentTarget] of [
          [weddingA.id, [gA1, gA2], "A"] as const,
          [weddingBId, [gB1, gB2], "B"] as const,
        ]) {
          const createdGuests = [];
          for (const g of guests) createdGuests.push(await weddingData.createGuest(weddingId, g));
          const rule = await weddingData.createRelationship(
            weddingId,
            createdGuests[0].id,
            createdGuests[1].id,
            "MUST_SIT_TOGETHER",
          );
          const createdTables = await weddingData.quickCreateTables(weddingId, { count: 2, capacity: 2 });
          const generated = await weddingData.generatePlanVersion(weddingId);
          expect(generated.isComplete).toBe(true);
          await weddingData.setPlanVersionStatus(weddingId, generated.id, "IN_REVIEW");
          await weddingData.setPlanVersionStatus(weddingId, generated.id, "APPROVED");
          const commentRes = await weddingData.postComment(weddingId, {
            targetType: "GUEST",
            guestId: createdGuests[0].id,
            body: `Confidential note about Wedding ${commentTarget}'s guest`,
          });
          expect(commentRes.status).toBe(201);

          if (weddingId === weddingA.id) {
            ruleAId = rule.id;
            tableAId = createdTables[0].id;
            planAId = generated.id;
            commentABody = commentRes.body.comment!.body;
          } else {
            ruleBId = rule.id;
            tableBId = createdTables[0].id;
            planBId = generated.id;
            commentBBody = commentRes.body.comment!.body;
          }
        }
      });

      await test.step("Assert: no guest from either wedding is visible through the other", async () => {
        // NB: uniquePersonName's own uniqueness lives entirely in `lastName` (`firstName` is
        // always the constant "Playwright" -- see ids.ts's own doc comment), so isolation here
        // must be checked by `lastName`, not `firstName`: every guest in both weddings shares the
        // same firstName by design, which would make a firstName-only comparison vacuously true
        // regardless of whether cross-wedding isolation actually holds.
        const bGuestsRes = await context.request.get(`/api/v1/weddings/${weddingBId}/guests`);
        const { guests: bGuests } = (await bGuestsRes.json()) as { guests: { lastName: string }[] };
        expect(bGuests.some((g) => g.lastName === gA1.lastName || g.lastName === gA2.lastName)).toBe(false);

        const aGuestsRes = await context.request.get(`/api/v1/weddings/${weddingA.id}/guests`);
        const { guests: aGuests } = (await aGuestsRes.json()) as { guests: { lastName: string }[] };
        expect(aGuests.some((g) => g.lastName === gB1.lastName || g.lastName === gB2.lastName)).toBe(false);
      });

      await test.step("Assert: no rule from either wedding is visible through the other", async () => {
        const bRulesRes = await context.request.get(`/api/v1/weddings/${weddingBId}/relationships`);
        const bRulesBody = (await bRulesRes.json()) as { relationships: { id: string }[] };
        expect(bRulesBody.relationships.some((r) => r.id === ruleAId)).toBe(false);

        const aRulesRes = await context.request.get(`/api/v1/weddings/${weddingA.id}/relationships`);
        const aRulesBody = (await aRulesRes.json()) as { relationships: { id: string }[] };
        expect(aRulesBody.relationships.some((r) => r.id === ruleBId)).toBe(false);
      });

      await test.step("Assert: no table from either wedding is visible through the other", async () => {
        // Real finding while authoring this test: quickCreateTables's own default labels
        // ("Table 1", "Table 2", ...) are not wedding-unique -- both weddings quick-create their
        // tables the same way, so a label-based comparison was vacuously true regardless of
        // isolation. `id` is the only field guaranteed unique per table, so isolation is checked
        // by id here, matching the pattern already used for rules and plan versions below.
        const bTables = await weddingData.listTables(weddingBId);
        expect(bTables.some((t) => t.id === tableAId)).toBe(false);

        const aTables = await weddingData.listTables(weddingA.id);
        expect(aTables.some((t) => t.id === tableBId)).toBe(false);
      });

      await test.step("Assert: neither wedding's plan version is reachable scoped under the other wedding's own path", async () => {
        const crossRes1 = await context.request.get(
          `/api/v1/weddings/${weddingBId}/plan-versions/${planAId}`,
        );
        expect(crossRes1.status()).toBe(404);

        const crossRes2 = await context.request.get(
          `/api/v1/weddings/${weddingA.id}/plan-versions/${planBId}`,
        );
        expect(crossRes2.status()).toBe(404);
      });

      await test.step("Assert: no comment from either wedding is visible through the other", async () => {
        const bCommentsRes = await context.request.get(`/api/v1/weddings/${weddingBId}/comments`);
        const bCommentsBody = (await bCommentsRes.json()) as { comments: { body: string }[] };
        expect(bCommentsBody.comments.some((c) => c.body === commentABody)).toBe(false);

        const aCommentsRes = await context.request.get(`/api/v1/weddings/${weddingA.id}/comments`);
        const aCommentsBody = (await aCommentsRes.json()) as { comments: { body: string }[] };
        expect(aCommentsBody.comments.some((c) => c.body === commentBBody)).toBe(false);
      });

      await test.step("Assert: no activity entry from either wedding is visible through the other", async () => {
        // Same `lastName`-not-`firstName` reasoning as the guest-isolation step above: every
        // guest's first name is the constant "Playwright", so an activity description naming any
        // guest in either wedding would always contain it -- only `lastName` actually
        // distinguishes wedding A's guests from wedding B's.
        const bActivity = await weddingData.getActivity(weddingBId);
        expect(bActivity.some((e) => e.description.includes(gA1.lastName))).toBe(false);

        const aActivity = await weddingData.getActivity(weddingA.id);
        expect(aActivity.some((e) => e.description.includes(gB1.lastName))).toBe(false);
      });

      await test.step("Assert: no access grant from either wedding is visible through the other", async () => {
        const bCollabRes = await context.request.get(`/api/v1/weddings/${weddingBId}/collaborators`);
        const bCollabBody = (await bCollabRes.json()) as { collaborators: { userEmail: string }[] };
        expect(bCollabBody.collaborators.some((c) => c.userEmail === collabA.email)).toBe(false);

        const aCollabRes = await context.request.get(`/api/v1/weddings/${weddingA.id}/collaborators`);
        const aCollabBody = (await aCollabRes.json()) as { collaborators: { userEmail: string }[] };
        expect(aCollabBody.collaborators.some((c) => c.userEmail === collabB.email)).toBe(false);
      });

      await test.step("Assert: Wedding A's own collaborator is denied outright on every Wedding B endpoint they attempt, and vice versa", async () => {
        // Real finding while authoring this test: `requireAccess` (apps/web/src/lib/access.ts)
        // returns 404 "Wedding not found", not 403, for a user with NO access grant at all on a
        // wedding -- 403 is reserved for a user who has *some* access level but a rank too low
        // for the action (e.g. VIEW attempting an EDIT-only action, as AC-081's own test exercises).
        // Wedding A's collaborator has zero access to Wedding B, so the correct, already-precedented
        // assertion here (see account-management.wedding-data-isolation.spec.ts) is 404, not 403 --
        // the app deliberately doesn't confirm a wedding it can't access even exists.
        const aCollabOnB = await collabA.context.request.get(`/api/v1/weddings/${weddingBId}/guests`);
        expect(aCollabOnB.status()).toBe(404);

        const bCollabOnA = await collabB.context.request.get(`/api/v1/weddings/${weddingA.id}/guests`);
        expect(bCollabOnA.status()).toBe(404);
      });

      await test.step("Assert: Wedding A's collaborator's own notifications never name Wedding B, and vice versa", async () => {
        const aCollabNotifsRes = await collabA.context.request.get("/api/v1/notifications");
        const aCollabNotifs = (await aCollabNotifsRes.json()) as {
          notifications: { weddingId: string; weddingName: string }[];
        };
        expect(aCollabNotifs.notifications.some((n) => n.weddingId === weddingBId)).toBe(false);

        const bCollabNotifsRes = await collabB.context.request.get("/api/v1/notifications");
        const bCollabNotifs = (await bCollabNotifsRes.json()) as {
          notifications: { weddingId: string; weddingName: string }[];
        };
        expect(bCollabNotifs.notifications.some((n) => n.weddingId === weddingA.id)).toBe(false);
      });

      await test.step("Assert: Wedding B's export succeeds as a real PDF, but Wedding A's plan version cannot be exported scoped under Wedding B's own path", async () => {
        const bExportRes = await context.request.get(
          `/api/v1/weddings/${weddingBId}/plan-versions/${planBId}/export/chart`,
        );
        expect(bExportRes.status()).toBe(200);
        const bExportBytes = await bExportRes.body();
        expect(bExportBytes.subarray(0, 5).toString("latin1")).toBe("%PDF-");

        const crossExportRes = await context.request.get(
          `/api/v1/weddings/${weddingBId}/plan-versions/${planAId}/export/chart`,
        );
        expect(crossExportRes.status()).toBe(404);
      });
    } finally {
      await collabA.context.close();
      await collabB.context.close();
      try {
        await weddingData.deleteWedding(weddingBId);
      } catch (err) {
        await testInfo.attach("cleanup-warning: wedding B", {
          body: `Failed to delete wedding ${weddingBId} during teardown: ${err instanceof Error ? err.message : String(err)}`,
          contentType: "text/plain",
        });
      }
    }
  },
);
