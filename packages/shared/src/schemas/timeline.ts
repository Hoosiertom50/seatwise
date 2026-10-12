import { z } from "zod";
// TS-180: free text refuses hidden control characters (see ../safe-text).
import { safeText } from "../safe-text";
import { FIELD_LIMITS } from "../field-limits";
import { expectedRevisionField } from "./common";

// TS-18 (Day-Of Timeline / Run-of-Show, FR-13.1/FR-13.2): a per-wedding chronological schedule of
// day-of events, entirely independent of guests/tables/rules/seating plans -- its own record,
// with its own comments (FR-13.3, see commentTargetTypeEnum in collaboration.ts).

// A plain zero-padded 24-hour clock-face label ("16:30"), not a real date/timestamp -- a
// run-of-show doesn't need timezones or dates, just times that sort correctly as plain text.
// TS-214: the message is in the app's own 12-hour words -- the time box shows "4:30 PM", and the
// planner never sees "HH:MM". An empty box (cleared while editing) gets the same message.
export const PICK_A_TIME_MESSAGE = "Pick a time, like 4:30 PM";
const timeLabel = z
  .string({ required_error: PICK_A_TIME_MESSAGE, invalid_type_error: PICK_A_TIME_MESSAGE })
  .regex(/^([01]\d|2[0-3]):[0-5]\d$/, PICK_A_TIME_MESSAGE);

export const createTimelineEntrySchema = z.object({
  time: timeLabel,
  // TS-214: "After midnight (next day)" -- listed after the wedding day's own entries.
  nextDay: z.boolean().optional(),
  description: safeText(FIELD_LIMITS.timelineDescription, { required: "A short description is required" }),
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
  // TS-214: after midnight -- shown "(next day)" and listed after the wedding day's own entries.
  nextDay: boolean;
  description: string;
  sortOrder: number;
  // TS-92: optimistic-concurrency counter -- send back as expectedRevision when editing.
  revision: number;
  createdAt: string;
  updatedAt: string;
}
