import { NextResponse } from "next/server";
import type { ZodError } from "zod";
import { PlanSourceChangedError } from "@seatwise/db";

export function errorResponse(
  message: string,
  status = 400,
  fieldErrors?: Record<string, string[] | undefined>
) {
  return NextResponse.json({ error: message, fieldErrors }, { status });
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
  const code = (err as { code?: string } | null)?.code;
  if (code === "40P01") {
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
