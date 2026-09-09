import type { ApiClient } from "./client";
import type { KeyValueStore } from "../offline/storage";

// Same /api/v1/auth endpoints the web app's own signup/login forms call -- both return
// {user, token} (see apps/web/src/app/api/v1/auth/login/route.ts). The web app throws the token
// away and relies on the httpOnly cookie the response also sets; this app has no cookie jar, so
// it's the only copy of the token there is, and it's what every subsequent request sends back as
// `Authorization: Bearer <token>` (see api/client.ts).
export interface AuthUser {
  id: string;
  name: string;
  email: string;
}

export interface AuthSession {
  user: AuthUser;
  token: string;
}

const SESSION_KEY = "seatwise:session";

export async function login(api: ApiClient, email: string, password: string): Promise<AuthSession> {
  return api.post<AuthSession>("/api/v1/auth/login", { email, password });
}

export async function loadSession(store: KeyValueStore): Promise<AuthSession | null> {
  const raw = await store.getItem(SESSION_KEY);
  return raw ? (JSON.parse(raw) as AuthSession) : null;
}

export async function saveSession(store: KeyValueStore, session: AuthSession): Promise<void> {
  await store.setItem(SESSION_KEY, JSON.stringify(session));
}

export async function clearSession(store: KeyValueStore): Promise<void> {
  await store.removeItem(SESSION_KEY);
}
