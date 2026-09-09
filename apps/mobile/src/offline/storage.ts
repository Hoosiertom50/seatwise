// A tiny key/value interface, implemented for real by AsyncStorage on-device and by a plain
// in-memory Map in tests -- so the queueing/caching logic in this folder can be unit-tested
// without a React Native runtime at all (no simulator, no Expo Go, just Node + jest).
export interface KeyValueStore {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
  removeItem(key: string): Promise<void>;
}

export function createInMemoryStore(): KeyValueStore {
  const map = new Map<string, string>();
  return {
    async getItem(key) {
      return map.has(key) ? map.get(key)! : null;
    },
    async setItem(key, value) {
      map.set(key, value);
    },
    async removeItem(key) {
      map.delete(key);
    },
  };
}

// Real, on-device implementation. Imported lazily by App.tsx/screens (not by the pure logic
// modules, which take a KeyValueStore as a parameter instead) so those stay importable from a
// plain Node jest run.
export function createAsyncStorageStore(): KeyValueStore {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const AsyncStorage = require("@react-native-async-storage/async-storage").default;
  return {
    getItem: (key) => AsyncStorage.getItem(key),
    setItem: (key, value) => AsyncStorage.setItem(key, value),
    removeItem: (key) => AsyncStorage.removeItem(key),
  };
}
