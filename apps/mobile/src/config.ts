// The web app's dev server binds to localhost:3000, but "localhost" means something different on
// every device this app can run on: the iOS Simulator can reach the Mac's own localhost directly,
// the Android emulator needs 10.0.2.2 to mean the same thing, and a real phone in Expo Go needs
// the Mac's actual LAN IP (e.g. http://192.168.1.23:3000) since it's a separate device on the same
// wifi. EXPO_PUBLIC_-prefixed env vars are inlined at bundle time by Expo, so this is set per how
// you're running it rather than hardcoded -- see apps/mobile/README.md for the exact value to use
// for each target. Falls back to the iOS Simulator's value since that's the fastest inner loop.
export const API_BASE_URL = process.env.EXPO_PUBLIC_API_BASE_URL ?? "http://localhost:3000";
