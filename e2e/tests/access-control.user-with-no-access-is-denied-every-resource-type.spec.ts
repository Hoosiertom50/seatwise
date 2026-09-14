/**
 * TS-39 (REQ-ACCESS-CONTROL) — converts AC-076 ("A user with no access cannot reach another
 * wedding's data directly"). The workbook's own test steps ask for a sweep across resource types
 * by direct URL/identifier, not just one endpoint -- guests, tables, rules, plan versions,
 * vendors, timeline, exports, invitation actions, and notification-target requests -- using a
 * second user account, so this test builds one real wedding with data across those areas and
 * attempts every one of them as a completely unrelated, freshly signed-up second account.
 *
 * Every one of the app's wedding-scoped routes gates on `requireAccess()`
 * (apps/web/src/lib/access.ts), which returns 404 "Wedding not found" for a user with zero access
 * to the wedding -- not 403 -- so a wrong-tenant request is indistinguishable from a wedding that
 * doesn't exist at all, and confirms no Wedding X data (not even its existence) is disclosed.
 *
 * AC-077 ("guest personal data is protected in transit and at rest") is NOT converted here: its
 * own precondition is "have approved security verification inspect network transport and stored
 * application data" -- a security-team infrastructure audit (TLS configuration, at-rest database
 * encryption, retention/deletion policy), not a UI or API behavior a Playwright test can exercise.
 * Flagging this as out of scope for test automation rather than writing a test that can't actually
 * verify what the case describes.
 */

import { expect, defineQualityTest, test } from "../fixtures/index.js";
import { uniquePersonName } from "../data/ids.js";
import { signUpFreshAccount } from "../support/auth.js";

defineQualityTest(
  {
    id: "access-control.user-with-no-access-is-denied-every-resource-type.cross-tenant-sweep",
    title: "a user with no access to a wedding is denied direct access to every one of its resource types",
    objective:
      "Confirms that a completely unrelated, freshly signed-up second account cannot read or write another wedding's guests, tables, rules, plan versions, vendors, timeline, guest export, invites, or notification settings by direct id -- and that the denial itself discloses nothing about the wedding.",
    expectedOutcome:
      "Every attempted request against Wedding X's resources, made as the second account, is denied (404 'Wedding not found') and no response body contains Wedding X's name, guest names, or any other of its data.",
    requirementIds: ["REQ-ACCESS-CONTROL"],
    tags: ["@mutating", "@feature:non-functional", "@risk:critical", "@suite:regression"],
  },
  async ({ managedWedding, weddingData, context, request, evidence }, testInfo) => {
    const guestA = uniquePersonName(testInfo.workerIndex);
    const guestB = uniquePersonName(testInfo.workerIndex);
    let guestAId = "";
    let relationshipId = "";
    let tableId = "";
    let planVersionId = "";

    await test.step("Arrange: as the owner, populate Wedding X with a guest, a table, a rule, and a generated plan version", async () => {
      const a = await weddingData.createGuest(managedWedding.id, guestA);
      const b = await weddingData.createGuest(managedWedding.id, guestB);
      guestAId = a.id;
      const [table] = await weddingData.quickCreateTables(managedWedding.id, { count: 1, capacity: 8 });
      tableId = table.id;
      const relationship = await weddingData.createRelationship(managedWedding.id, a.id, b.id, "PREFER_NEAR");
      relationshipId = relationship.id;

      const genRes = await context.request.post(`/api/v1/weddings/${managedWedding.id}/plan-versions/generate`);
      expect(genRes.ok()).toBe(true);
      const genBody = (await genRes.json()) as { planVersion: { id: string } };
      planVersionId = genBody.planVersion.id;
    });

    const intruder = await test.step("Arrange: sign up a completely unrelated second account (no invite, no collaboration)", async () => {
      return signUpFreshAccount(request, testInfo.workerIndex);
    });

    await test.step("Sanity check: the second account is genuinely authenticated, and Wedding X isn't in its own wedding list", async () => {
      const res = await request.get("/api/v1/weddings");
      expect(res.status()).toBe(200);
      const body = (await res.json()) as { weddings: { id: string }[] };
      expect(body.weddings.some((w) => w.id === managedWedding.id)).toBe(false);
    });

    const attempts: { label: string; method: "get" | "post" | "patch" | "delete"; path: string; data?: unknown }[] = [
      { label: "read the wedding itself", method: "get", path: `/api/v1/weddings/${managedWedding.id}` },
      { label: "read the guest list", method: "get", path: `/api/v1/weddings/${managedWedding.id}/guests` },
      {
        label: "read one specific guest's data by id",
        method: "get",
        path: `/api/v1/weddings/${managedWedding.id}/guests/${guestAId}`,
      },
      {
        label: "write: create a guest under Wedding X",
        method: "post",
        path: `/api/v1/weddings/${managedWedding.id}/guests`,
        data: { firstName: "Intruder", lastName: "Guest" },
      },
      { label: "read the table list", method: "get", path: `/api/v1/weddings/${managedWedding.id}/tables` },
      {
        // The single-table route only exposes PATCH/DELETE (no GET) -- a write attempt on a
        // specific existing table id, which does gate on requireAccess.
        label: "write: relabel one specific table by id",
        method: "patch",
        path: `/api/v1/weddings/${managedWedding.id}/tables/${tableId}`,
        data: { label: "Intruder Table" },
      },
      { label: "read the seating rules (relationships) list", method: "get", path: `/api/v1/weddings/${managedWedding.id}/relationships` },
      {
        // The single-relationship route only exposes DELETE (no GET) -- a write attempt on a
        // specific existing rule id, which does gate on requireAccess.
        label: "write: delete one specific rule by id",
        method: "delete",
        path: `/api/v1/weddings/${managedWedding.id}/relationships/${relationshipId}`,
      },
      { label: "read the plan-versions list", method: "get", path: `/api/v1/weddings/${managedWedding.id}/plan-versions` },
      {
        label: "read one specific plan version's assignments by id",
        method: "get",
        path: `/api/v1/weddings/${managedWedding.id}/plan-versions/${planVersionId}`,
      },
      { label: "read the vendor list", method: "get", path: `/api/v1/weddings/${managedWedding.id}/vendors` },
      { label: "read the day-of timeline", method: "get", path: `/api/v1/weddings/${managedWedding.id}/timeline-entries` },
      {
        label: "file request: export the guest list",
        method: "get",
        path: `/api/v1/weddings/${managedWedding.id}/guests/export`,
      },
      { label: "invitation actions: read pending invites", method: "get", path: `/api/v1/weddings/${managedWedding.id}/invites` },
      {
        // The notification-settings route only exposes PATCH (no GET).
        label: "notification-target requests: change notification settings",
        method: "patch",
        path: `/api/v1/weddings/${managedWedding.id}/notification-settings`,
        data: { emailNotificationsEnabled: false },
      },
    ];

    for (const attempt of attempts) {
      await test.step(`Assert: ${attempt.label} is denied and discloses nothing`, async () => {
        const res =
          attempt.method === "get"
            ? await request.get(attempt.path)
            : attempt.method === "post"
              ? await request.post(attempt.path, { data: attempt.data })
              : attempt.method === "patch"
                ? await request.patch(attempt.path, { data: attempt.data })
                : await request.delete(attempt.path);
        expect(res.status()).toBe(404);
        const rawBody = await res.text();
        expect(rawBody).not.toContain(managedWedding.name);
        expect(rawBody).not.toContain(guestA.firstName);
        expect(rawBody).not.toContain(guestA.lastName);
      });
    }

    await evidence.checkpoint(
      "cross-tenant-access-denied",
      `All ${attempts.length} direct-access attempts against Wedding X's resources were denied (404) for the unrelated account ${intruder.email}, disclosing none of its data.`,
    );
  },
);
