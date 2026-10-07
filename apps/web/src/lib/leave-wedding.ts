import { ApiError } from "./api-client";

/**
 * TS-235: "Leave this wedding" answered 404 still means the person is off the wedding. When the
 * first answer is lost, the retried leave is answered "Wedding not found" (they had already left),
 * which used to show as an error until the page caught up about 4 seconds later. A wedding deleted
 * meanwhile is the same for them: there is nothing left to leave.
 */
export function leaveCountsAsDone(err: unknown): boolean {
  return err instanceof ApiError && err.status === 404;
}
