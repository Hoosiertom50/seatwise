import { z } from "zod";
import { expectedRevisionField } from "./common";

// TS-18 (Day-Of Timeline / Run-of-Show, FR-13.1/FR-13.2): a per-wedding chronological schedule of
// day-of events, entirely independent of guests/tables/rules/seating plans -- its own record,
// with its own comments (FR-13.3, see commentTargetTypeEnum in collaboration.ts).

// A plain zero-padded 24-hour clock-face label ("16:30"), not a real date/timestamp -- a
// run-of-show doesn't need timezones or dates, just times that sort correctly as plain text.
const timeLabel = z
  .string()
  .regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Enter a time as HH:MM (24-hour), e.g. 16:30");

export const createTimelineEntrySchema = z.object({
  time: timeLabel,
  description: z.string().min(1, "A short description is required").max(300),
});
export type CreateTimelineEntryInput = z.infer<typeof createTimelineEntrySchema>;

// TS-92: expectedRevision is the entry revision the client last saw -- a save based on a stale copy
// is refused (409, with the fresh entry) instead of overwriting a collaborator's edit.
export const updateTimelineEntrySchema = createTimelineEntrySchema.partial().extend({
  expectedRevision: expectedRevisionField,
});
export type UpdateTimelineEntryInput = z.infer<typeof updateTimelineEntrySchema>;

// FR-13.2: "reordered" -- moves an entry earlier or later among any other entries sharing its
// exact same `time` (see reorderTimelineEntry in packages/db/src/queries/timeline.ts). Entries are
// always listed by (time, sortOrder), so this is the only kind of reordering that changes display
// order without also changing `time` itself -- keeping the list "always chronological" (FR-13.1).
export const reorderTimelineEntrySchema = z.object({
  direction: z.enum(["UP", "DOWN"]),
});
export type ReorderTimelineEntryInput = z.infer<typeof reorderTimelineEntrySchema>;

export interface TimelineEntryDTO {
  id: string;
  weddingId: string;
  time: string;
  description: string;
  sortOrder: number;
  // TS-92: optimistic-concurrency counter -- send back as expectedRevision when editing.
  revision: number;
  createdAt: string;
  updatedAt: string;
}
