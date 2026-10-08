import { NextRequest, NextResponse } from "next/server";
import { getAuthUser } from "@/lib/session";
import { errorResponse } from "@/lib/api-response";
import { accountEmailCounters, confirmationNetworkCounters, countOr429, EMAIL_VERIFICATION_LIMITS } from "@/lib/rate-limit";
import { emailNotSentMessage, sendVerificationEmail } from "@/lib/email-verification";
import { emailDelivered, emailMayHaveGone } from "@seatwise/db";

// TS-164: "Resend link" -- emails the signed-in account a fresh confirmation link.
export async function POST(req: NextRequest) {
  const user = await getAuthUser(req);
  if (!user) return errorResponse("Not authenticated", 401);
  if (user.emailVerifiedAt !== null) return NextResponse.json({ sent: false, alreadyVerified: true });

  const counters = [
    { key: `verify-email:resend:${user.id}`, ...EMAIL_VERIFICATION_LIMITS.resendsPerAccount },
    // TS-168: per day too, per account and per network address.
    { key: `verify-email:resend:day:${user.id}`, ...EMAIL_VERIFICATION_LIMITS.resendsPerAccountDay },
    // TS-171: counted with sign-ups and password resets from the same address. TS-194: this is now
    // the only per-address count for resends (10 a day, with sign-ups and resets). TS-203: rolling
    // over 24 hours, and for IPv6 the /48 as well (see accountEmailCounters).
    ...accountEmailCounters(req),
    // TS-238: and this network's slice of the confirmations' shared share (5 a day per IPv4 /24 or
    // IPv6 /48, real sends only) -- given back with the rest if nothing is sent.
    ...confirmationNetworkCounters(req),
  ];
  // TS-186: each count can be given back from exactly the window it was made in -- and all of them
  // are, when a later limit refuses the request.
  const counted: (() => Promise<void>)[] = [];
  // TS-248: every give-back is tried, even when one of them fails (each failure is logged).
  const giveBackAll = async () => {
    const settled = await Promise.allSettled(counted.splice(0).reverse().map((giveBack) => giveBack()));
    for (const r of settled) {
      if (r.status === "rejected") {
        console.error(`[verification-email] couldn't give back a count: ${r.reason instanceof Error ? r.reason.message : String(r.reason)}`);
      }
    }
  };
  // TS-248: whatever is counted is given back on every way out that sends nothing -- a refusal, an
  // unsent email, or an error part-way (a counter failing, say) -- like sign-up. It used to be kept
  // when a counter threw, so the hits taken before it were used up with no email sent.
  let keepCounts = false;
  try {
    for (const { key, limit, windowSeconds } of counters) {
      const { limited, giveBack } = await countOr429(key, { limit, windowSeconds });
      if (limited) return limited;
      counted.push(giveBack);
    }

    const result = await sendVerificationEmail(user);
    // TS-178: nothing went out, so this try doesn't use up any of the allowances above. TS-203:
    // unless it may have gone out after all ("uncertain") -- then it stays counted.
    keepCounts = emailMayHaveGone(result);
    if (!emailDelivered(result)) {
      // TS-194: no email service set up is a 503 (the site can't send), not a passing hiccup.
      const status = result === "limited" || result === "recipient-limited" ? 429 : result === "not-configured" ? 503 : 502;
      return errorResponse(emailNotSentMessage(result), status);
    }
    return NextResponse.json({ sent: true });
  } finally {
    if (!keepCounts) await giveBackAll();
  }
}
