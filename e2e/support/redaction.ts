/**
 * Stage 03 — configurable redaction/sanitization before report rendering (spec Section 7.4:
 * "Evidence capture must redact or avoid secrets, authentication tokens, personal data, and other
 * configured sensitive fields" / Stage 03 task: "Implement configurable redaction/sanitization
 * before report rendering").
 *
 * Applied to any text this framework attaches as evidence (console messages, network request/
 * response summaries, validation descriptions) before it is written to a report or artifact.
 * Pattern-based rather than field-aware, deliberately: evidence text is free-form (log lines,
 * header dumps, JSON blobs), not a structured object with known keys, so this scrubs by shape
 * (what a secret *looks like*) rather than by a fixed field-name allowlist that would miss an
 * unanticipated one.
 */

export interface RedactionRule {
  name: string;
  pattern: RegExp;
  replacement: string;
}

/** The default rule set. Each is a named, independently testable pattern rather than one
 * monolithic regex, so a gap can be diagnosed and extended rule-by-rule. Callers with
 * project-specific sensitive fields can pass additional rules to `redact` (the "configurable"
 * half of the requirement). */
export const DEFAULT_REDACTION_RULES: RedactionRule[] = [
  {
    // `.+` (not `\S+`) deliberately consumes the rest of the line: an Authorization value is
    // often two whitespace-separated parts (a scheme plus credentials, e.g. "Basic
    // dG9tOnN1cGVyc2VjcmV0"), and a `\S+` here would redact only the scheme word and leave the
    // credentials themselves sitting in the "redacted" output -- caught by this rule's own unit
    // test asserting the credential is actually gone, not just the word after the colon.
    name: "authorization-header",
    pattern: /authorization:\s*.+/gi,
    replacement: "authorization: [REDACTED]",
  },
  {
    name: "bearer-token",
    pattern: /\bBearer\s+[A-Za-z0-9._~+/=-]+/g,
    replacement: "Bearer [REDACTED]",
  },
  {
    // JWTs: three dot-separated base64url segments. Matched independent of the Bearer prefix
    // rule above, since a JWT can appear in a cookie value or a JSON body, not only a header.
    name: "jwt",
    pattern: /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g,
    replacement: "[REDACTED_JWT]",
  },
  {
    name: "set-cookie-header",
    pattern: /set-cookie:\s*\S+/gi,
    replacement: "set-cookie: [REDACTED]",
  },
  {
    // `.+` (not `\S+`) deliberately consumes the rest of the line: a real `Cookie` request header
    // routinely carries multiple "name=value" pairs joined by "; " (a session cookie plus a
    // CSRF-token cookie, say), and a `\S+` here would redact only the first cookie, leaving every
    // subsequent cookie's value sitting in cleartext -- the same class of bug this session's
    // stage-03 audit found and fixed here that was already caught and fixed for
    // `authorization-header` above.
    name: "cookie-header",
    pattern: /(?<![-\w])cookie:\s*.+/gi,
    replacement: "cookie: [REDACTED]",
  },
  {
    // JSON-shaped `"password": "..."` / `"token": "..."` / `"apiKey": "..."` / `"secret": "..."`,
    // quoted or bare-word key, any-case, single or double-quoted value.
    name: "sensitive-json-field",
    pattern: /"(password|token|apiKey|api_key|secret|accessToken|access_token|refreshToken|refresh_token)"\s*:\s*"[^"]*"/gi,
    replacement: '"$1":"[REDACTED]"',
  },
  {
    // The same fields in URL-encoded / query-string form: password=..., token=... up to the next
    // & or whitespace.
    name: "sensitive-query-field",
    pattern: /\b(password|token|apiKey|api_key|secret|accessToken|access_token|refreshToken|refresh_token)=[^&\s]+/gi,
    replacement: "$1=[REDACTED]",
  },
];

/** Redacts `text` using the default rules plus any project-specific `extraRules`. Pure function:
 * no I/O, safe to unit-test directly against representative sensitive values. */
export function redact(text: string, extraRules: RedactionRule[] = []): string {
  let result = text;
  for (const rule of [...DEFAULT_REDACTION_RULES, ...extraRules]) {
    result = result.replace(rule.pattern, rule.replacement);
  }
  return result;
}
