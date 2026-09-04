export * from "./schemas/auth";
export * from "./schemas/wedding";
export * from "./schemas/guest";
export * from "./schemas/relationship";
export * from "./schemas/table";

export interface ApiErrorResponse {
  error: string;
  fieldErrors?: Record<string, string[]>;
}
