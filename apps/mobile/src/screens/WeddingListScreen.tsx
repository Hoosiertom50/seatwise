import { useEffect, useState } from "react";
import { ActivityIndicator, FlatList, Pressable, StyleSheet, Text, View } from "react-native";
import type { WeddingSummaryDTO } from "@seatwise/shared";
import { useSession } from "../state/SessionContext";

// FR-16.3 explicitly defers the portfolio dashboard to a later story -- this is not that. It's
// the minimum a planner needs to get from "logged in" to "the one wedding's floor plan I'm here
// for": no summary counts, no create/edit, no collaborators -- just enough to pick which wedding.
export function WeddingListScreen({ onSelect }: { onSelect: (wedding: WeddingSummaryDTO) => void }) {
  const { api, logout } = useSession();
  const [weddings, setWeddings] = useState<WeddingSummaryDTO[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    api
      .get<{ weddings: WeddingSummaryDTO[] }>("/api/v1/weddings")
      .then((res) => {
        if (!cancelled) setWeddings(res.weddings);
      })
      .catch(() => {
        if (!cancelled) setError("Couldn't load your weddings.");
      });
    return () => {
      cancelled = true;
    };
  }, [api]);

  if (error) {
    return (
      <View style={styles.center}>
        <Text style={styles.error}>{error}</Text>
        <Pressable onPress={logout}>
          <Text style={styles.link}>Log out</Text>
        </Pressable>
      </View>
    );
  }

  if (!weddings) {
    return (
      <View style={styles.center}>
        <ActivityIndicator />
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <Text style={styles.title}>Your weddings</Text>
        <Pressable onPress={logout}>
          <Text style={styles.link}>Log out</Text>
        </Pressable>
      </View>
      {weddings.length === 0 ? (
        <Text style={styles.empty}>No weddings yet -- create one on the web app first.</Text>
      ) : (
        <FlatList
          data={weddings}
          keyExtractor={(w) => w.id}
          renderItem={({ item }) => (
            <Pressable style={styles.row} onPress={() => onSelect(item)}>
              <Text style={styles.rowTitle}>{item.name}</Text>
              <Text style={styles.rowSubtitle}>
                {item.unassignedCount > 0 ? `${item.unassignedCount} unassigned` : "Everyone seated"}
                {item.needsReassignmentCount > 0 ? ` · ${item.needsReassignmentCount} need reassignment` : ""}
              </Text>
            </Pressable>
          )}
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#fff", paddingTop: 56 },
  center: { flex: 1, alignItems: "center", justifyContent: "center", padding: 24, gap: 12 },
  header: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    paddingHorizontal: 20,
    marginBottom: 12,
  },
  title: { fontSize: 22, fontWeight: "700" },
  link: { color: "#2563eb", fontSize: 14 },
  empty: { textAlign: "center", color: "#6b7280", marginTop: 40 },
  error: { color: "#dc2626" },
  row: { paddingHorizontal: 20, paddingVertical: 16, borderBottomWidth: 1, borderBottomColor: "#f4f4f5" },
  rowTitle: { fontSize: 17, fontWeight: "600" },
  rowSubtitle: { fontSize: 13, color: "#6b7280", marginTop: 4 },
});
