import { useEffect, useState } from "react";
import { ActivityIndicator, View } from "react-native";
import { StatusBar } from "expo-status-bar";
import type { WeddingSummaryDTO } from "@seatwise/shared";
import { createApiClient, type ApiClient } from "./src/api/client";
import { clearSession, loadSession, type AuthSession } from "./src/api/auth";
import { createAsyncStorageStore } from "./src/offline/storage";
import { API_BASE_URL } from "./src/config";
import { SessionContext } from "./src/state/SessionContext";
import { LoginScreen } from "./src/screens/LoginScreen";
import { WeddingListScreen } from "./src/screens/WeddingListScreen";
import { FloorPlanScreen } from "./src/screens/FloorPlanScreen";

const store = createAsyncStorageStore();

// FR-16.1/FR-16.2 only (on-site floor-plan view/adjust, tolerant of spotty venue connectivity) --
// FR-16.3 defers everything else, so this app is deliberately three screens with no navigation
// library: log in, pick a wedding, view/adjust its floor plan.
export default function App() {
  const [bootstrapping, setBootstrapping] = useState(true);
  const [session, setSession] = useState<AuthSession | null>(null);
  const [wedding, setWedding] = useState<WeddingSummaryDTO | null>(null);

  useEffect(() => {
    loadSession(store)
      .then(setSession)
      .finally(() => setBootstrapping(false));
  }, []);

  if (bootstrapping) {
    return (
      <View style={{ flex: 1, alignItems: "center", justifyContent: "center" }}>
        <ActivityIndicator />
      </View>
    );
  }

  if (!session) {
    return (
      <>
        <LoginScreen store={store} onLoggedIn={setSession} />
        <StatusBar style="auto" />
      </>
    );
  }

  const api: ApiClient = createApiClient(API_BASE_URL, async () => {
    const current = await loadSession(store);
    return current?.token ?? null;
  });

  async function logout() {
    await clearSession(store);
    setWedding(null);
    setSession(null);
  }

  return (
    <SessionContext.Provider value={{ session, api, store, logout }}>
      {wedding ? (
        <FloorPlanScreen wedding={wedding} onBack={() => setWedding(null)} />
      ) : (
        <WeddingListScreen onSelect={setWedding} />
      )}
      <StatusBar style="auto" />
    </SessionContext.Provider>
  );
}
