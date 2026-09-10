import { test, expect } from "@playwright/test";
import {
  parseTagExpression,
  evaluateExpression,
  compileToGrepPattern,
  collectTagsInExpression,
  findContradictions,
  TagExpressionSyntaxError,
} from "../runner/tagExpression.js";
import type { TagTaxonomyFile } from "../metadata/schemas.js";

const taxonomy: TagTaxonomyFile = {
  schemaVersion: "1.0.0",
  changeHistory: [{ date: "2026-01-01", change: "init" }],
  dimensions: [
    {
      name: "data-impact",
      description: "d",
      requirement: "exactly-one",
      tags: [
        { name: "@readonly", description: "d", productionEligible: true },
        { name: "@mutating", description: "d", productionEligible: false },
      ],
    },
    {
      name: "feature",
      description: "d",
      requirement: "at-least-one",
      tags: [
        { name: "@feature:guests", description: "d", productionEligible: true },
        { name: "@feature:tables", description: "d", productionEligible: true },
      ],
    },
    {
      name: "lifecycle",
      description: "d",
      requirement: "optional",
      tags: [{ name: "@quarantined", description: "d", productionEligible: false }],
    },
  ],
  conflicts: [{ tags: ["@mutating", "@readonly"], reason: "exactly-one dimension" }],
  aliases: [{ alias: "@guests", canonical: "@feature:guests" }],
};

test.describe("parseTagExpression — valid input", () => {
  test("a bare tag", () => {
    expect(parseTagExpression("@readonly")).toEqual({ type: "tag", tag: "@readonly" });
  });

  test("AND (word and symbolic form)", () => {
    const wordForm = parseTagExpression("@readonly AND @feature:guests");
    const symbolForm = parseTagExpression("@readonly && @feature:guests");
    expect(wordForm).toEqual({
      type: "and",
      left: { type: "tag", tag: "@readonly" },
      right: { type: "tag", tag: "@feature:guests" },
    });
    expect(symbolForm).toEqual(wordForm);
  });

  test("OR (word and symbolic form)", () => {
    const wordForm = parseTagExpression("@readonly OR @mutating");
    const symbolForm = parseTagExpression("@readonly || @mutating");
    expect(wordForm).toEqual({
      type: "or",
      left: { type: "tag", tag: "@readonly" },
      right: { type: "tag", tag: "@mutating" },
    });
    expect(symbolForm).toEqual(wordForm);
  });

  test("NOT (word and symbolic form)", () => {
    const wordForm = parseTagExpression("NOT @mutating");
    const symbolForm = parseTagExpression("!@mutating");
    expect(wordForm).toEqual({ type: "not", operand: { type: "tag", tag: "@mutating" } });
    expect(symbolForm).toEqual(wordForm);
  });

  test("keywords are case-insensitive", () => {
    expect(parseTagExpression("@a and @b")).toEqual(parseTagExpression("@a AND @b"));
    expect(parseTagExpression("@a Or @b")).toEqual(parseTagExpression("@a OR @b"));
    expect(parseTagExpression("not @a")).toEqual(parseTagExpression("NOT @a"));
  });

  test("parentheses override default precedence", () => {
    // Without parens: OR binds loosest, so "a AND (b OR c)" is NOT what "a AND b OR c" means.
    const withoutParens = parseTagExpression("@a AND @b OR @c");
    const withParens = parseTagExpression("(@a AND @b) OR @c");
    expect(withoutParens).toEqual(withParens);

    const explicitGrouping = parseTagExpression("@a AND (@b OR @c)");
    expect(explicitGrouping).toEqual({
      type: "and",
      left: { type: "tag", tag: "@a" },
      right: { type: "or", left: { type: "tag", tag: "@b" }, right: { type: "tag", tag: "@c" } },
    });
    expect(explicitGrouping).not.toEqual(withoutParens);
  });

  test("NOT binds tighter than AND", () => {
    // "NOT @a AND @b" means "(NOT @a) AND @b", not "NOT (@a AND @b)".
    const node = parseTagExpression("NOT @a AND @b");
    expect(node).toEqual({
      type: "and",
      left: { type: "not", operand: { type: "tag", tag: "@a" } },
      right: { type: "tag", tag: "@b" },
    });
  });

  test("nested parentheses", () => {
    const node = parseTagExpression("((@a))");
    expect(node).toEqual({ type: "tag", tag: "@a" });
  });

  test("whitespace is insignificant", () => {
    expect(parseTagExpression("  @a   AND    @b  ")).toEqual(parseTagExpression("@a AND @b"));
  });
});

test.describe("parseTagExpression — malformed input, including injection attempts", () => {
  function expectSyntaxError(source: string): void {
    expect(() => parseTagExpression(source)).toThrow(TagExpressionSyntaxError);
  }

  test("empty expression", () => {
    expectSyntaxError("");
    expectSyntaxError("   ");
  });

  test("unbalanced parentheses", () => {
    expectSyntaxError("(@a");
    expectSyntaxError("@a)");
    expectSyntaxError("((@a)");
  });

  test("trailing garbage after a complete expression", () => {
    expectSyntaxError("@a @b"); // two tags with no operator between them
    expectSyntaxError("@a AND @b @c");
  });

  test("a dangling operator", () => {
    expectSyntaxError("@a AND");
    expectSyntaxError("AND @a");
    expectSyntaxError("@a AND AND @b");
  });

  test("a tag-like token missing its @ prefix is rejected as an unrecognized word, not silently treated as a tag", () => {
    expectSyntaxError("readonly");
  });

  test("shell metacharacters and injection-shaped input are rejected as syntax errors, never silently accepted", () => {
    expectSyntaxError("@readonly; rm -rf /");
    expectSyntaxError("@readonly `id`");
    expectSyntaxError("@readonly && $(whoami)");
    expectSyntaxError("@readonly | cat /etc/passwd");
    expectSyntaxError("@readonly' OR '1'='1");
    expectSyntaxError("@readonly\nAND\n@mutating; echo pwned");
  });

  test("an unrecognized word is reported as such, not silently ignored", () => {
    expect(() => parseTagExpression("@a XOR @b")).toThrow(/unrecognized word "XOR"/);
  });
});

test.describe("evaluateExpression", () => {
  test("a bare tag matches only tests carrying it", () => {
    const node = parseTagExpression("@readonly");
    expect(evaluateExpression(node, ["@readonly"], taxonomy)).toBe(true);
    expect(evaluateExpression(node, ["@mutating"], taxonomy)).toBe(false);
  });

  test("AND requires every operand", () => {
    const node = parseTagExpression("@readonly AND @feature:guests");
    expect(evaluateExpression(node, ["@readonly", "@feature:guests"], taxonomy)).toBe(true);
    expect(evaluateExpression(node, ["@readonly"], taxonomy)).toBe(false);
  });

  test("OR requires at least one operand", () => {
    const node = parseTagExpression("@readonly OR @mutating");
    expect(evaluateExpression(node, ["@readonly"], taxonomy)).toBe(true);
    expect(evaluateExpression(node, ["@mutating"], taxonomy)).toBe(true);
    expect(evaluateExpression(node, ["@feature:guests"], taxonomy)).toBe(false);
  });

  test("NOT inverts", () => {
    const node = parseTagExpression("NOT @quarantined");
    expect(evaluateExpression(node, ["@readonly"], taxonomy)).toBe(true);
    expect(evaluateExpression(node, ["@readonly", "@quarantined"], taxonomy)).toBe(false);
  });

  test("a nested expression", () => {
    const node = parseTagExpression("(@readonly OR @mutating) AND NOT @quarantined");
    expect(evaluateExpression(node, ["@readonly"], taxonomy)).toBe(true);
    expect(evaluateExpression(node, ["@readonly", "@quarantined"], taxonomy)).toBe(false);
    expect(evaluateExpression(node, ["@feature:guests"], taxonomy)).toBe(false);
  });

  test("an alias in the expression resolves to its canonical tag before matching", () => {
    const node = parseTagExpression("@guests"); // alias for @feature:guests
    expect(evaluateExpression(node, ["@feature:guests"], taxonomy)).toBe(true);
  });

  test("an alias on the TEST's own tags also resolves before matching", () => {
    const node = parseTagExpression("@feature:guests");
    expect(evaluateExpression(node, ["@guests"], taxonomy)).toBe(true);
  });
});

test.describe("collectTagsInExpression", () => {
  test("collects every distinct tag, in first-seen order, ignoring operators", () => {
    const node = parseTagExpression("(@a OR @b) AND NOT @a");
    expect(collectTagsInExpression(node)).toEqual(["@a", "@b"]);
  });
});

test.describe("findContradictions", () => {
  test("no contradiction in a satisfiable expression", () => {
    const node = parseTagExpression("@readonly AND @feature:guests");
    expect(findContradictions(node, taxonomy)).toEqual([]);
  });

  test("an explicit taxonomy conflict inside an AND is caught", () => {
    const node = parseTagExpression("@readonly AND @mutating");
    const contradictions = findContradictions(node, taxonomy);
    expect(contradictions).toHaveLength(1);
    expect(contradictions[0]).toContain("@readonly");
    expect(contradictions[0]).toContain("@mutating");
  });

  test("two tags from the same exactly-one dimension are caught even without an explicit conflicts entry", () => {
    const narrowTaxonomy: TagTaxonomyFile = {
      ...taxonomy,
      conflicts: [], // remove the explicit conflict -- the dimension rule alone must still catch it
    };
    const node = parseTagExpression("@readonly AND @mutating");
    expect(findContradictions(node, narrowTaxonomy)).toHaveLength(1);
  });

  test("the same tag ANDed with itself is not a contradiction", () => {
    const node = parseTagExpression("@readonly AND @readonly");
    expect(findContradictions(node, taxonomy)).toEqual([]);
  });

  test("a contradiction nested inside OR/NOT is still detected", () => {
    const node = parseTagExpression("@feature:guests OR (@readonly AND @mutating)");
    expect(findContradictions(node, taxonomy)).toHaveLength(1);
  });

  test("two tags from an at-least-one dimension ANDed together is not a contradiction (both CAN apply)", () => {
    const node = parseTagExpression("@feature:guests AND @feature:tables");
    expect(findContradictions(node, taxonomy)).toEqual([]);
  });
});

test.describe("compileToGrepPattern — agrees with evaluateExpression across a representative query matrix", () => {
  // A representative matrix of tag combinations a real test might carry, each checked against a
  // representative matrix of expressions -- this is the automated form of the Stage 05 audit
  // gate's "compare runner selection with direct Playwright discovery across a representative
  // query matrix" (Playwright's own regex engine vs. this module's own boolean evaluator must
  // agree on every combination, not just the handful manually spot-checked against a live run).
  const tagCombinations: string[][] = [
    ["@readonly", "@feature:guests", "@risk:normal"],
    ["@mutating", "@feature:guests", "@risk:normal"],
    ["@readonly", "@feature:tables", "@risk:critical", "@quarantined"],
    ["@mutating", "@feature:tables"],
    ["@readonly"],
    [],
  ];

  const expressions = [
    "@readonly",
    "@mutating",
    "@feature:guests",
    "@readonly AND @feature:guests",
    "@mutating OR @feature:tables",
    "NOT @quarantined",
    "@readonly AND NOT @quarantined",
    "(@readonly OR @mutating) AND @feature:guests",
    "NOT (@readonly AND @feature:guests)",
    "@risk:critical AND @quarantined",
  ];

  function titleWithTags(tags: string[]): string {
    // Mirrors how Playwright's own reporter appends a test's tags to its title -- see this
    // module's own compileToGrepPattern doc comment for where this was verified against a real
    // run, not assumed.
    return `some test title ${tags.join(" ")}`;
  }

  for (const expression of expressions) {
    test(`"${expression}" agrees for every tag combination in the matrix`, () => {
      const node = parseTagExpression(expression);
      const grepPattern = compileToGrepPattern(node);
      const regex = new RegExp(grepPattern);

      for (const tags of tagCombinations) {
        const viaEvaluator = evaluateExpression(node, tags, taxonomy);
        const viaCompiledGrep = regex.test(titleWithTags(tags));
        expect(
          viaCompiledGrep,
          `expression "${expression}" against tags [${tags.join(", ")}]: evaluator said ${viaEvaluator}, compiled grep said ${viaCompiledGrep}`,
        ).toBe(viaEvaluator);
      }
    });
  }

  // Stage 05 AUDIT FINDING (found independently by the audit, not by the implementer's own
  // pre-audit unit test): a tag that is a literal PREFIX of another tag's text (e.g. "@a" is a
  // substring of "@ab") is a second, distinct unanchored-regex trap that DEC-015's leading-`^` fix
  // does not close -- `^` only fixes WHERE in the title the whole formula is evaluated, not whether
  // a single tag's own lookahead can be satisfied by a longer tag's text that merely starts with
  // it. Without a trailing tag-boundary assertion, `@a` (as a bare expression, or negated) would
  // silently disagree with evaluateExpression for a test tagged only `@ab`. The current taxonomy
  // has no such colliding pair (see the exhaustive pairwise check the audit ran over every real
  // tag), so this is deliberately reproduced here with synthetic tags rather than real ones -- this
  // test's job is to make sure it can never regress silently if a future tag addition (e.g. a
  // `@feature:guests-import` beside today's `@feature:guests`) creates exactly this collision.
  test("a tag that is a literal prefix of another tag never spuriously matches (or excludes) it", () => {
    const prefixTaxonomy: TagTaxonomyFile = {
      ...taxonomy,
      dimensions: [
        {
          name: "synthetic",
          description: "d",
          requirement: "optional",
          tags: [
            { name: "@a", description: "d", productionEligible: true },
            { name: "@ab", description: "d", productionEligible: true },
          ],
        },
        ...taxonomy.dimensions,
      ],
    };

    function assertAgree(expression: string, tags: string[]): void {
      const node = parseTagExpression(expression);
      const viaEvaluator = evaluateExpression(node, tags, prefixTaxonomy);
      const viaCompiledGrep = new RegExp(compileToGrepPattern(node)).test(titleWithTags(tags));
      expect(
        viaCompiledGrep,
        `expression "${expression}" against tags [${tags.join(", ")}]: evaluator said ${viaEvaluator}, compiled grep said ${viaCompiledGrep}`,
      ).toBe(viaEvaluator);
    }

    // A test tagged only "@ab" must NOT satisfy the bare expression "@a" (it doesn't carry "@a").
    assertAgree("@a", ["@ab"]);
    // ...and must still satisfy "NOT @a" (since it truly doesn't carry "@a").
    assertAgree("NOT @a", ["@ab"]);
    // A test that genuinely carries both must still match "@a" and "@ab" (no over-correction).
    assertAgree("@a", ["@a", "@ab"]);
    assertAgree("@a AND @ab", ["@a", "@ab"]);
  });
});
