/**
 * Stage 05 — unit tests for playwright-framework/runner/parseRunArgs.ts, the pure argv-parsing
 * logic behind playwright-framework/cli/run-tests.ts (`pnpm pw:run`). Split out specifically so
 * this can be tested directly rather than only indirectly through the CLI's own process exit
 * codes (spec Stage 05 task: "Add package commands ... Add parser and selection unit tests" and
 * this stage's own pending-task list: "unit tests for the CLI's argv parsing and validation logic
 * where feasible").
 */
import { expect, test } from "@playwright/test";
import { parseRunArgs } from "../runner/parseRunArgs.js";

test.describe("parseRunArgs — valid input", () => {
  test("a bare positional expression", () => {
    const args = parseRunArgs(["@readonly"]);
    expect(args.expression).toBe("@readonly");
    expect(args.selectionName).toBeUndefined();
    expect(args.preview).toBe(false);
    expect(args.allowProduction).toBe(false);
    expect(args.help).toBe(false);
  });

  test("--selection <name>", () => {
    const args = parseRunArgs(["--selection", "smoke"]);
    expect(args.selectionName).toBe("smoke");
    expect(args.expression).toBeUndefined();
  });

  test("--list and --preview are both recognized as preview mode", () => {
    expect(parseRunArgs(["@readonly", "--list"]).preview).toBe(true);
    expect(parseRunArgs(["@readonly", "--preview"]).preview).toBe(true);
    expect(parseRunArgs(["@readonly"]).preview).toBe(false);
  });

  test("--allow-production", () => {
    expect(parseRunArgs(["@readonly", "--allow-production"]).allowProduction).toBe(true);
  });

  test("--workers accepts a positive integer", () => {
    expect(parseRunArgs(["@readonly", "--workers", "3"]).workers).toBe(3);
  });

  test("--repeat-each accepts a positive integer", () => {
    expect(parseRunArgs(["@readonly", "--repeat-each", "2"]).repeatEach).toBe(2);
  });

  test("--reporter accepts a known reporter name", () => {
    expect(parseRunArgs(["@readonly", "--reporter", "list"]).reporter).toBe("list");
    expect(parseRunArgs(["@readonly", "--reporter", "html"]).reporter).toBe("html");
  });

  test("--help / -h", () => {
    expect(parseRunArgs(["--help"]).help).toBe(true);
    expect(parseRunArgs(["-h"]).help).toBe(true);
  });

  test("flags can be combined and can appear in any order", () => {
    const args = parseRunArgs(["--workers", "2", "@readonly AND @feature:guests", "--reporter", "list", "--repeat-each", "4"]);
    expect(args.expression).toBe("@readonly AND @feature:guests");
    expect(args.workers).toBe(2);
    expect(args.repeatEach).toBe(4);
    expect(args.reporter).toBe("list");
  });

  test("no arguments at all is valid at the parser level (main() decides it's an error, not the parser)", () => {
    const args = parseRunArgs([]);
    expect(args.expression).toBeUndefined();
    expect(args.selectionName).toBeUndefined();
    expect(args.help).toBe(false);
  });
});

test.describe("parseRunArgs — rejected input", () => {
  test("--selection with no name argument throws", () => {
    expect(() => parseRunArgs(["--selection"])).toThrow(/requires a name argument/);
  });

  test("--workers with a non-numeric value throws", () => {
    expect(() => parseRunArgs(["@readonly", "--workers", "banana"])).toThrow(/positive integer/);
  });

  test("--workers with zero or a negative value throws", () => {
    expect(() => parseRunArgs(["@readonly", "--workers", "0"])).toThrow(/positive integer/);
    expect(() => parseRunArgs(["@readonly", "--workers", "-1"])).toThrow(/positive integer/);
  });

  test("--workers with a non-integer (decimal) value throws", () => {
    expect(() => parseRunArgs(["@readonly", "--workers", "1.5"])).toThrow(/positive integer/);
  });

  test("--repeat-each with an invalid value throws", () => {
    expect(() => parseRunArgs(["@readonly", "--repeat-each", "0"])).toThrow(/positive integer/);
  });

  test("--reporter with an unrecognized value throws, naming the valid choices", () => {
    expect(() => parseRunArgs(["@readonly", "--reporter", "carrier-pigeon"])).toThrow(
      /list, line, dot, html, json/,
    );
  });

  test("--reporter given shell-metacharacter-shaped input is rejected as an unknown reporter, never passed through", () => {
    expect(() => parseRunArgs(["@readonly", "--reporter", "; rm -rf /"])).toThrow(
      /must be one of/,
    );
  });

  test("an unrecognized flag is rejected outright, not silently ignored", () => {
    expect(() => parseRunArgs(["@readonly", "--some-evil-flag"])).toThrow(/unrecognized option/);
  });

  test("an unrecognized flag shaped like a shell escape is still just an unrecognized flag", () => {
    expect(() => parseRunArgs(["@readonly", "--$(whoami)"])).toThrow(/unrecognized option/);
  });

  test("more than one positional argument is rejected with guidance to quote the whole expression", () => {
    expect(() => parseRunArgs(["@readonly", "AND", "@feature:guests"])).toThrow(
      /wrap the whole expression in quotes/,
    );
  });
});
