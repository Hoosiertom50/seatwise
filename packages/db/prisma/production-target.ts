// TS-183: the one way a script in this folder may run against the live site's database. Only the
// scripts named in local-only.ts's PRODUCTION_CAPABLE_SCRIPTS can use it (never a cleanup script),
// and only when run with --target-production. Everything else stays local-only.
//
// How it works:
//   * The production connection string is read from PRODUCTION_DATABASE_URL, or typed at a prompt
//     that doesn't echo. It is never taken from a command-line argument and never printed (only its
//     host is shown, so you can see which database you're about to touch).
//   * It replaces DATABASE_URL in this process before the script loads the database code, so the
//     script's shared pool connects to it. The script must import "../src/index" dynamically, after
//     calling useProductionDatabase() -- a static import would already have connected locally.
//   * Each script stays a dry run unless it's also given --confirm.
//
// Usage pattern (from the repo root; secrets typed, not shown or saved in shell history):
//   read -rs PRODUCTION_DATABASE_URL && export PRODUCTION_DATABASE_URL
//   pnpm --filter @seatwise/db <script> -- --target-production            # dry run
//   pnpm --filter @seatwise/db <script> -- --target-production --confirm  # writes
// or leave PRODUCTION_DATABASE_URL unset and the script asks for it.
import { productionOptIn, databaseHost, isLocalDatabase } from "./local-only";

export const TARGET_PRODUCTION_FLAG = "--target-production";

/** True when this run is the production opt-in (the flag, on a script that allows it). */
export function targetsProduction(): boolean {
  return productionOptIn();
}

/** Reads a secret from the environment, or asks for it without echoing what's typed. */
export async function readSecret(envName: string, prompt: string): Promise<string> {
  const fromEnv = process.env[envName]?.trim();
  if (fromEnv) return fromEnv;
  if (!process.stdin.isTTY) {
    throw new Error(`${envName} is not set, and there's no terminal to ask for it. Set it (e.g. read -rs ${envName}).`);
  }
  return askSecret(prompt);
}

/** TS-192: always asks at the terminal (never reads the environment), without echoing what's typed. */
export async function askSecret(prompt: string): Promise<string> {
  if (!process.stdin.isTTY) throw new Error("There's no terminal to type into -- run this from a terminal.");
  return new Promise<string>((resolve, reject) => {
    const stdin = process.stdin;
    let value = "";
    process.stdout.write(prompt);
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding("utf8");
    const done = (err?: Error) => {
      stdin.setRawMode(false);
      stdin.pause();
      stdin.removeListener("data", onData);
      process.stdout.write("\n");
      if (err) reject(err);
      else resolve(value.trim());
    };
    const onData = (chunk: string) => {
      for (const ch of chunk) {
        if (ch === "\r" || ch === "\n") return done();
        if (ch === "\u0003") return done(new Error("Cancelled."));
        if (ch === "\u007f" || ch === "\b") value = value.slice(0, -1);
        else value += ch;
      }
    };
    stdin.on("data", onData);
  });
}

/**
 * Points this process at the production database (PRODUCTION_DATABASE_URL, or asked for). Call it
 * before importing "../src/index". Refuses a URL that is actually a local database, so the flag
 * can't be used by mistake to mean "local".
 */
export async function useProductionDatabase(): Promise<void> {
  const url = await readSecret("PRODUCTION_DATABASE_URL", "Production DATABASE_URL (not shown): ");
  if (!url) throw new Error("No production DATABASE_URL given.");
  if (isLocalDatabase(url)) {
    throw new Error("--target-production was given, but that DATABASE_URL is a database on this machine -- refusing.");
  }
  process.env.DATABASE_URL = url;
  console.log(`Target: PRODUCTION database at ${databaseHost(url) || "(unknown host)"}.`);
}
