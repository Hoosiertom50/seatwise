import { z } from "zod";

// TS-20 (FR-15.1): FR-15.1's own list of examples, plus the handful of other common wedding
// vendor types -- OTHER (with categoryOther holding the free-text label) covers anything not
// named here, the same enum-plus-free-text-value split used by the Purpose table criterion.
export const vendorCategoryEnum = z.enum([
  "CATERING",
  "VENUE",
  "FLORIST",
  "PHOTOGRAPHY",
  "VIDEOGRAPHY",
  "MUSIC_ENTERTAINMENT",
  "ATTIRE",
  "CAKE_BAKERY",
  "RENTALS",
  "TRANSPORTATION",
  "STATIONERY",
  "OTHER",
]);
export type VendorCategory = z.infer<typeof vendorCategoryEnum>;

// FR-15.1: money is always whole cents (an integer), never a float or a decimal string -- see the
// Vendor model comment in schema.prisma for why. Optional/nullable: a vendor can be recorded
// before its cost is finalized.
const costCentsField = z.number().int().min(0).max(100_000_000).optional().nullable();

// Same pairing rule as the Purpose table criterion: the free-text label only means anything
// alongside category === "OTHER", and OTHER without a label would show nothing useful in a vendor
// list, so both directions are validated. Shared between create (category always present) and
// update (category only checked when it's actually part of this edit).
function validateCategoryOther(
  data: { category?: VendorCategory; categoryOther?: string | null },
  ctx: z.RefinementCtx
) {
  if (data.category === undefined) return;
  if (data.category === "OTHER" && !data.categoryOther) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "Give this vendor's category a label when it doesn't fit the list.",
      path: ["categoryOther"],
    });
  }
  if (data.category !== "OTHER" && data.categoryOther) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'A category label is only used when the category is "Other".',
      path: ["categoryOther"],
    });
  }
}

const vendorBaseSchema = z.object({
  name: z.string().min(1, "Vendor name is required").max(200),
  category: vendorCategoryEnum,
  categoryOther: z.string().max(100).optional().nullable(),
  contactName: z.string().max(200).optional().nullable(),
  // Same "blank means omitted, not invalid" treatment as a guest's own optional email.
  contactEmail: z
    .union([z.string().trim().max(320).email("Not a valid email address"), z.literal(""), z.null()])
    .optional()
    .transform((v) => (v === "" ? null : v)),
  contactPhone: z.string().max(40).optional().nullable(),
  costCents: costCentsField,
  contractNotes: z.string().max(4000).optional().nullable(),
});

export const createVendorSchema = vendorBaseSchema.superRefine(validateCategoryOther);
export type CreateVendorInput = z.infer<typeof createVendorSchema>;

// FR-7.7, extended to vendors: every edit accepts the revision the client last saw, so the server
// can detect a save that landed on top of a newer one instead of silently overwriting it.
const expectedRevisionField = z.number().int().nonnegative().optional();

export const updateVendorSchema = vendorBaseSchema
  .partial()
  .extend({ expectedRevision: expectedRevisionField })
  .superRefine(validateCategoryOther);
export type UpdateVendorInput = z.infer<typeof updateVendorSchema>;

// FR-15.2: the wedding-wide budget figure, set independently of any one vendor. Nullable --
// clearing it means no budget has been set, matching budgetCents' own "optional" framing in
// FR-15.2 rather than requiring a wedding to have one before vendors can be tracked at all.
export const setBudgetSchema = z.object({
  budgetCents: z.number().int().min(0).max(1_000_000_000).nullable(),
});
export type SetBudgetInput = z.infer<typeof setBudgetSchema>;

export interface VendorDTO {
  id: string;
  weddingId: string;
  name: string;
  category: VendorCategory;
  categoryOther: string | null;
  contactName: string | null;
  contactEmail: string | null;
  contactPhone: string | null;
  costCents: number | null;
  contractNotes: string | null;
  createdAt: string;
  updatedAt: string;
  // FR-7.7: send this back as expectedRevision on an edit so the server can detect a save based
  // on stale data.
  revision: number;
}

// FR-15.2: the running-total view shown alongside the vendor list -- totalCostCents sums every
// vendor's costCents (nulls treated as 0), and remainingCents is only meaningful once a budget is
// actually set (null budgetCents -- no figure to compare against yet -- is null remainingCents
// too, never a nonsensical "remaining" against nothing).
export interface BudgetSummaryDTO {
  budgetCents: number | null;
  totalCostCents: number;
  remainingCents: number | null;
}
