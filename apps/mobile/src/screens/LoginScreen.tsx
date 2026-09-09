import { useState } from "react";
import { ActivityIndicator, Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import { createApiClient, ApiError, NetworkError } from "../api/client";
import { login, saveSession, type AuthSession } from "../api/auth";
import { API_BASE_URL } from "../config";
import type { KeyValueStore } from "../offline/storage";

export function LoginScreen({
  store,
  onLoggedIn,
}: {
  store: KeyValueStore;
  onLoggedIn: (session: AuthSession) => void;
}) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const api = createApiClient(API_BASE_URL, async () => null);

  async function submit() {
    setError(null);
    setBusy(true);
    try {
      const session = await login(api, email.trim(), password);
      await saveSession(store, session);
      onLoggedIn(session);
    } catch (err) {
      if (err instanceof NetworkError) {
        setError(`Couldn't reach the server at ${API_BASE_URL}. Check the API URL and your connection.`);
      } else if (err instanceof ApiError) {
        setError(err.message || "Login failed.");
      } else {
        setError("Something went wrong logging in.");
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <View style={styles.container}>
      <Text style={styles.title}>Seatwise</Text>
      <Text style={styles.subtitle}>On-site floor plan</Text>

      <TextInput
        style={styles.input}
        placeholder="Email"
        autoCapitalize="none"
        keyboardType="email-address"
        value={email}
        onChangeText={setEmail}
      />
      <TextInput
        style={styles.input}
        placeholder="Password"
        secureTextEntry
        value={password}
        onChangeText={setPassword}
      />

      {error && <Text style={styles.error}>{error}</Text>}

      <Pressable
        style={[styles.button, (busy || !email || !password) && styles.buttonDisabled]}
        disabled={busy || !email || !password}
        onPress={submit}
      >
        {busy ? <ActivityIndicator color="#fff" /> : <Text style={styles.buttonText}>Log in</Text>}
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, justifyContent: "center", padding: 24, backgroundColor: "#fff" },
  title: { fontSize: 28, fontWeight: "700", textAlign: "center" },
  subtitle: { fontSize: 14, color: "#6b7280", textAlign: "center", marginBottom: 32 },
  input: {
    borderWidth: 1,
    borderColor: "#d4d4d8",
    borderRadius: 8,
    paddingHorizontal: 14,
    paddingVertical: 12,
    marginBottom: 12,
    fontSize: 16,
  },
  button: { backgroundColor: "#18181b", borderRadius: 8, paddingVertical: 14, marginTop: 8 },
  buttonDisabled: { opacity: 0.5 },
  buttonText: { color: "#fff", textAlign: "center", fontWeight: "600", fontSize: 16 },
  error: { color: "#dc2626", marginBottom: 12, fontSize: 14 },
});
