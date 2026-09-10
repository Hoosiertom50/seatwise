/** Stage 06 — shared between the reporter (writes here) and the HTML renderer (computes relative
 * links FROM here to repo-root-relative source/attachment paths stored in the report JSON), kept
 * in one place rather than duplicated as a magic string in both files. */
export const REPORT_DIR = "artifacts/playwright/runs/run-reports";
