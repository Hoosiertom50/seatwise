// TS-178: the one place the app's own address comes from -- every emailed or shared link and the
// session cookie's Secure flag use it. TS-213: the rules now live in packages/shared/src/app-url.ts,
// so notification emails (built in packages/db) use the same address; this re-exports them for the
// app's existing imports.
export { appBaseUrl, AppUrlNotConfiguredError, runningOnNetlify } from "@seatwise/shared";
