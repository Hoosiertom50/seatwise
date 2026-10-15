// Review 16 (runLease.spec.ts): stands in for a unit-test process. It's started the way the web unit
// tests are -- with `--import apps/web/src/lib/test-run-lease.mts` -- says so, and stays alive a while
// (HOLD_MS, 15 seconds unless set).
console.log("holding");
setTimeout(() => undefined, Number(process.env.HOLD_MS ?? 15_000));
