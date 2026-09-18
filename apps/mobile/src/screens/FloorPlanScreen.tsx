import { useCallback, useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import NetInfo from "@react-native-community/netinfo";
import type {
  GuestDTO,
  PlanVersionDetailDTO,
  SeatingTableDTO,
  WeddingSummaryDTO,
} from "@seatwise/shared";
import { useSession } from "../state/SessionContext";
import { ApiError, NetworkError } from "../api/client";
import { moveGuest, MoveConflictError, MoveRejectedError } from "../api/planVersions";
import {
  enqueueMove,
  loadQueue,
  readCachedPlan,
  rebaseQueue,
  replayQueue,
  saveQueue,
  writeCachedPlan,
  type QueuedMove,
} from "../offline/queue";
import {
  applyLocalMove,
  buildFloorPlanViewModel,
  findGuest,
  type SeatedGuest,
  type TableViewModel,
} from "../planMerge";

// FR-7.1's own fixed box footprint, sized to hold a table's label, capacity and scrollable guest
// list on a phone. This is a content card, not a scale drawing of the table.
//
// It is deliberately NOT shape-aware, unlike the Tables-tab floor plan on web (TS-106), which now
// draws each shape's real proportions. Applying shape here would mean shrinking the box's height
// for oval/rectangular tables and clipping the guest list -- the thing a planner is on this screen
// to read. Tom's call on 2026-09-18: leave mobile as-is and revisit when the mobile floor plan is
// properly built out under TS-95, with the app in hand on a real device.
//
// Note this footprint does NOT reproduce web's layout: web's Tables-tab boxes are 96x96 (132x84
// for oval/rectangular) against 168x160 here, so positionX/positionY laid out on web do not
// translate to identical spacing on mobile. An earlier version of this comment claimed the two
// were matched; they never were.
const BOX_WIDTH = 168;
const BOX_HEIGHT = 160;
const FALLBACK_COLUMNS = 3;

export function FloorPlanScreen({
  wedding,
  onBack,
}: {
  wedding: WeddingSummaryDTO;
  onBack: () => void;
}) {
  const { api, store } = useSession();
  const weddingId = wedding.id;

  const [tables, setTables] = useState<SeatingTableDTO[] | null>(null);
  const [guests, setGuests] = useState<GuestDTO[] | null>(null);
  const [planVersion, setPlanVersion] = useState<PlanVersionDetailDTO | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [selectedGuestId, setSelectedGuestId] = useState<string | null>(null);
  const [isOnline, setIsOnline] = useState(true);
  const [pendingCount, setPendingCount] = useState(0);
  const [conflictMessage, setConflictMessage] = useState<string | null>(null);
  const [syncing, setSyncing] = useState(false);

  // Avoids two syncs racing each other (a NetInfo transition firing right as the mount effect's
  // own sync is already running).
  const syncingRef = useRef(false);

  const planVersionId = planVersion?.id ?? null;

  const refreshPendingCount = useCallback(async () => {
    const queue = await loadQueue(store, weddingId);
    setPendingCount(queue.length);
    return queue;
  }, [store, weddingId]);

  // FR-16.2: show the last-known plan immediately from local cache (no spinner-then-blank if the
  // network is slow or down), then try to load the live version underneath it.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const cached = await readCachedPlan(store, weddingId);
      if (cached && !cancelled) setPlanVersion(cached.planVersion);
      await refreshPendingCount();

      try {
        const [tablesRes, guestsRes, versionsRes] = await Promise.all([
          api.get<{ tables: SeatingTableDTO[] }>(`/api/v1/weddings/${weddingId}/tables`),
          api.get<{ guests: GuestDTO[] }>(`/api/v1/weddings/${weddingId}/guests`),
          api.get<{ planVersions: { id: string; isCurrent: boolean }[] }>(
            `/api/v1/weddings/${weddingId}/plan-versions`
          ),
        ]);
        if (cancelled) return;
        setTables(tablesRes.tables);
        setGuests(guestsRes.guests);

        // FR-5.6 (TS-8): a Comparison Draft can be generated with a higher versionNumber than the
        // actual Current version and never replace it, so "highest version number" and "current"
        // are no longer the same thing -- the on-site floor plan must follow isCurrent explicitly,
        // same as every web-side call site does (see plan-versions.ts on the server).
        const currentId =
          versionsRes.planVersions.find((v) => v.isCurrent)?.id ?? versionsRes.planVersions[0]?.id;
        if (currentId) {
          const detail = await api.get<{ planVersion: PlanVersionDetailDTO }>(
            `/api/v1/weddings/${weddingId}/plan-versions/${currentId}`
          );
          if (cancelled) return;
          setPlanVersion(detail.planVersion);
          await writeCachedPlan(store, {
            weddingId,
            planVersionId: detail.planVersion.id,
            planVersion: detail.planVersion,
            cachedAt: new Date().toISOString(),
          });
        }
      } catch (err) {
        if (cancelled) return;
        if (err instanceof NetworkError) {
          if (!cached) setLoadError("Offline, and nothing cached yet for this wedding.");
          // else: we already showed the cached plan above -- offline is fine, not an error.
        } else {
          setLoadError("Couldn't load this wedding's seating plan.");
        }
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [weddingId]);

  // FR-16.2: "once connectivity returns" -- sync automatically on the transition back to online,
  // not only when the planner happens to reopen the app.
  useEffect(() => {
    const unsubscribe = NetInfo.addEventListener((state) => {
      const online = Boolean(state.isConnected) && state.isInternetReachable !== false;
      setIsOnline((wasOnline) => {
        if (!wasOnline && online) void syncPendingMoves();
        return online;
      });
    });
    return () => unsubscribe();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [weddingId, planVersionId]);

  async function syncPendingMoves() {
    if (syncingRef.current || !planVersionId) return;
    syncingRef.current = true;
    setSyncing(true);
    try {
      // A rejection mid-replay means the assumptions the *rest* of the queue was built on (each
      // move's expectedRevision) are stale -- refetch the truth and rebase before continuing.
      // Bounded so a pathological server response can't spin this forever.
      for (let attempt = 0; attempt < 10; attempt++) {
        const queue = await loadQueue(store, weddingId);
        if (queue.length === 0) break;

        const result = await replayQueue(
          (move) => moveGuest(api, weddingId, planVersionId, move.guestId, move.tableId, move.expectedRevision),
          queue
        );

        if (result.outcome === "empty") break;

        if (result.outcome === "synced") {
          await writeCachedPlan(store, {
            weddingId,
            planVersionId: result.planVersion.id,
            planVersion: result.planVersion,
            cachedAt: new Date().toISOString(),
          });
          await saveQueue(store, weddingId, []);
          setPlanVersion(result.planVersion);
          break;
        }

        if (result.outcome === "conflict") {
          await writeCachedPlan(store, {
            weddingId,
            planVersionId: result.planVersion.id,
            planVersion: result.planVersion,
            cachedAt: new Date().toISOString(),
          });
          // Per AC2: never silently reapply the rest of the queue on top of a change that landed
          // first. The still-pending moves are surfaced (not lost) so the planner can review and
          // manually redo whichever still make sense against the fresh plan below.
          const remainingDescriptions = result.remaining
            .map((m) => `${m.guestName} → ${m.tableId ? m.tableLabel ?? "a table" : "Unassigned"}`)
            .join(", ");
          setConflictMessage(
            `${result.message}${
              result.remaining.length > 0
                ? ` ${result.remaining.length} pending move(s) weren't synced and need review: ${remainingDescriptions}.`
                : ""
            }`
          );
          await saveQueue(store, weddingId, []);
          setPlanVersion(result.planVersion);
          break;
        }

        if (result.outcome === "rejected") {
          // Re-fetch the server's actual current state -- a rejection never bumps its revision,
          // so this also folds in whatever *did* succeed earlier in this same replay pass.
          const fresh = await api.get<{ planVersion: PlanVersionDetailDTO }>(
            `/api/v1/weddings/${weddingId}/plan-versions/${planVersionId}`
          );
          Alert.alert("A pending move couldn't be applied", `${result.move.guestName}: ${result.message}`);
          const rebased = rebaseQueue(result.remaining, fresh.planVersion.revision);
          await saveQueue(store, weddingId, rebased);
          await writeCachedPlan(store, {
            weddingId,
            planVersionId: fresh.planVersion.id,
            planVersion: fresh.planVersion,
            cachedAt: new Date().toISOString(),
          });
          setPlanVersion(fresh.planVersion);
          continue; // try the rebased remainder
        }

        if (result.outcome === "offline") {
          break; // NetInfo will fire again on the next reconnect
        }
      }
    } catch {
      // Best-effort -- the next reconnect or manual "Sync now" tries again.
    } finally {
      await refreshPendingCount();
      syncingRef.current = false;
      setSyncing(false);
    }
  }

  async function onSelectGuest(guestId: string) {
    setSelectedGuestId((cur) => (cur === guestId ? null : guestId));
  }

  async function onMoveSelectedTo(toTableId: string | null, toTable: SeatingTableDTO | undefined) {
    if (!selectedGuestId || !planVersion || !guests || !planVersionId) return;
    const guest = findGuest(guests, selectedGuestId);
    if (!guest) return;

    const alreadyThere =
      toTableId === null
        ? planVersion.unassignedGuestIds.includes(guest.id)
        : planVersion.assignments.some((a) => a.guestId === guest.id && a.tableId === toTableId);
    setSelectedGuestId(null);
    if (alreadyThere) return;

    const baseRevision = planVersion.revision;
    const optimistic = applyLocalMove(planVersion, guest, toTableId, toTable);
    setPlanVersion(optimistic);
    await writeCachedPlan(store, {
      weddingId,
      planVersionId: optimistic.id,
      planVersion: optimistic,
      cachedAt: new Date().toISOString(),
    });

    if (!isOnline) {
      await queueThisMove(guest, toTableId, toTable, baseRevision);
      return;
    }

    try {
      const res = await moveGuest(api, weddingId, planVersionId, guest.id, toTableId, baseRevision);
      setPlanVersion(res.planVersion);
      await writeCachedPlan(store, {
        weddingId,
        planVersionId: res.planVersion.id,
        planVersion: res.planVersion,
        cachedAt: new Date().toISOString(),
      });
      if (res.warnings.length > 0) {
        Alert.alert("Move applied with a warning", res.warnings.join("\n"));
      }
    } catch (err) {
      if (err instanceof NetworkError) {
        setIsOnline(false);
        await queueThisMove(guest, toTableId, toTable, baseRevision);
        return;
      }
      if (err instanceof MoveConflictError) {
        setConflictMessage(err.message);
        setPlanVersion(err.planVersion);
        await writeCachedPlan(store, {
          weddingId,
          planVersionId: err.planVersion.id,
          planVersion: err.planVersion,
          cachedAt: new Date().toISOString(),
        });
        return;
      }
      if (err instanceof MoveRejectedError) {
        Alert.alert("That move isn't allowed", err.message);
        setPlanVersion(planVersion); // revert the optimistic change
        await writeCachedPlan(store, {
          weddingId,
          planVersionId: planVersion.id,
          planVersion,
          cachedAt: new Date().toISOString(),
        });
        return;
      }
      Alert.alert("Something went wrong", err instanceof ApiError ? err.message : "Please try again.");
      setPlanVersion(planVersion);
    }
  }

  async function queueThisMove(
    guest: GuestDTO,
    toTableId: string | null,
    toTable: SeatingTableDTO | undefined,
    expectedRevision: number
  ) {
    const move: QueuedMove = {
      guestId: guest.id,
      guestName: `${guest.firstName} ${guest.lastName}`,
      tableId: toTableId,
      tableLabel: toTable?.label ?? null,
      expectedRevision,
      queuedAt: new Date().toISOString(),
    };
    await enqueueMove(store, weddingId, move);
    await refreshPendingCount();
  }

  if (loadError) {
    return (
      <View style={styles.center}>
        <Text style={styles.error}>{loadError}</Text>
        <Pressable onPress={onBack}>
          <Text style={styles.link}>Back to weddings</Text>
        </Pressable>
      </View>
    );
  }

  if (!planVersion || !tables || !guests) {
    return (
      <View style={styles.center}>
        <ActivityIndicator />
      </View>
    );
  }

  const vm = buildFloorPlanViewModel(tables, guests, planVersion);
  const width = Math.max(760, ...tables.map((t) => (t.positionX ?? 20) + BOX_WIDTH + 20));
  const positionedCount = tables.filter((t) => t.positionX !== null && t.positionY !== null).length;
  const fallbackRows = Math.ceil(Math.max(0, tables.length - positionedCount) / FALLBACK_COLUMNS);
  const height = Math.max(
    480,
    ...tables.map((t) => (t.positionY ?? 20) + BOX_HEIGHT + 20),
    positionedCount === 0 ? fallbackRows * (BOX_HEIGHT + 20) + 20 : 0
  );

  let fallbackIndex = 0;

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <Pressable onPress={onBack}>
          <Text style={styles.link}>{"< Weddings"}</Text>
        </Pressable>
        <Text style={styles.title} numberOfLines={1}>
          {wedding.name}
        </Text>
        <View style={styles.statusRow}>
          <View style={[styles.dot, isOnline ? styles.dotOnline : styles.dotOffline]} />
          {pendingCount > 0 && <Text style={styles.pendingBadge}>{pendingCount} pending</Text>}
        </View>
      </View>

      {conflictMessage && (
        <View style={styles.conflictBanner}>
          <Text style={styles.conflictText}>{conflictMessage}</Text>
          <Pressable onPress={() => setConflictMessage(null)}>
            <Text style={styles.link}>Dismiss</Text>
          </Pressable>
        </View>
      )}

      {pendingCount > 0 && isOnline && (
        <Pressable style={styles.syncButton} onPress={() => void syncPendingMoves()} disabled={syncing}>
          <Text style={styles.syncButtonText}>{syncing ? "Syncing..." : `Sync ${pendingCount} pending move(s)`}</Text>
        </Pressable>
      )}

      <View style={styles.trayWrap}>
        <Text style={styles.trayLabel}>
          Unassigned{selectedGuestId ? " — tap here to move the selected guest back" : ""}
        </Text>
        <Pressable
          style={styles.tray}
          onPress={() => selectedGuestId && onMoveSelectedTo(null, undefined)}
        >
          <ScrollView horizontal showsHorizontalScrollIndicator={false}>
            <View style={styles.chipRow}>
              {vm.unassigned.length === 0 && <Text style={styles.emptyTray}>Everyone's seated</Text>}
              {vm.unassigned.map((sg) => (
                <GuestChip
                  key={sg.guest.id}
                  seated={sg}
                  selected={selectedGuestId === sg.guest.id}
                  onPress={() => onSelectGuest(sg.guest.id)}
                />
              ))}
            </View>
          </ScrollView>
        </Pressable>
      </View>

      <ScrollView>
        <ScrollView horizontal>
          <View style={{ width, height }}>
            {tables.map((table) => {
              const tvm = vm.tables.find((t) => t.table.id === table.id)!;
              const hasPosition = table.positionX !== null && table.positionY !== null;
              const left = hasPosition ? table.positionX! : (fallbackIndex % FALLBACK_COLUMNS) * (BOX_WIDTH + 20) + 20;
              const top = hasPosition
                ? table.positionY!
                : Math.floor(fallbackIndex / FALLBACK_COLUMNS) * (BOX_HEIGHT + 20) + 20;
              if (!hasPosition) fallbackIndex++;

              return (
                <TableBox
                  key={table.id}
                  vm={tvm}
                  left={left}
                  top={top}
                  selectable={Boolean(selectedGuestId)}
                  onPress={() => onMoveSelectedTo(table.id, table)}
                  onGuestPress={onSelectGuest}
                  selectedGuestId={selectedGuestId}
                />
              );
            })}
          </View>
        </ScrollView>
      </ScrollView>
    </View>
  );
}

function GuestChip({
  seated,
  selected,
  onPress,
}: {
  seated: SeatedGuest;
  selected: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      onPress={onPress}
      style={[
        styles.chip,
        selected && styles.chipSelected,
        seated.needsReassignment && styles.chipWarning,
        seated.pendingSync && styles.chipPending,
      ]}
    >
      <Text style={[styles.chipText, selected && styles.chipTextSelected]}>
        {seated.guest.firstName} {seated.guest.lastName}
        {seated.pendingSync ? " ⏳" : ""}
      </Text>
    </Pressable>
  );
}

function TableBox({
  vm,
  left,
  top,
  selectable,
  onPress,
  onGuestPress,
  selectedGuestId,
}: {
  vm: TableViewModel;
  left: number;
  top: number;
  selectable: boolean;
  onPress: () => void;
  onGuestPress: (guestId: string) => void;
  selectedGuestId: string | null;
}) {
  return (
    <Pressable
      onPress={selectable ? onPress : undefined}
      style={[
        styles.tableBox,
        { left, top, width: BOX_WIDTH, height: BOX_HEIGHT },
        selectable && styles.tableBoxSelectable,
      ]}
    >
      <Text style={styles.tableLabel} numberOfLines={1}>
        {vm.table.label}
      </Text>
      <Text style={styles.tableCapacity}>
        {vm.seated.length}/{vm.table.capacity}
      </Text>
      <ScrollView style={styles.tableGuestList}>
        <View style={styles.chipColumn}>
          {vm.seated.length === 0 && <Text style={styles.emptyTray}>Empty</Text>}
          {vm.seated.map((sg) => (
            <GuestChip
              key={sg.guest.id}
              seated={sg}
              selected={selectedGuestId === sg.guest.id}
              onPress={() => onGuestPress(sg.guest.id)}
            />
          ))}
        </View>
      </ScrollView>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#fafafa" },
  center: { flex: 1, alignItems: "center", justifyContent: "center", padding: 24, gap: 12 },
  header: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    paddingTop: 56,
    paddingHorizontal: 16,
    paddingBottom: 10,
    backgroundColor: "#fff",
    borderBottomWidth: 1,
    borderBottomColor: "#e4e4e7",
  },
  title: { flex: 1, fontSize: 16, fontWeight: "700" },
  link: { color: "#2563eb", fontSize: 14 },
  error: { color: "#dc2626", textAlign: "center" },
  statusRow: { flexDirection: "row", alignItems: "center", gap: 6 },
  dot: { width: 8, height: 8, borderRadius: 4 },
  dotOnline: { backgroundColor: "#22c55e" },
  dotOffline: { backgroundColor: "#f59e0b" },
  pendingBadge: { fontSize: 11, color: "#92400e", backgroundColor: "#fef3c7", borderRadius: 8, paddingHorizontal: 6, paddingVertical: 2 },
  conflictBanner: {
    backgroundColor: "#fef2f2",
    borderBottomWidth: 1,
    borderBottomColor: "#fecaca",
    padding: 10,
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    gap: 8,
  },
  conflictText: { flex: 1, color: "#991b1b", fontSize: 13 },
  syncButton: { backgroundColor: "#18181b", margin: 10, borderRadius: 8, paddingVertical: 10 },
  syncButtonText: { color: "#fff", textAlign: "center", fontWeight: "600", fontSize: 13 },
  trayWrap: { backgroundColor: "#fff", borderBottomWidth: 1, borderBottomColor: "#e4e4e7", paddingBottom: 8 },
  trayLabel: { fontSize: 11, color: "#71717a", paddingHorizontal: 16, paddingTop: 8, paddingBottom: 4 },
  tray: { minHeight: 40 },
  chipRow: { flexDirection: "row", gap: 6, paddingHorizontal: 16 },
  chipColumn: { gap: 4 },
  emptyTray: { fontSize: 12, color: "#a1a1aa", paddingVertical: 6 },
  chip: {
    borderWidth: 1,
    borderColor: "#d4d4d8",
    borderRadius: 999,
    paddingHorizontal: 8,
    paddingVertical: 4,
    backgroundColor: "#fff",
  },
  chipSelected: { backgroundColor: "#18181b", borderColor: "#18181b" },
  chipWarning: { borderColor: "#f59e0b", backgroundColor: "#fffbeb" },
  chipPending: { borderStyle: "dashed" },
  chipText: { fontSize: 12, color: "#18181b" },
  chipTextSelected: { color: "#fff" },
  tableBox: {
    position: "absolute",
    borderWidth: 2,
    borderColor: "#d4d4d8",
    borderRadius: 8,
    backgroundColor: "#fff",
    padding: 8,
  },
  tableBoxSelectable: { borderColor: "#2563eb" },
  tableLabel: { fontSize: 13, fontWeight: "700" },
  tableCapacity: { fontSize: 11, color: "#71717a", marginBottom: 4 },
  tableGuestList: { flex: 1 },
});
