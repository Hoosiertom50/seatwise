import { z } from "zod";
import { FIELD_LIMITS } from "../field-limits";
import { lengthFirst } from "./common";
import { PERSON_NAME_PATTERN, PERSON_NAME_MESSAGE, looksLikeWebAddress, NO_WEB_ADDRESS_MESSAGE, hasMixedScriptWord, NO_MIXED_SCRIPT_MESSAGE } from "../validation";

// TS-163: bcrypt only uses a password's first 72 bytes, so anything longer would be silently cut
// short -- capped (in bytes, since one letter can take several) rather than quietly ignored.
// TS-193: the number lives in ../field-limits, shared with the password boxes' maxLength.
const MAX_PASSWORD_BYTES = FIELD_LIMITS.password;
const PASSWORD_TOO_LONG = "Password must be at most 72 characters (fewer if it uses accented letters or symbols)";
/**
 * TS-200: the most characters a password box's value may have when an existing password is typed
 * to sign in or to confirm deleting the account -- far more than any password can be, so it's only
 * a guard against a huge value being hashed.
 */
export const MAX_PASSWORD_INPUT = 1000;

const newPassword = z
  .string()
  .min(8, "Password must be at least 8 characters")
  .refine((v) => new TextEncoder().encode(v).length <= MAX_PASSWORD_BYTES, PASSWORD_TOO_LONG);

export const signupSchema = z.object({
  // TS-156: the name goes into invite emails, so it's held to the same rule as a guest's name and
  // can't read as a web address.
  // TS-200: the length is checked first, and a name that's too long goes no further (lengthFirst).
  name: lengthFirst(
    FIELD_LIMITS.personName,
    z
      .string()
      .min(1, "Name is required")
      .regex(PERSON_NAME_PATTERN, PERSON_NAME_MESSAGE)
      .refine((v) => !looksLikeWebAddress(v), NO_WEB_ADDRESS_MESSAGE)
      // TS-178: nor mix look-alike letters from different alphabets in one word.
      .refine((v) => !hasMixedScriptWord(v), NO_MIXED_SCRIPT_MESSAGE)
  ),
  email: z.string().max(FIELD_LIMITS.email).email("Enter a valid email address"),
  password: newPassword,
});
export type SignupInput = z.infer<typeof signupSchema>;

// TS-142
export const forgotPasswordSchema = z.object({ email: z.string().trim().max(FIELD_LIMITS.email).email("Enter the email you signed up with") });
export const resetPasswordSchema = z.object({
  token: z.string().regex(/^[0-9a-f]{64}$/, "This reset link is no longer valid — request a new one."),
  password: newPassword,
});

export const loginSchema = z.object({
  email: z.string().max(FIELD_LIMITS.email).email("Enter a valid email address"),
  // Longer than any password can be (TS-163 caps new ones at 72 bytes); only a guard against huge
  // bodies, so it stays its own number rather than a field limit.
  password: z.string().min(1, "Password is required").max(MAX_PASSWORD_INPUT),
});
export type LoginInput = z.infer<typeof loginSchema>;

export interface AuthUser {
  id: string;
  name: string;
  email: string;
}

export interface AuthResponse {
  user: AuthUser;
  token: string;
}
