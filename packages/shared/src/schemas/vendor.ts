import { z } from "zod";
// TS-180: free text refuses hidden control characters (see ../safe-text).
import { safeText } from "../safe-text";
import { CONTACT_PHONE_MESSAGE, FIELD_LIMITS, isAllowedContactPhone } from "../field-limits";
import { expectedRevisionField } from "./common";

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
  name: safeText(FIELD_LIMITS.vendorName, { required: "Vendor name is required" }),
  category: vendorCategoryEnum,
  categoryOther: safeText(FIELD_LIMITS.vendorCategoryOther).optional().nullable(),
  contactName: safeText(FIELD_LIMITS.vendorContactName).optional().nullable(),
  // Same "blank means omitted, not invalid" treatment as a guest's own optional email.
  contactEmail: z
    .union([z.string().trim().max(FIELD_LIMITS.email).email("Not a valid email address"), z.literal(""), z.null()])
    .optional()
    .transform((v) => (v === "" ? null : v)),
  // TS-193: only the characters a phone number is written with (see ../field-limits).
  // TS-200: through .pipe, so the phone rule only runs on a value that passed safeText's checks
  // (its length first) -- a .refine here would also run on a value that was far too long.
  contactPhone: safeText(FIELD_LIMITS.vendorContactPhone)
    .pipe(z.string().refine(isAllowedContactPhone, CONTACT_PHONE_MESSAGE))
    .optional()
    .nullable(),
  costCents: costCentsField,
  contractNotes: safeText(FIELD_LIMITS.vendorContractNotes, { multiline: true }).optional().nullable(),
  // TS-114: "HH:MM" (24-hour), what an <input type="time"> sends. Blank clears it.
  arrivalTime: z
    .union([z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Use a time like 14:30"), z.literal(""), z.null()])
    .optional()
    .transform((v) => (v === "" ? null : v)),
});

export const createVendorSchema = vendorBaseSchema.superRefine(validateCategoryOther);
export type CreateVendorInput = z.infer<typeof createVendorSchema>;

// FR-7.7, extended to vendors: every edit accepts the revision the client last saw, so the server
// can detect a save that landed on top of a newer one instead of silently overwriting it.
// TS-174: bounded to what the database can store (see ./common).

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
  // TS-92: the budgetRevision the client last saw -- a stale save is refused (409) rather than
  // overwriting a collaborator's newer budget figure.
  expectedRevision: expectedRevisionField,
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
  // TS-114
  arrivalTime: string | null;
  /** Whether this vendor currently has a working read-only link. */
  shareLinkActive: boolean;
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
  // TS-92: send back as expectedRevision when changing the budget figure.
  budgetRevision: number;
}

// TS-114: POST .../vendors/:id/share-link -- regenerate replaces the link (the old one stops working).
export const vendorShareLinkActionSchema = z.object({ regenerate: z.boolean().optional() });

export interface VendorShareLinkDTO {
  url: string;
}

// TS-114: the vendor's read-only page. Deliberately has no costs, contract notes, budget, guest
// data or other vendors' contact details -- see getVendorViewByToken.
export interface VendorViewDTO {
  wedding: { name: string; eventDate: string | null; venueName: string | null };
  vendor: {
    name: string;
    category: VendorCategory;
    categoryOther: string | null;
    contactName: string | null;
    contactEmail: string | null;
    contactPhone: string | null;
    arrivalTime: string | null;
  };
  otherVendors: { name: string; category: VendorCategory; categoryOther: string | null; arrivalTime: string | null }[];
  timeline: { time: string; description: string }[];
}

// TS-97: GET /api/v1/vendor-suggestions -- a vendor from another wedding the planner owns. Only
// the details that carry over between weddings: never cost, contract notes or arrival time.
export interface VendorSuggestionDTO {
  name: string;
  category: VendorCategory;
  categoryOther: string | null;
  contactName: string | null;
  contactEmail: string | null;
  contactPhone: string | null;
}
