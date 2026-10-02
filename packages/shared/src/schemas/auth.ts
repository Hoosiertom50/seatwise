import { z } from "zod";
import { PERSON_NAME_PATTERN, PERSON_NAME_MESSAGE, looksLikeWebAddress, NO_WEB_ADDRESS_MESSAGE } from "../validation";

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
  password: z.string().min(8, "Password must be at least 8 characters"),
});
export type SignupInput = z.infer<typeof signupSchema>;

// TS-142
export const forgotPasswordSchema = z.object({ email: z.string().trim().email("Enter the email you signed up with") });
export const resetPasswordSchema = z.object({
  token: z.string().regex(/^[0-9a-f]{64}$/, "This reset link is no longer valid — request a new one."),
  password: z.string().min(8, "Password must be at least 8 characters"),
});

export const loginSchema = z.object({
  email: z.string().email("Enter a valid email address"),
  password: z.string().min(1, "Password is required"),
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
