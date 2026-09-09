import { z } from "zod";

// FR-3.4: how much generation weights table composition toward mixing the two sides. Always a
// soft preference — see packages/shared/src/seating-engine.ts.
export const sideMixingEnum = z.enum(["KEEP_SEPARATE", "BALANCED_MIX", "FULLY_MIXED"]);
export type SideMixing = z.infer<typeof sideMixingEnum>;

const weddingBaseSchema = z.object({
  name: z.string().min(1, "Wedding name is required").max(200),
  eventDate: z.string().date().optional().nullable(),
  venueName: z.string().max(200).optional().nullable(),
  // FR-1.3: "an optional note" -- always optional, blank is fine (AC: creating with the note left
  // blank saves with no error).
  note: z.string().max(2000).optional().nullable(),
  sideMixing: sideMixingEnum.default("BALANCED_MIX"),
  // FR-1.3a: this wedding's own name for each side (e.g. "Bride"/"Groom") -- a display label
  // only. Renaming never touches the underlying GuestSide value (BRIDE/GROOM/BOTH) stored on any
  // guest, so no guest, rule, or assignment is recreated or lost when these change.
  sideLabel1: z.string().min(1, "Side label is required").max(40).default("Bride"),
  sideLabel2: z.string().min(1, "Side label is required").max(40).default("Groom"),
  // TS-17 (FR-12.2): the cutoff after which a guest's own RSVP link becomes read-only. Optional --
  // omitting it (or explicitly clearing it) means no cutoff at all, matching the FR's "or none"
  // language exactly.
  rsvpCutoffDate: z.string().date().optional().nullable(),
});

// TS-19 (FR-14.4): "start this new wedding from an existing template" is only ever offered at
// creation time -- not a later update -- so these fields live only on createWeddingSchema, never
// on updateWeddingSchema below. templateId alone picks nothing; the planner must also check at
// least one of applyTemplateTables/applyTemplateRules (mirroring FR-14.4's own "table layout
// and/or rule-shape" phrasing), or the request is rejected rather than silently applying nothing.
export const createWeddingSchema = weddingBaseSchema
  .extend({
    templateId: z.string().min(1).optional(),
    applyTemplateTables: z.boolean().default(false),
    applyTemplateRules: z.boolean().default(false),
  })
  .superRefine((data, ctx) => {
    if (data.templateId && !data.applyTemplateTables && !data.applyTemplateRules) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Pick at least one part of the template to use: its table layout, its rule-shape, or both.",
        path: ["templateId"],
      });
    }
  });
export type CreateWeddingInput = z.infer<typeof createWeddingSchema>;

export const updateWeddingSchema = weddingBaseSchema.partial();
export type UpdateWeddingInput = z.infer<typeof updateWeddingSchema>;

export interface WeddingDTO {
  id: string;
  ownerId: string;
  name: string;
  eventDate: string | null;
  venueName: string | null;
  // FR-1.3
  note: string | null;
  guestCount: number;
  // FR-10.2: per-wedding opt-out for the email side of notifications (the in-app notification
  // itself always fires regardless).
  emailNotificationsEnabled: boolean;
  // FR-3.4
  sideMixing: SideMixing;
  // FR-1.3a
  sideLabel1: string;
  sideLabel2: string;
  // TS-17 (FR-12.2): null means no RSVP cutoff at all.
  rsvpCutoffDate: string | null;
  createdAt: string;
  updatedAt: string;
}

// FR-11.2 (TS-16): the planner-portfolio dashboard's row shape -- everything WeddingDTO has, plus
// the Current Plan Version's status and its unassigned/Needs Reassignment counts, so a planner can
// tell whether a wedding needs attention without opening it. Only the dashboard list endpoint
// (`GET /api/v1/weddings`) returns this; every other wedding read still returns plain WeddingDTO.
export interface WeddingSummaryDTO extends WeddingDTO {
  // null: no plan version has been generated for this wedding yet ("No plan yet").
  planStatus: "DRAFT" | "IN_REVIEW" | "APPROVED" | null;
  unassignedCount: number;
  needsReassignmentCount: number;
}
