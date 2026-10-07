// TS-204: every API route reads its body through readJson() (api-response.ts), which refuses a
// non-JSON body and caps its size even when it comes without a Content-Length. A route calling
// req.json() directly would read a body of any size. Run with `pnpm --filter @seatwise/web test`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const apiDir = fileURLToPath(new URL("../app/api", import.meta.url));

function routeFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...routeFiles(full));
    else if (name === "route.ts") out.push(full);
  }
  return out;
}

const files = routeFiles(apiDir);

test("there are API route files to check", () => {
  assert.ok(files.length > 40, `found only ${files.length} route files`);
});

test("no API route reads its body with req.json(), .text(), .formData() or .arrayBuffer()", () => {
  const offenders = files.filter((f) =>
    /\b(req|request)\.(json|text|formData|arrayBuffer|blob)\(\)/.test(readFileSync(f, "utf8"))
  );
  assert.deepEqual(offenders.map((f) => relative(apiDir, f)), []);
});

test("every route that reads a body uses readJson and returns its refusal", () => {
  for (const f of files) {
    const src = readFileSync(f, "utf8");
    if (!src.includes("readJson(")) continue;
    assert.match(src, /if \(!json\.ok\) return json\.response;/, relative(apiDir, f));
  }
});
