// TS-158: if the font files can't be read, the exports still build, with Helvetica (TS-152).
// A file of its own because the font folder is fixed when pdf.ts is first loaded.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fontNames } from "./pdf-test-helpers";

test("without the font files, the exports fall back to Helvetica", async () => {
  process.chdir(mkdtempSync(path.join(tmpdir(), "seatwise-no-fonts-")));
  const errors: unknown[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => errors.push(args);
  try {
    const { buildPlaceCardsPdf } = await import("./pdf");
    const pdf = await buildPlaceCardsPdf([{ guestName: "Łukasz 王", tableLabel: "Stół 1" }]);
    const names = await fontNames(pdf);
    assert.ok(names.length > 0 && names.every((n) => n.includes("Helvetica")), names.join(", "));
    assert.equal(errors.length, 1, JSON.stringify(errors));
  } finally {
    console.error = original;
  }
});
