import { NextResponse } from "next/server";
import type { ZodError } from "zod";
import { AccessChangedError, PlanSourceChangedError, isWeddingDeletedError } from "@seatwise/db";
import { BODY_TOO_LARGE_MESSAGE, declaresBodyTooLarge, isNonJsonBody, readBodyTextWithin } from "./json-body";

export function errorResponse(
  message: string,
  status = 400,
  fieldErrors?: Record<string, string[] | undefined>
) {
  return NextResponse.json({ error: message, fieldErrors }, { status });
}

export const SEND_AS_JSON = "Send this request as JSON.";

// TS-179: defence in depth for routes that read a JSON body. proxy.ts already refuses a write whose
// body isn't JSON, but a route shouldn't depend on that alone (a matcher change, or a route outside
// it, would quietly drop the check). Refuses a non-JSON body with 415; otherwise returns the parsed
// body, or null when it's empty or not valid JSON (the route's own schema then says what's wrong,
// as before).
export async function readJson(
  req: Request
): Promise<{ ok: true; body: unknown } | { ok: false; response: NextResponse }> {
  if (isNonJsonBody(req.headers)) return { ok: false, response: errorResponse(SEND_AS_JSON, 415) };
  // TS-200: a body over MAX_JSON_BODY_BYTES is refused (413) -- by its Content-Length before it's
  // read, or part-way through reading when it came without one.
  const tooLarge = { ok: false as const, response: errorResponse(BODY_TOO_LARGE_MESSAGE, 413) };
  if (declaresBodyTooLarge(req.headers)) return tooLarge;
  const text = await readBodyTextWithin(req.body).catch(() => "");
  if (text === null) return tooLarge;
  let body: unknown = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = null;
  }
  return { ok: true, body };
}

export function zodErrorResponse(error: ZodError) {
  return errorResponse(
    "Validation failed",
    422,
    error.flatten().fieldErrors as Record<string, string[] | undefined>
  );
}

// TS-173: a write that lost a race with another one -- a deadlock the database broke (40P01), or a
// guest or table deleted while a new plan was being made (23503) -- is "it changed, try again"
// (409), not a server error. Nothing was saved in either case. Returns null for anything else.
export function concurrentChangeResponse(err: unknown) {
  // TS-195: the wedding itself was deleted meanwhile, or the person's access dropped while the
  // change waited -- said as such, not as "the plan changed".
  const gone = weddingDeletedResponse(err);
  if (gone) return gone;
  if (err instanceof AccessChangedError) return errorResponse(err.message, 403);
  const code = (err as { code?: string } | null)?.code;
  // TS-187: 40001 too -- the current plan kept being replaced while a change waited for it (see
  // lockCurrentPlan in packages/db).
  if (code === "40P01" || code === "40001") {
    return errorResponse("Someone else changed this plan at the same moment — nothing was saved. Please try again.", 409);
  }
  if (code === "23503" || err instanceof PlanSourceChangedError) {
    return errorResponse(
      "The guest list or tables changed while this was being saved — nothing was saved. Please try again.",
      409
    );
  }
  return null;
}

export const WEDDING_DELETED_MESSAGE = "This wedding was deleted — nothing was saved.";

// TS-195: something added to a wedding (a guest, a table, a timeline entry, a vendor, a plan...)
// while the wedding was being deleted: the delete wins, and the database refuses the new row
// (23503 on its wedding) -- answered 404 "This wedding was deleted", not a server error. Returns
// null for anything else.
export function weddingDeletedResponse(err: unknown) {
  return isWeddingDeletedError(err) ? errorResponse(WEDDING_DELETED_MESSAGE, 404) : null;
}
