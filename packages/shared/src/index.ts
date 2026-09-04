export * from "./schemas/auth";
export * from "./schemas/wedding";
export * from "./schemas/guest";

export interface ApiErrorResponse {
  error: string;
  fieldErrors?: Record<string, string[]>;
}
