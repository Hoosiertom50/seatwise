// Stage 01 (spec Section 7.3/9.3): the fail-closed guard that stands between a test selection and
// running anything mutating against a real production environment. Pure functions, deliberately
// framework-agnostic (no Playwright import) so they can be unit-tested without a browser and reused
// by both the global setup below and the tag-expression runner built in Stage 05.
import type { PlaywrightEnv } from "./env";

/**
 * Resolve whether a base URL's hostname is a recognized production host. An empty
 * `productionHostnames` list (this repo's current default -- see Decision Log DEC-005) means
 * nothing is ever production, by construction, not by omission.
 */
export function resolveIsProduction(baseURL: string, productionHostnames: string[]): boolean {
  let hostname: string;
  try {
    hostname = new URL(baseURL).hostname.toLowerCase();
  } catch {
    // An unparseable base URL can never be confidently matched against a production allow-list --
    // treat it as non-production for the purposes of this check (playwright.config.ts's own env
    // validation is what should catch a malformed APP_URL in the first place).
    return false;
  }
  return productionHostnames.includes(hostname);
}

export interface MutationCheckInput {
  baseURL: string;
  /** Whether the current selection includes any @mutating-tagged test. */
  hasMutatingSelection: boolean;
  env: Pick<PlaywrightEnv, "PRODUCTION_HOSTNAMES" | "PLAYWRIGHT_ALLOW_PRODUCTION">;
}

export class ProductionMutationBlockedError extends Error {
  constructor(hostname: string) {
    super(
      `Refusing to run: "${hostname}" is a configured production host and the current selection ` +
        `includes at least one @mutating test. Mutating tests may never run against production ` +
        `(spec Section 9.3). If this selection is genuinely read-only, remove the mutating tests ` +
        `from the selection; production read-only runs still require PLAYWRIGHT_ALLOW_PRODUCTION=1.`
    );
    this.name = "ProductionMutationBlockedError";
  }
}

/**
 * Throws if, and only if, the target is a recognized production host AND the selection contains a
 * mutating test. A production target with a read-only selection is allowed to proceed only when
 * PLAYWRIGHT_ALLOW_PRODUCTION=1 is also set -- a production URL alone is never sufficient (Section
 * 9.3: "A production run must require an explicit production flag in addition to a production
 * URL."). An unrecognized/unknown host is never treated as safe-for-production by assumption; it is
 * simply not production, so ordinary non-production rules apply.
 */
export function assertMutationAllowed(input: MutationCheckInput): void {
  const { baseURL, hasMutatingSelection, env } = input;
  const isProduction = resolveIsProduction(baseURL, env.PRODUCTION_HOSTNAMES);

  if (!isProduction) return;

  const hostname = new URL(baseURL).hostname;

  if (hasMutatingSelection) {
    throw new ProductionMutationBlockedError(hostname);
  }

  if (!env.PLAYWRIGHT_ALLOW_PRODUCTION) {
    throw new Error(
      `Refusing to run: "${hostname}" is a configured production host. Even a read-only ` +
        `selection requires PLAYWRIGHT_ALLOW_PRODUCTION=1 to be set explicitly (spec Section 9.3).`
    );
  }
}
