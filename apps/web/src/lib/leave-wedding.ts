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

/**
 * TS-253: the owner's "Delete this wedding" answered 404 means the wedding is gone -- usually a
 * retry after the first answer was lost, when the first try had already deleted it. That used to
 * show a red "Wedding not found" for a wedding that was deleted; now it goes to the dashboard like
 * a delete that worked.
 */
export function deleteCountsAsDone(err: unknown): boolean {
  return err instanceof ApiError && err.status === 404;
}
