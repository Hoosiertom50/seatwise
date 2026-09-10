// Stage 01: wires the production/mutation guard into Playwright's own lifecycle via
// playwright.config.ts's `globalSetup`, which Playwright runs once, before any project or browser
// is launched. This is what makes the guard "block before browser launch" for real, rather than
// being a standalone script someone has to remember to run.
//
// Stage 05 built the real tag-expression runner (playwright-framework/cli/run-tests.ts), which
// computes -- from the actual parsed expression and the real discovered test suite, not a guess --
// whether the current selection includes any @mutating test, and sets PW_RUN_HAS_MUTATING_SELECTION
// on its own child process accordingly before ever invoking `playwright test`. This replaces
// Stage 01's temporary PW_SIMULATE_MUTATING_SELECTION hook (tracked as a Stage 05 follow-up in
// DEC-007), which no longer exists anywhere in this codebase.
//
// This guard's accuracy is therefore scoped to runs launched through `pnpm pw:run` (or its saved-
// selection wrappers): a bare `playwright test --grep ...` invoked directly bypasses run-tests.ts
// entirely, so PW_RUN_HAS_MUTATING_SELECTION is simply unset and this defaults to "not mutating" --
// see the Stage 05 Decision Log entry for why Playwright's globalSetup has no API to determine a
// --grep-resolved test list itself, and why "always run through pw:run" is documented as a
// requirement rather than something this guard can enforce unconditionally on its own.
import { getEnv } from "./env";
import { assertMutationAllowed } from "./productionGuard";

export default function globalSetup(): void {
  const env = getEnv();
  const hasMutatingSelection = process.env.PW_RUN_HAS_MUTATING_SELECTION === "1";

  assertMutationAllowed({
    baseURL: env.APP_URL,
    hasMutatingSelection,
    env,
  });
}
