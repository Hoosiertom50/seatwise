import { NextResponse } from "next/server";
import { APPROVED_PLAN_NOT_CONFIRMED } from "./plan-approval-text";

// TS-237: Generate or Restore refused because the approved plan it would replace isn't the one the
// person confirmed (approved meanwhile, or not shown on their page). Nothing was saved. The answer
// names the approved version, so the screen can ask again and send it back.
export function approvedPlanNotConfirmedResponse(err: { message: string; approvedVersionId: string }) {
  return NextResponse.json(
    { error: err.message, code: APPROVED_PLAN_NOT_CONFIRMED, approvedVersionId: err.approvedVersionId },
    { status: 409 }
  );
}
