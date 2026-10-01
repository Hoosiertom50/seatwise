import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { deleteUserAccount, findUserById } from "@seatwise/db";
import { getAuthUser } from "@/lib/session";
import { errorResponse, zodErrorResponse } from "@/lib/api-response";
import { AUTH_COOKIE_NAME, isSecureCookieContext, verifyPassword } from "@/lib/auth";

export async function GET(req: NextRequest) {
  const user = await getAuthUser(req);
  if (!user) return errorResponse("Not authenticated", 401);
  return NextResponse.json({ user: { id: user.id, name: user.name, email: user.email } });
}

const deleteSchema = z.object({ password: z.string().min(1, "Enter your password to confirm") });

// TS-105: delete my own account. Needs the password, and is refused (409, with the list) while
// the account still owns any wedding -- those must be handed off first, so no wedding is ever
// left with nobody in charge.
export async function DELETE(req: NextRequest) {
  const user = await getAuthUser(req);
  if (!user) return errorResponse("Not authenticated", 401);

  const parsed = deleteSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return zodErrorResponse(parsed.error);

  const record = await findUserById(user.id);
  if (!record || !(await verifyPassword(parsed.data.password, record.passwordHash))) {
    return errorResponse("That password isn't right.", 403);
  }

  const result = await deleteUserAccount(user.id);
  if (!result.deleted) {
    return NextResponse.json(
      {
        error: "Hand off every wedding you own before deleting your account.",
        ownedWeddings: result.ownedWeddings,
      },
      { status: 409 }
    );
  }

  const response = NextResponse.json({ ok: true });
  // Same attributes as the cookie was set with (see logout's TS-65 note).
  response.cookies.set(AUTH_COOKIE_NAME, "", {
    httpOnly: true,
    secure: isSecureCookieContext(),
    sameSite: "lax",
    path: "/",
    maxAge: 0,
  });
  return response;
}
