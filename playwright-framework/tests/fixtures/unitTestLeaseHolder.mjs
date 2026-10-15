// Review 16 (runLease.spec.ts): stands in for a unit-test process. It's started the way the web unit
// tests are -- with `--import apps/web/src/lib/test-run-lease.mts` -- says so, and stays alive a while.
console.log("holding");
setTimeout(() => undefined, 15_000);
