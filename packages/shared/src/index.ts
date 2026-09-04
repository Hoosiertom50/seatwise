export * from "./schemas/auth";
export * from "./schemas/wedding";
export * from "./schemas/guest";
export * from "./schemas/relationship";
export * from "./schemas/table";
export * from "./schemas/plan-version";
export * from "./schemas/collaboration";
export * from "./schemas/guest-import";
export * from "./seating-engine";
export * from "./csv";

export interface ApiErrorResponse {
  error: string;
  fieldErrors?: Record<string, string[]>;
}
