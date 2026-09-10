// Stage 01: wires the production/mutation guard into Playwright's own lifecycle via
// playwright.config.ts's `globalSetup`, which Playwright runs once, before any project or browser
// is launched. This is what makes the guard "block before browser launch" for real, rather than
// being a standalone script someone has to remember to run.
//
// The real tag-expression runner (and its knowledge of which tests are actually selected) arrives
// in Stage 05. Until then there is no mechanism to compute "does this selection include a
// @mutating test" ahead of time, so this stage exposes a single, explicitly-named, temporary
// simulation hook (PW_SIMULATE_MUTATING_SELECTION) purely so the guard's "blocks before browser
// launch" behavior can be demonstrated and tested end-to-end today. Stage 05 must replace this
// with the runner's real selection result -- tracked as a follow-up in that stage's audit.
import { getEnv } from "./env";
import { assertMutationAllowed } from "./productionGuard";

export default function globalSetup(): void {
  const env = getEnv();
  const simulateMutatingSelection = process.env.PW_SIMULATE_MUTATING_SELECTION === "1";

  assertMutationAllowed({
    baseURL: env.APP_URL,
    hasMutatingSelection: simulateMutatingSelection,
    env,
  });
}
