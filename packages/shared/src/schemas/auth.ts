import { z } from "zod";
import { PERSON_NAME_PATTERN, PERSON_NAME_MESSAGE, looksLikeWebAddress, NO_WEB_ADDRESS_MESSAGE } from "../validation";

// TS-163: bcrypt only uses a password's first 72 bytes, so anything longer would be silently cut
// short -- capped (in bytes, since one letter can take several) rather than quietly ignored.
const MAX_PASSWORD_BYTES = 72;
const PASSWORD_TOO_LONG = "Password must be at most 72 characters (fewer if it uses accented letters or symbols)";
const newPassword = z
  .string()
  .min(8, "Password must be at least 8 characters")
  .refine((v) => new TextEncoder().encode(v).length <= MAX_PASSWORD_BYTES, PASSWORD_TOO_LONG);

export const signupSchema = z.object({
  // TS-156: the name goes into invite emails, so it's held to the same rule as a guest's name and
  // can't read as a web address.
  name: z
    .string()
    .trim()
    .min(1, "Name is required")
    .max(100)
    .regex(PERSON_NAME_PATTERN, PERSON_NAME_MESSAGE)
    .refine((v) => !looksLikeWebAddress(v), NO_WEB_ADDRESS_MESSAGE),
  email: z.string().email("Enter a valid email address"),
  password: newPassword,
});
export type SignupInput = z.infer<typeof signupSchema>;

// TS-142
export const forgotPasswordSchema = z.object({ email: z.string().trim().email("Enter the email you signed up with") });
export const resetPasswordSchema = z.object({
  token: z.string().regex(/^[0-9a-f]{64}$/, "This reset link is no longer valid — request a new one."),
  password: newPassword,
});

export const loginSchema = z.object({
  email: z.string().email("Enter a valid email address"),
  password: z.string().min(1, "Password is required").max(1000),
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
