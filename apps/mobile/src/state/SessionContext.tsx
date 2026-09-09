import { createContext, useContext } from "react";
import type { ApiClient } from "../api/client";
import type { AuthSession } from "../api/auth";
import type { KeyValueStore } from "../offline/storage";

// One small context instead of a navigation/state library -- this app is deliberately three
// screens (login, pick a wedding, the floor plan), per TS-21's narrow FR-16.1/FR-16.2 scope, so
// react-navigation/redux/etc. would be more machinery than the app needs.
export interface SessionContextValue {
  session: AuthSession;
  api: ApiClient;
  store: KeyValueStore;
  logout: () => void;
}

export const SessionContext = createContext<SessionContextValue | null>(null);

export function useSession(): SessionContextValue {
  const ctx = useContext(SessionContext);
  if (!ctx) throw new Error("useSession() called outside of a SessionContext.Provider");
  return ctx;
}
