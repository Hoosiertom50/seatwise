import { NextRequest, NextResponse } from "next/server";
import { createSampleWedding, SampleWeddingLeftBehindError } from "@seatwise/db";
import { getAuthUser } from "@/lib/session";
import { errorResponse } from "@/lib/api-response";
import { mayAddSampleWedding } from "@/lib/sample-wedding-access";
import {
  countOr429,
  SAMPLE_WEDDING_LIMITS,
  sampleWeddingKey,
  TOO_MANY_SAMPLE_WEDDINGS_TODAY,
  TOO_MANY_WEDDINGS_TODAY,
  WEDDING_CREATE_LIMITS,
  weddingCreateKey,
} from "@/lib/rate-limit";

// TS-272: the team's "Add a sample wedding" button (dashboard). Only for confirmed accounts on the
// domains in SAMPLE_WEDDING_EMAIL_DOMAINS (see sample-wedding-access.ts); everyone else is told
// only "no" -- never which domains are allowed.

/** Whether this account may use the button (the dashboard shows it only then). */
export async function GET(req: NextRequest) {
  const user = await getAuthUser(req);
  if (!user) return errorResponse("Not authenticated", 401);
  return NextResponse.json({ available: mayAddSampleWedding(user, process.env) });
}

/** Makes a sample wedding in this account and answers its id. */
export async function POST(req: NextRequest) {
  const user = await getAuthUser(req);
  if (!user) return errorResponse("Not authenticated", 401);
  // Not on the list: answered as if there were nothing here.
  if (!mayAddSampleWedding(user, process.env)) return errorResponse("Not found", 404);

  // 3 a day per account, and each counts as a new wedding too. Given back if none is made.
  const sample = await countOr429(sampleWeddingKey(user.id), SAMPLE_WEDDING_LIMITS.perAccountDay, TOO_MANY_SAMPLE_WEDDINGS_TODAY);
  if (sample.limited) return sample.limited;
  // PR #120 review: if this check itself fails (not just "too many"), the sample count is given back too.
  const wedding = await countOr429(weddingCreateKey(user.id), WEDDING_CREATE_LIMITS.perAccountDay, TOO_MANY_WEDDINGS_TODAY).catch(async (err) => {
    await sample.giveBack().catch(() => undefined);
    throw err;
  });
  if (wedding.limited) {
    await sample.giveBack();
    return wedding.limited;
  }

  try {
    const started = Date.now();
    const weddingId = await createSampleWedding(user.id, new Date().toISOString().slice(0, 10));
    // How long making it took, readable in the browser's network tools (it must stay well under
    // Netlify's ~10 s limit on a request).
    return NextResponse.json({ weddingId }, { status: 201, headers: { "Server-Timing": `sample;desc="Making the sample wedding";dur=${Date.now() - started}` } });
  } catch (err) {
    // No wedding was left: both counts are given back, each tried on its own, and the build's own
    // error is the one passed on. A half-made wedding that couldn't be removed is still in the
    // account, so it stays counted (PR #120 review).
    if (!(err instanceof SampleWeddingLeftBehindError)) {
      await Promise.allSettled([sample.giveBack(), wedding.giveBack()]);
    }
    throw err;
  }
}
