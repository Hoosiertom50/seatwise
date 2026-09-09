import { NextResponse } from "next/server";
import type { ZodError } from "zod";

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
