// Review 15 (runLease.spec.ts): takes this process's share of the e2e run lease, lets go of it, and
// then says so. Run as its own process: if letting go leaves nothing keeping Node alive while the
// connection closes, Node exits early -- with code 0 and without printing -- which is how a whole
// Playwright run once ended in the middle of its teardown.
import { releaseRunLease, takeRunLease } from "../../../e2e/support/runLease";

void (async () => {
  await takeRunLease();
  await releaseRunLease();
  console.log("released");
})();
