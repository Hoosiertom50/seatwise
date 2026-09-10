// Stage 01 (spec Section 7.3/9.3): typed, validated environment configuration for the Playwright
// framework. Every value the framework reads from process.env is parsed here, once, through a zod
// schema -- an invalid or missing value fails fast with an actionable message instead of quietly
// misconfiguring a test run.
import { z } from "zod";

const envSchema = z.object({
  // Base URL for the app under test. Defaults to local dev, matching apps/web/.env's own default.
  APP_URL: z
    .string()
    .url("APP_URL must be a valid absolute URL, e.g. http://localhost:3000")
    .default("http://localhost:3000"),

  // Comma-separated list of hostnames that are recognized as production. Intentionally empty by
  // default (see spec Decision Log DEC-005): this repo has no real production deployment yet, so
  // nothing should ever be silently treated as production until a human configures a real host.
  PRODUCTION_HOSTNAMES: z
    .string()
    .optional()
    .default("")
    .transform((raw) =>
      raw
        .split(",")
        .map((h) => h.trim().toLowerCase())
        .filter((h) => h.length > 0)
    ),

  // Explicit human approval to run against a recognized production host. This is a second,
  // independent gate on top of PRODUCTION_HOSTNAMES -- per spec Section 9.3, "A production run
  // must require an explicit production flag in addition to a production URL."
  PLAYWRIGHT_ALLOW_PRODUCTION: z
    .enum(["0", "1"])
    .optional()
    .default("0")
    .transform((v) => v === "1"),

  // Standard CI signal most CI providers set automatically; used to pick retries/workers.
  CI: z
    .string()
    .optional()
    .transform((v) => Boolean(v && v !== "false" && v !== "0")),
});

export type PlaywrightEnv = z.infer<typeof envSchema>;

let cached: PlaywrightEnv | undefined;

/**
 * Parse and validate the framework's environment configuration. Cached after the first successful
 * call within a process. Throws with a readable, field-by-field message on invalid input rather
 * than letting a malformed value silently propagate into a test run.
 */
export function getEnv(source: NodeJS.ProcessEnv = process.env): PlaywrightEnv {
  if (cached) return cached;

  const result = envSchema.safeParse(source);
  if (!result.success) {
    const issues = result.error.issues
      .map((issue) => `  - ${issue.path.join(".") || "(root)"}: ${issue.message}`)
      .join("\n");
    throw new Error(`Invalid Playwright framework environment configuration:\n${issues}`);
  }

  cached = result.data;
  return cached;
}

/** Test-only escape hatch: clears the cached env so a test can call getEnv() with a fresh source. */
export function __resetEnvCacheForTests(): void {
  cached = undefined;
}
