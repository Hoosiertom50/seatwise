/**
 * Stage 05 — a small, self-contained boolean tag-expression language: AND, OR, NOT, parentheses,
 * and bare tag literals (spec Section 9.2 / Stage 05 task: "Implement AND, OR, NOT, parentheses,
 * and saved named selections"). Three independent operations share one parsed AST
 * (`ExpressionNode`), so "what the preview says" and "what actually runs" can never drift apart
 * (Stage 05 acceptance criterion: "Preview and actual execution select the same tests"):
 *
 *  - `evaluateExpression(node, tags)` — evaluate against one test's own tag list (used by the
 *    preview mode and by this module's own tests to cross-check the compiled grep pattern).
 *  - `compileToGrepPattern(node)` — compile to a single JS-regex source string that Playwright's
 *    own `--grep` flag already understands (see the Decision Log entry for why this works and
 *    isn't a reimplementation of test selection).
 *  - `findContradictions(node, taxonomy)` — statically detect an expression that can never match
 *    anything (e.g. ANDing two tags from the same `exactly-one` dimension) before ever invoking
 *    Playwright.
 *
 * Grammar (standard precedence: NOT binds tighter than AND, AND binds tighter than OR; parens
 * override):
 *
 *   expression := orExpr
 *   orExpr      := andExpr ( ("OR" | "||") andExpr )*
 *   andExpr     := notExpr ( ("AND" | "&&") notExpr )*
 *   notExpr     := ("NOT" | "!") notExpr | atom
 *   atom        := TAG | "(" expression ")"
 *   TAG         := "@" [A-Za-z0-9:_-]+
 *
 * The tokenizer only ever recognizes TAG/AND/OR/NOT/(/) tokens; anything else (a stray semicolon,
 * a shell metacharacter, an unterminated paren, `rm -rf /`, ...) is a syntax error reported with
 * the offending text and position -- it is never silently dropped, coerced, or passed through to
 * anything that could execute it (spec Stage 05 task: "parser and selection unit tests, including
 * quoting and injection attempts").
 */

import type { TagTaxonomyFile } from "../metadata/schemas.js";

export type ExpressionNode =
  | { type: "tag"; tag: string }
  | { type: "not"; operand: ExpressionNode }
  | { type: "and"; left: ExpressionNode; right: ExpressionNode }
  | { type: "or"; left: ExpressionNode; right: ExpressionNode };

export class TagExpressionSyntaxError extends Error {
  constructor(message: string, source: string, position: number) {
    super(`${message} (at position ${position} in: ${source})`);
    this.name = "TagExpressionSyntaxError";
  }
}

// ---------------------------------------------------------------------------
// Tokenizer
// ---------------------------------------------------------------------------

type Token =
  | { kind: "tag"; value: string; pos: number }
  | { kind: "and" | "or" | "not" | "lparen" | "rparen"; pos: number };

const TAG_PATTERN = /^@[A-Za-z0-9:_-]+/;
const WORD_KEYWORDS: Record<string, "and" | "or" | "not"> = {
  and: "and",
  or: "or",
  not: "not",
};

function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < source.length) {
    const ch = source[i];

    if (/\s/.test(ch)) {
      i++;
      continue;
    }
    if (ch === "(") {
      tokens.push({ kind: "lparen", pos: i });
      i++;
      continue;
    }
    if (ch === ")") {
      tokens.push({ kind: "rparen", pos: i });
      i++;
      continue;
    }
    if (source.startsWith("&&", i)) {
      tokens.push({ kind: "and", pos: i });
      i += 2;
      continue;
    }
    if (source.startsWith("||", i)) {
      tokens.push({ kind: "or", pos: i });
      i += 2;
      continue;
    }
    if (ch === "!") {
      tokens.push({ kind: "not", pos: i });
      i++;
      continue;
    }
    if (ch === "@") {
      const match = TAG_PATTERN.exec(source.slice(i));
      if (!match) {
        throw new TagExpressionSyntaxError(
          `"@" must be followed by a valid tag (letters, digits, ":", "_", "-")`,
          source,
          i,
        );
      }
      tokens.push({ kind: "tag", value: match[0], pos: i });
      i += match[0].length;
      continue;
    }
    if (/[A-Za-z]/.test(ch)) {
      const match = /^[A-Za-z]+/.exec(source.slice(i))!;
      const word = match[0].toLowerCase();
      const keyword = WORD_KEYWORDS[word];
      if (!keyword) {
        throw new TagExpressionSyntaxError(
          `unrecognized word "${match[0]}" -- expected AND, OR, NOT, a tag starting with "@", or a parenthesis`,
          source,
          i,
        );
      }
      tokens.push({ kind: keyword, pos: i });
      i += match[0].length;
      continue;
    }

    throw new TagExpressionSyntaxError(
      `unexpected character "${ch}" -- a tag expression may only contain tags (starting with "@"), AND/OR/NOT (or &&/||/!), and parentheses`,
      source,
      i,
    );
  }
  return tokens;
}

// ---------------------------------------------------------------------------
// Recursive-descent parser
// ---------------------------------------------------------------------------

class Parser {
  private position = 0;
  constructor(
    private readonly tokens: Token[],
    private readonly source: string,
  ) {}

  private peek(): Token | undefined {
    return this.tokens[this.position];
  }

  private next(): Token {
    const token = this.tokens[this.position];
    if (!token) {
      throw new TagExpressionSyntaxError("unexpected end of expression", this.source, this.source.length);
    }
    this.position++;
    return token;
  }

  parseExpression(): ExpressionNode {
    if (this.tokens.length === 0) {
      throw new TagExpressionSyntaxError("expression is empty", this.source, 0);
    }
    const node = this.parseOr();
    if (this.position < this.tokens.length) {
      const trailing = this.tokens[this.position];
      throw new TagExpressionSyntaxError(
        `unexpected trailing input starting at "${this.source.slice(trailing.pos)}"`,
        this.source,
        trailing.pos,
      );
    }
    return node;
  }

  private parseOr(): ExpressionNode {
    let left = this.parseAnd();
    while (this.peek()?.kind === "or") {
      this.next();
      const right = this.parseAnd();
      left = { type: "or", left, right };
    }
    return left;
  }

  private parseAnd(): ExpressionNode {
    let left = this.parseNot();
    while (this.peek()?.kind === "and") {
      this.next();
      const right = this.parseNot();
      left = { type: "and", left, right };
    }
    return left;
  }

  private parseNot(): ExpressionNode {
    if (this.peek()?.kind === "not") {
      this.next();
      return { type: "not", operand: this.parseNot() };
    }
    return this.parseAtom();
  }

  private parseAtom(): ExpressionNode {
    const token = this.peek();
    if (!token) {
      throw new TagExpressionSyntaxError("expected a tag or \"(\" but the expression ended", this.source, this.source.length);
    }
    if (token.kind === "tag") {
      this.next();
      return { type: "tag", tag: token.value };
    }
    if (token.kind === "lparen") {
      this.next();
      const inner = this.parseOr();
      const closing = this.peek();
      if (!closing || closing.kind !== "rparen") {
        throw new TagExpressionSyntaxError(`unbalanced parentheses -- expected ")"`, this.source, closing?.pos ?? this.source.length);
      }
      this.next();
      return inner;
    }
    throw new TagExpressionSyntaxError(
      `expected a tag (starting with "@") or "(" but found ${describeToken(token)}`,
      this.source,
      token.pos,
    );
  }
}

function describeToken(token: Token): string {
  switch (token.kind) {
    case "tag":
      return `tag "${token.value}"`;
    case "rparen":
      return `")"`;
    default:
      return `"${token.kind.toUpperCase()}"`;
  }
}

/** Parses a tag-expression string into an AST. Throws `TagExpressionSyntaxError` with an
 * actionable message on any malformed input -- an empty expression, unbalanced parentheses,
 * trailing garbage, or a token that isn't a recognized tag/keyword/paren all fail loudly here,
 * before this expression is ever validated against the taxonomy or compiled into anything that
 * could reach a shell. */
export function parseTagExpression(source: string): ExpressionNode {
  const tokens = tokenize(source);
  return new Parser(tokens, source).parseExpression();
}

// ---------------------------------------------------------------------------
// Evaluation against a concrete tag list
// ---------------------------------------------------------------------------

/** Resolves an alias to its canonical tag (mirrors playwright-framework/metadata/tagValidation.ts
 * so evaluation, contradiction-checking, and validation all agree on the same tag identity). */
function resolveAlias(tag: string, taxonomy: TagTaxonomyFile): string {
  const alias = taxonomy.aliases.find((a) => a.alias === tag);
  return alias ? alias.canonical : tag;
}

/** Evaluates `node` against one test's own `tags` (each resolved through the taxonomy's aliases
 * first, so an expression written against an alias and a test authored with its canonical tag --
 * or vice versa -- still agree). */
export function evaluateExpression(
  node: ExpressionNode,
  tags: string[],
  taxonomy: TagTaxonomyFile,
): boolean {
  const resolvedTags = new Set(tags.map((t) => resolveAlias(t, taxonomy)));

  function evaluate(n: ExpressionNode): boolean {
    switch (n.type) {
      case "tag":
        return resolvedTags.has(resolveAlias(n.tag, taxonomy));
      case "not":
        return !evaluate(n.operand);
      case "and":
        return evaluate(n.left) && evaluate(n.right);
      case "or":
        return evaluate(n.left) || evaluate(n.right);
    }
  }
  return evaluate(node);
}

/** Every tag literal referenced anywhere in the expression, in the order first encountered. */
export function collectTagsInExpression(node: ExpressionNode): string[] {
  const seen = new Set<string>();
  const ordered: string[] = [];
  function walk(n: ExpressionNode): void {
    if (n.type === "tag") {
      if (!seen.has(n.tag)) {
        seen.add(n.tag);
        ordered.push(n.tag);
      }
      return;
    }
    if (n.type === "not") return walk(n.operand);
    walk(n.left);
    walk(n.right);
  }
  walk(node);
  return ordered;
}

// ---------------------------------------------------------------------------
// Compilation to a Playwright --grep regex
// ---------------------------------------------------------------------------

function escapeRegExp(literal: string): string {
  return literal.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Compiles `node` into a single JS-regex source string suitable for Playwright's own `--grep`
 * flag. Playwright matches `--grep` against each test's full display title, which (per Playwright
 * 1.63's own behavior with the native `tag` test option) includes every tag the test declared --
 * confirmed directly against this repo's own real tests, not assumed (see the Stage 05 Decision
 * Log entry and this module's own unit tests for the verification).
 *
 * Every node compiles to a complete, self-contained, zero-width regex assertion -- true (as a
 * match starting at the current position) if and only if that node's boolean condition holds for
 * the whole title string:
 *
 *  - a tag compiles to a positive lookahead: `(?=.*@a)` ("contains @a somewhere").
 *  - NOT wraps its operand's own assertion in a negative lookahead: `(?!${assertion})` -- negating
 *    a lookahead-only pattern is always well-defined and correct, however deeply that operand is
 *    itself nested (unlike a naive implementation that only special-cases NOT of a bare tag).
 *  - AND concatenates two zero-width assertions: since neither consumes any input, evaluating them
 *    back-to-back tests both at the SAME starting position, in any order -- this composes
 *    correctly to any nesting depth precisely because every operand is itself already zero-width
 *    (an inductive property this function's own unit tests verify against nested cases, not just
 *    flat two-term expressions).
 *  - OR wraps the alternation of two zero-width assertions in a non-capturing group:
 *    `(?:${left}|${right})` -- an alternation of zero-width alternatives is itself zero-width, so
 *    this composes the same way AND does.
 *
 * A tag is always a fixed, escaped literal (never treated as a wildcard), so nothing in a parsed
 * expression can inject an unintended regex meta-character. This never needs Playwright's separate
 * `--grep-invert` flag, even for a top-level NOT: a negative lookahead with nothing else in the
 * pattern already matches every title that doesn't contain the excluded tag, which is exactly
 * `--grep`'s own "does this regex match somewhere in the title" semantics.
 *
 * The whole compiled expression is anchored to the START of the title with a leading `^`. This is
 * not cosmetic: `--grep` (like this module's own cross-check in `tagExpression.spec.ts`) evaluates
 * the pattern with an UNANCHORED search, meaning the engine is free to retry the match starting at
 * position 1, 2, 3, ... if position 0 doesn't satisfy it. Every node here is zero-width by design
 * (see above), so that's harmless for a pattern that's true at position 0 -- but for a NOT whose
 * operand is only true at position 0 (e.g. "the title contains @quarantined somewhere"), retrying
 * at a position AFTER that tag's own text has already gone by makes the negated lookahead
 * incorrectly succeed there, since ".*@quarantined" ahead of that later position no longer finds
 * it. An unanchored `NOT @quarantined` therefore matched every title that merely wasn't infinitely
 * long, including ones that DO carry `@quarantined` -- caught by this module's own
 * compileToGrepPattern-vs-evaluateExpression cross-verification test, not assumed correct.
 * Anchoring with `^` forces the ENTIRE boolean formula to be evaluated once, at a single fixed
 * position, which is what "evaluate this against the test's tags" is supposed to mean in the first
 * place; test titles are always single-line, so `^` (without a multiline flag) unambiguously means
 * "the very start of the title" here.
 *
 * A tag literal ALSO carries a trailing tag-boundary assertion, `(?![A-Za-z0-9:_-])` -- found by
 * this stage's own audit, not assumed correct from the outset. Without it, a tag compiles to a bare
 * "contains this substring somewhere" lookahead, and `@a` is a literal substring of `@ab`: a test
 * tagged only `@ab` (never `@a`) would spuriously satisfy the expression `@a`, and `NOT @a` would
 * spuriously EXCLUDE that same test, purely because `@a`'s characters happen to appear as a prefix
 * of `@ab`'s. The taxonomy has no such colliding pair today (verified by an exhaustive pairwise
 * check over every currently-defined tag), so this trap does not fire against the real suite yet --
 * but it is a live latent bug in the compiler itself, not a hypothetical one (reproduced directly
 * against `compileToGrepPattern`/`evaluateExpression` with synthetic `@a`/`@ab` tags), and this
 * taxonomy's own colon-namespaced tags (`@feature:guests`, `@risk:critical`, ...) are exactly the
 * naming style most likely to grow a prefix collision later (e.g. a future `@feature:guests-import`
 * sitting right next to today's `@feature:guests`). A tag can never be a false-positive SUFFIX
 * match of another (every tag's `@` must be followed immediately by more of that same tag's own
 * text, so `@b` can never appear as a substring inside `@ab` -- the character before "b" there is
 * "a", not "@"), so only the trailing boundary needs asserting. The tag charset itself
 * (`[A-Za-z0-9:_-]`, see `TAG_PATTERN`) is exactly the disallowed-continuation set here: whatever
 * legitimately follows a real tag in a rendered title (a space before the next tag, or the end of
 * the string) is never one of those characters, so this changes nothing for any currently-passing
 * case -- it only closes the prefix-collision gap.
 */
export function compileToGrepPattern(node: ExpressionNode): string {
  function compile(n: ExpressionNode): string {
    switch (n.type) {
      case "tag":
        return `(?=.*${escapeRegExp(n.tag)}(?![A-Za-z0-9:_-]))`;
      case "not":
        return `(?!${compile(n.operand)})`;
      case "and":
        return `${compile(n.left)}${compile(n.right)}`;
      case "or":
        return `(?:${compile(n.left)}|${compile(n.right)})`;
    }
  }
  return `^${compile(node)}`;
}

// ---------------------------------------------------------------------------
// Contradiction detection
// ---------------------------------------------------------------------------

/** Two tags that can never both apply to the same test: an explicit taxonomy conflict, or two
 * distinct tags from the same `exactly-one` dimension (e.g. `@readonly` and `@mutating`). */
function areMutuallyExclusive(a: string, b: string, taxonomy: TagTaxonomyFile): boolean {
  if (a === b) return false;

  for (const conflict of taxonomy.conflicts) {
    if (conflict.tags.includes(a) && conflict.tags.includes(b)) return true;
  }

  for (const dimension of taxonomy.dimensions) {
    if (dimension.requirement !== "exactly-one") continue;
    const names = new Set(dimension.tags.map((t) => t.name));
    if (names.has(a) && names.has(b)) return true;
  }

  return false;
}

/**
 * Statically detects an expression that can never match any real test -- specifically, an AND
 * whose flattened operand set contains two mutually-exclusive tags (spec Stage 05 task: "Detect
 * contradictory expressions ... with actionable messages"). Returns a human-readable message per
 * contradiction found (empty array when the expression is satisfiable). This is necessarily an
 * approximation for expressions mixing OR/NOT with AND (De Morgan expansion of an arbitrary
 * expression is out of scope for a lightweight static check) -- it catches the direct, common
 * case ("@readonly AND @mutating") rather than every logically-equivalent rewriting of it.
 */
export function findContradictions(node: ExpressionNode, taxonomy: TagTaxonomyFile): string[] {
  const messages: string[] = [];

  function collectAndTagOperands(n: ExpressionNode): string[] {
    if (n.type === "tag") return [n.tag];
    if (n.type === "and") return [...collectAndTagOperands(n.left), ...collectAndTagOperands(n.right)];
    return [];
  }

  function walk(n: ExpressionNode): void {
    if (n.type === "and") {
      const tags = collectAndTagOperands(n);
      for (let i = 0; i < tags.length; i++) {
        for (let j = i + 1; j < tags.length; j++) {
          if (areMutuallyExclusive(tags[i], tags[j], taxonomy)) {
            messages.push(
              `"${tags[i]}" and "${tags[j]}" can never both apply to the same test, so this AND can never match anything`,
            );
          }
        }
      }
    }
    if (n.type === "not") walk(n.operand);
    if (n.type === "and" || n.type === "or") {
      walk(n.left);
      walk(n.right);
    }
  }
  walk(node);

  return [...new Set(messages)];
}
