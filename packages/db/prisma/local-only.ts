// TS-172: the one-off scripts in this folder that create or delete data only ever run against a
// database on this machine (or CI's throwaway one) -- never the live site. Import this first:
// it loads packages/db/.env (as load-env does) and then stops the script, before anything
// connects, unless DATABASE_URL points at a local host. An exported DATABASE_URL wins over the
// .env file (dotenv never overrides one), so this checks whatever the script would actually use.
import "./load-env";

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]", "postgres"]);

export function databaseHost(url = process.env.DATABASE_URL): string {
  try {
    return new URL(url ?? "").hostname;
  } catch {
    return "";
  }
}

export function isLocalDatabase(url = process.env.DATABASE_URL): boolean {
  return LOCAL_HOSTS.has(databaseHost(url));
}

if (!isLocalDatabase()) {
  console.error(
    `Refusing to run: DATABASE_URL points at "${databaseHost() || "(unset)"}", not a database on this machine. ` +
      `These scripts are for local development only.`
  );
  process.exit(1);
}
