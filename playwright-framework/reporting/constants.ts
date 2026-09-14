/** Stage 06 — shared between the reporter (writes here) and the HTML renderer (computes relative
 * links FROM here to repo-root-relative source/attachment paths stored in the report JSON), kept
 * in one place rather than duplicated as a magic string in both files. */
export const REPORT_DIR = "artifacts/playwright/runs/run-reports";

/** Stage 09 — same idea as REPORT_DIR above, for the maintenance/triage report's own HTML file,
 * which links back to run-report attachments (screenshots/traces) and test source files whose
 * paths are stored repo-root-relative in the maintenance report JSON. */
export const MAINTENANCE_REPORT_DIR = "artifacts/playwright/maintenance";
