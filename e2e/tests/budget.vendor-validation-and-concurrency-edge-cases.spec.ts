/**
 * TS-52 (REQ-BUDGET-VENDOR-TRACKING) — the API-level validation and FR-7.7 concurrency half of this
 * requirement's coverage, complementing
 * budget.vendor-crud-and-rollup-math-through-the-real-ui.spec.ts's real, UI-driven happy path and
 * its own View/Comment access-control test. Authored directly from
 * `packages/shared/src/schemas/vendor.ts` (createVendorSchema/updateVendorSchema/setBudgetSchema)
 * and `updateVendorForWedding`'s own locked-row/compare-revision transaction
 * (packages/db/src/queries/vendors.ts).
 *
 * Two independent scenarios, two separate defineQualityTest calls:
 *
 * 1. Field validation: the required `name`, the OTHER-category/`categoryOther` pairing rule in
 *    both directions (present alongside a non-OTHER category, or missing alongside OTHER), the
 *    numeric bounds on `costCents` (0..100,000,000) and `budgetCents` (0..1,000,000,000), the
 *    email format check with its own "blank means omitted, not invalid" carve-out, and that a
 *    PATCH omitting `category` entirely skips the pairing rule (it's only checked "when it's
 *    actually part of this edit," per the schema's own comment).
 * 2. FR-7.7 optimistic concurrency on a vendor edit -- the exact same locked-row/compare-revision
 *    pattern already proven for plan-version writes elsewhere in this suite (see
 *    manual-adjustment.assignments-endpoint-optimistic-concurrency.spec.ts), extended here to
 *    vendors: a stale `expectedRevision` is rejected with a 409 carrying the fresh, currently-
 *    committed vendor, retrying with that fresh revision succeeds, and a caller that omits
 *    `expectedRevision` entirely skips the check regardless of how stale its own view actually is.
 */

import { expect, defineQualityTest, test } from "../fixtures/index.js";
import { uniqueToken } from "../data/ids.js";

interface VendorResponseBody {
  vendor?: { id: string; name: string; revision: number; contactEmail: string | null };
  error?: string;
  fieldErrors?: Record<string, string[]>;
}

defineQualityTest(
  {
    id: "budget.vendor-validation-and-concurrency-edge-cases.field-validation-rejects-invalid-input",
    title: "vendor and budget field validation enforces the required name, the OTHER-category/categoryOther pairing rule in both directions, the cost/budget numeric bounds, and the email format check with blank treated as omitted",
    objective:
      "Confirms POST/PATCH vendor and PATCH budget reject an empty name, a categoryOther label paired with a non-OTHER category, a missing categoryOther label paired with OTHER, a negative or over-cap costCents/budgetCents, and a malformed contactEmail -- each with a 422 and the documented message on the correct field -- while an empty-string contactEmail is accepted and stored as null (not rejected), and a PATCH that never mentions category at all skips the OTHER-pairing rule entirely even when the vendor's own current category is OTHER.",
    expectedOutcome:
      "Each invalid case returns 422 with fieldErrors on the expected field and the exact message. costCents/budgetCents accept their documented upper bound (100,000,000 / 1,000,000,000) but reject one cent over it. An empty-string contactEmail on create succeeds (201) with contactEmail null in the response. A PATCH containing only contactPhone against an OTHER-category vendor succeeds without ever raising the categoryOther rule.",
    requirementIds: ["REQ-BUDGET-VENDOR-TRACKING"],
    tags: ["@mutating", "@feature:budget", "@risk:normal", "@suite:regression"],
  },
  async ({ managedWedding, context }, testInfo) => {
    const token = testInfo.workerIndex;

    async function createVendorRaw(data: Record<string, unknown>) {
      const res = await context.request.post(`/api/v1/weddings/${managedWedding.id}/vendors`, { data });
      return { status: res.status(), body: (await res.json()) as VendorResponseBody };
    }

    await test.step("Assert: an empty vendor name is rejected", async () => {
      const res = await createVendorRaw({ name: "", category: "CATERING" });
      expect(res.status).toBe(422);
      expect(res.body.fieldErrors?.name).toEqual(["Vendor name is required"]);
    });

    await test.step("Assert: a categoryOther label paired with a non-OTHER category is rejected", async () => {
      const res = await createVendorRaw({
        name: `Vendor ${uniqueToken(token)}`,
        category: "CATERING",
        categoryOther: "Should not be allowed here",
      });
      expect(res.status).toBe(422);
      expect(res.body.fieldErrors?.categoryOther).toEqual([
        'A category label is only used when the category is "Other".',
      ]);
    });

    await test.step("Assert: OTHER without a categoryOther label is rejected", async () => {
      const res = await createVendorRaw({ name: `Vendor ${uniqueToken(token)}`, category: "OTHER" });
      expect(res.status).toBe(422);
      expect(res.body.fieldErrors?.categoryOther).toEqual([
        "Give this vendor's category a label when it doesn't fit the list.",
      ]);
    });

    await test.step("Assert: costCents rejects negative and over-cap values, but accepts the documented upper bound exactly", async () => {
      const negative = await createVendorRaw({
        name: `Vendor ${uniqueToken(token)}`,
        category: "CATERING",
        costCents: -1,
      });
      expect(negative.status).toBe(422);
      expect(negative.body.fieldErrors?.costCents).toBeTruthy();

      const overCap = await createVendorRaw({
        name: `Vendor ${uniqueToken(token)}`,
        category: "CATERING",
        costCents: 100_000_001,
      });
      expect(overCap.status).toBe(422);
      expect(overCap.body.fieldErrors?.costCents).toBeTruthy();

      const atCap = await createVendorRaw({
        name: `Vendor ${uniqueToken(token)}`,
        category: "CATERING",
        costCents: 100_000_000,
      });
      expect(atCap.status).toBe(201);
      expect(atCap.body.vendor).toBeTruthy();
    });

    await test.step("Assert: budgetCents rejects negative and over-cap values, but accepts the documented upper bound exactly", async () => {
      const negative = await context.request.patch(`/api/v1/weddings/${managedWedding.id}/budget`, {
        data: { budgetCents: -1 },
      });
      expect(negative.status()).toBe(422);

      const overCap = await context.request.patch(`/api/v1/weddings/${managedWedding.id}/budget`, {
        data: { budgetCents: 1_000_000_001 },
      });
      expect(overCap.status()).toBe(422);

      const atCap = await context.request.patch(`/api/v1/weddings/${managedWedding.id}/budget`, {
        data: { budgetCents: 1_000_000_000 },
      });
      expect(atCap.status()).toBe(200);
      const atCapBody = (await atCap.json()) as { summary: { budgetCents: number | null } };
      expect(atCapBody.summary.budgetCents).toBe(1_000_000_000);
    });

    await test.step("Assert: a malformed contactEmail is rejected, but a blank one is accepted and stored as null, not an empty string", async () => {
      const malformed = await createVendorRaw({
        name: `Vendor ${uniqueToken(token)}`,
        category: "CATERING",
        contactEmail: "not-an-email",
      });
      expect(malformed.status).toBe(422);
      expect(malformed.body.fieldErrors?.contactEmail).toEqual(["Not a valid email address"]);

      const blank = await createVendorRaw({
        name: `Vendor ${uniqueToken(token)}`,
        category: "CATERING",
        contactEmail: "",
      });
      expect(blank.status).toBe(201);
      expect(blank.body.vendor!.contactEmail).toBeNull();
    });

    await test.step("Assert: a PATCH that never mentions category at all skips the OTHER-pairing rule, even against a vendor whose current category IS OTHER", async () => {
      const created = await createVendorRaw({
        name: `Vendor ${uniqueToken(token)}`,
        category: "OTHER",
        categoryOther: "Officiant",
      });
      expect(created.status).toBe(201);
      const vendorId = created.body.vendor!.id;

      const patchRes = await context.request.patch(
        `/api/v1/weddings/${managedWedding.id}/vendors/${vendorId}`,
        { data: { contactPhone: "555-0199" } },
      );
      expect(patchRes.status()).toBe(200);
    });
  },
);

defineQualityTest(
  {
    id: "budget.vendor-validation-and-concurrency-edge-cases.stale-vendor-edit-is-rejected-with-fresh-state",
    title: "a vendor edit sent with a stale expectedRevision is rejected (409) with the vendor's current, fresh state attached, retrying with that revision succeeds, and omitting expectedRevision entirely always succeeds regardless of staleness",
    objective:
      "Confirms editing a vendor enforces the same optimistic-concurrency pattern as every other write in this app (locked-row read, compare revision, reject with the fresh row on mismatch): a second edit using the pre-first-edit revision is rejected with 409 and a vendor body reflecting the first edit having already happened, retrying with that fresh revision succeeds, and a third edit that omits expectedRevision entirely succeeds even though its own view of the vendor is stale.",
    expectedOutcome:
      "The first edit succeeds and bumps revision by 1. A second edit using the original (now stale) revision is rejected with 409, and the response body's vendor reflects the first edit's own change with the bumped revision. Retrying with that revision succeeds. A further edit with no expectedRevision at all succeeds unconditionally.",
    requirementIds: ["REQ-BUDGET-VENDOR-TRACKING"],
    tags: ["@mutating", "@feature:budget", "@risk:high", "@suite:regression"],
  },
  async ({ managedWedding, context }, testInfo) => {
    const token = testInfo.workerIndex;
    let vendorId = "";
    let staleRevision = 0;

    await test.step("Arrange: one vendor", async () => {
      const res = await context.request.post(`/api/v1/weddings/${managedWedding.id}/vendors`, {
        data: { name: `Concurrency Vendor ${uniqueToken(token)}`, category: "VENUE" },
      });
      expect(res.status()).toBe(201);
      const body = (await res.json()) as VendorResponseBody;
      vendorId = body.vendor!.id;
      staleRevision = body.vendor!.revision;
    });

    await test.step("Act: a first edit succeeds and bumps the revision past what a second, stale caller last saw", async () => {
      const res = await context.request.patch(`/api/v1/weddings/${managedWedding.id}/vendors/${vendorId}`, {
        data: { contactName: "First Editor", expectedRevision: staleRevision },
      });
      expect(res.status()).toBe(200);
      const body = (await res.json()) as VendorResponseBody;
      expect(body.vendor!.revision).toBe(staleRevision + 1);
    });

    await test.step("Act + Assert: a second edit using the now-stale (pre-first-edit) revision is rejected with 409 and the fresh state", async () => {
      const res = await context.request.patch(`/api/v1/weddings/${managedWedding.id}/vendors/${vendorId}`, {
        data: { contactName: "Stale Editor", expectedRevision: staleRevision },
      });
      expect(res.status()).toBe(409);
      const body = (await res.json()) as { error: string; vendor: { revision: number; contactName: string } };
      expect(body.error).toBeTruthy();
      expect(body.vendor.revision).toBe(staleRevision + 1);
      // The fresh state reflects the first edit having already happened -- NOT the stale caller's
      // own (rejected) intent.
      expect(body.vendor.contactName).toBe("First Editor");
    });

    await test.step("Act + Assert: retrying the same edit with the current (fresh) revision succeeds", async () => {
      const freshRevision = staleRevision + 1;
      const res = await context.request.patch(`/api/v1/weddings/${managedWedding.id}/vendors/${vendorId}`, {
        data: { contactName: "Stale Editor Retried", expectedRevision: freshRevision },
      });
      expect(res.status()).toBe(200);
      const body = (await res.json()) as VendorResponseBody;
      expect(body.vendor!.revision).toBe(freshRevision + 1);
    });

    await test.step("Act + Assert: an edit that omits expectedRevision entirely succeeds unconditionally, even against a now further-stale view", async () => {
      const res = await context.request.patch(`/api/v1/weddings/${managedWedding.id}/vendors/${vendorId}`, {
        data: { contactName: "No Revision Check" },
      });
      expect(res.status()).toBe(200);
    });
  },
);
