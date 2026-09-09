import { z } from "zod";
import type { SideMixing } from "./wedding";
import type { TableShape, TablePurposeCriterionType } from "./table";

// TS-19 (FR-14.1/FR-14.2): a template is a reusable snapshot of a wedding's table layout plus its
// "rule-shape" (currently just the Side-Mixing setting -- see the SeatingTemplate model comment in
// schema.prisma for why guest-specific relationships are never part of a template at all). Saving
// one always captures both pieces together from one source wedding, in one action; FR-14.3's
// all-or-nothing-vs-composable question is resolved on the *apply* side instead (see
// applyTemplateFields below) -- composable, but only at the two-piece granularity FR-14.4 itself
// names ("table layout and/or rule-shape"), not per-table or per-field.
export const saveWeddingAsTemplateSchema = z.object({
  name: z.string().min(1, "Template name is required").max(150),
});
export type SaveWeddingAsTemplateInput = z.infer<typeof saveWeddingAsTemplateSchema>;

// FR-14.4: the two independently-toggleable pieces a planner can pull from a template when
// creating a new wedding. Both default false -- picking a template without checking either box
// would save nothing, so the wedding-creation schema requires at least one once a templateId is
// given (see createWeddingSchema's superRefine in wedding.ts).
export const applyTemplateFieldsSchema = z.object({
  templateId: z.string().min(1).optional(),
  applyTemplateTables: z.boolean().default(false),
  applyTemplateRules: z.boolean().default(false),
});
export type ApplyTemplateFieldsInput = z.infer<typeof applyTemplateFieldsSchema>;

export interface SeatingTemplateTableDTO {
  id: string;
  label: string;
  capacity: number;
  isRestricted: boolean;
  isAccessible: boolean;
  isLocked: boolean;
  purpose: string | null;
  purposeCriterionType: TablePurposeCriterionType | null;
  purposeCriterionValue: string | null;
  singleSideOnly: boolean;
  shape: TableShape;
  positionX: number | null;
  positionY: number | null;
  sortOrder: number;
}

export interface SeatingTemplateDTO {
  id: string;
  ownerId: string;
  name: string;
  // FR-14.1's "provenance" display only -- null once the source wedding has been deleted (the
  // template itself still stands; see the SeatingTemplate model comment).
  sourceWeddingId: string | null;
  sourceWeddingName: string | null;
  // FR-14.2: the rule-shape piece.
  sideMixing: SideMixing;
  tableCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface SeatingTemplateDetailDTO extends SeatingTemplateDTO {
  tables: SeatingTemplateTableDTO[];
}
