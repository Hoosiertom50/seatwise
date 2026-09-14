/**
 * Stage 05 — pure argv parsing/validation for playwright-framework/cli/run-tests.ts, split into
 * its own side-effect-free module specifically so it can be unit-tested directly
 * (playwright-framework/tests/parseRunArgs.spec.ts) without executing the CLI's own `main()` (the
 * CLI file itself calls `main()` unconditionally at module load, matching every other CLI in this
 * repo -- see lint-tests.ts/validate-metadata.ts -- so nothing in this codebase imports a CLI
 * entrypoint file directly; this module is what's importable instead).
 *
 * A small, explicit set of recognized flags -- anything else is rejected outright rather than
 * silently ignored or passed through to a shell (spec Stage 05 task: "forward only explicitly
 * supported, validated options").
 */

export interface ParsedRunArgs {
  expression?: string;
  selectionName?: string;
  preview: boolean;
  allowProduction: boolean;
  workers?: number;
  repeatEach?: number;
  reporter?: string;
  help: boolean;
}

export const KNOWN_REPORTERS = new Set(["list", "line", "dot", "html", "json"]);

/** Parses argv (already stripped of `node script.js`, i.e. `process.argv.slice(2)`). Throws a
 * plain `Error` with an actionable, non-developer-friendly message on any invalid input -- never
 * silently drops or coerces an unrecognized flag or a malformed value. */
export function parseRunArgs(argv: string[]): ParsedRunArgs {
  const parsed: ParsedRunArgs = { preview: false, allowProduction: false, help: false };
  const positionals: string[] = [];

  let i = 0;
  while (i < argv.length) {
    const arg = argv[i];
    switch (arg) {
      case "--help":
      case "-h":
        parsed.help = true;
        i++;
        break;
      case "--selection":
        parsed.selectionName = argv[i + 1];
        if (!parsed.selectionName) throw new Error(`--selection requires a name argument`);
        i += 2;
        break;
      case "--list":
      case "--preview":
        parsed.preview = true;
        i++;
        break;
      case "--allow-production":
        parsed.allowProduction = true;
        i++;
        break;
      case "--workers": {
        const raw = argv[i + 1];
        const n = Number(raw);
        if (!raw || !Number.isInteger(n) || n <= 0) {
          throw new Error(`--workers requires a positive integer, got "${raw ?? ""}"`);
        }
        parsed.workers = n;
        i += 2;
        break;
      }
      case "--repeat-each": {
        const raw = argv[i + 1];
        const n = Number(raw);
        if (!raw || !Number.isInteger(n) || n <= 0) {
          throw new Error(`--repeat-each requires a positive integer, got "${raw ?? ""}"`);
        }
        parsed.repeatEach = n;
        i += 2;
        break;
      }
      case "--reporter": {
        const raw = argv[i + 1];
        if (!raw || !KNOWN_REPORTERS.has(raw)) {
          throw new Error(
            `--reporter must be one of: ${[...KNOWN_REPORTERS].join(", ")} (got "${raw ?? ""}")`,
          );
        }
        parsed.reporter = raw;
        i += 2;
        break;
      }
      default:
        if (arg.startsWith("--")) {
          throw new Error(
            `unrecognized option "${arg}" -- pw:run only supports a small, explicit set of ` +
              `options (--selection, --list/--preview, --allow-production, --workers, ` +
              `--repeat-each, --reporter); run with --help to see usage.`,
          );
        }
        positionals.push(arg);
        i++;
    }
  }

  if (positionals.length > 1) {
    throw new Error(
      `expected at most one raw tag-expression argument, got ${positionals.length}: ` +
        `${positionals.map((p) => `"${p}"`).join(", ")} -- wrap the whole expression in quotes.`,
    );
  }
  parsed.expression = positionals[0];
  return parsed;
}

export const RUN_TESTS_HELP_TEXT = `
pw:run -- run (or preview) the tests matching a tag expression.

Usage:
  pnpm pw:run "<tag expression>"       e.g. pnpm pw:run "@readonly AND @feature:guests"
  pnpm pw:run --selection <name>       run a saved selection from quality/saved-selections.yaml
  pnpm pw:run "<expr>" --list          preview only: print matched tests, run nothing
  pnpm pw:run "<expr>" --allow-production
                                        required, in addition to PLAYWRIGHT_ALLOW_PRODUCTION=1,
                                        to run a read-only selection against a configured
                                        production host on THIS invocation
  pnpm pw:run "<expr>" --workers 2 --repeat-each 3 --reporter list
                                        the only options forwarded to \`playwright test\`

Expression syntax: @tag, AND/OR/NOT (or &&/||/!), parentheses. Example:
  "(@readonly OR @mutating) AND @feature:guests AND NOT @quarantined"
`;
