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
// A bare `playwright test --grep ...` invoked directly bypasses run-tests.ts, so
// PW_RUN_HAS_MUTATING_SELECTION is unset (Playwright's globalSetup has no API to see what a --grep
// resolved to -- see the Stage 05 Decision Log). TS-74: that used to default to "not mutating",
// which -- once a real production site existed -- meant a bare run with PLAYWRIGHT_ALLOW_PRODUCTION=1
// left set could have run the whole mutating suite against real data. It now fails closed: an
// unknown selection counts as mutating (selectionMayMutate), so against production only a pw:run
// read-only selection can ever get past this.
import { getEnv } from "./env";
import { assertMutationAllowed, selectionMayMutate } from "./productionGuard";

export default function globalSetup(): void {
  const env = getEnv();
  const hasMutatingSelection = selectionMayMutate(process.env.PW_RUN_HAS_MUTATING_SELECTION);

  assertMutationAllowed({
    baseURL: env.APP_URL,
    hasMutatingSelection,
    env,
  });
}
