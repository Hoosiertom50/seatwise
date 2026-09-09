import { NextRequest } from "next/server";
import { findUserById, type UserRow } from "@seatwise/db";
import { verifyToken, AUTH_COOKIE_NAME } from "./auth";

export async function getAuthUser(req: NextRequest): Promise<UserRow | null> {
  let token: string | undefined;

  const authHeader = req.headers.get("authorization");
  if (authHeader?.startsWith("Bearer ")) {
    token = authHeader.slice("Bearer ".length);
  } else {
    token = req.cookies.get(AUTH_COOKIE_NAME)?.value;
  }

  if (!token) return null;
  const payload = await verifyToken(token);
  if (!payload) return null;

  return findUserById(payload.sub);
}
