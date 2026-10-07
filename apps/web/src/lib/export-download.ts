// TS-211: the PDF and CSV exports are fetched here (as a file) rather than opened as plain links --
// a failed export (signed out, the plan un-approved or replaced since the page loaded, a server
// error) used to show raw {"error": ...} text in a new tab, or a browser "Failed" download. Now the
// reason is shown on the page, next to the button, and only a real file is opened or saved.
import { ApiError, fetchWithRetry, NETWORK_ERROR_STATUS } from "./api-client";

const SIGNED_OUT_MESSAGE = "You've been signed out — sign in again, then export.";
const NETWORK_MESSAGE = "Couldn't reach Seatwise — check your connection and try again.";

/** TS-211: the warning shown next to Export while the plan has attending guests with no seat. */
export function unseatedExportWarning(count: number): string | null {
  if (count <= 0) return null;
  return count === 1
    ? `1 attending guest isn't seated, so they won't be at a table on these PDFs — they're listed under "Not seated". Seat them first for a complete chart.`
    : `${count} attending guests aren't seated, so they won't be at a table on these PDFs — they're listed under "Not seated". Seat them first for a complete chart.`;
}

/** TS-211: the export URL with the viewer's time zone, for the date and time printed on a PDF. */
export function exportUrl(path: string, timeZone?: string): string {
  let zone = timeZone;
  if (zone === undefined) {
    try {
      zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    } catch {
      zone = undefined;
    }
  }
  return zone ? `${path}${path.includes("?") ? "&" : "?"}tz=${encodeURIComponent(zone)}` : path;
}

/** TS-211: the message for a failed export answer -- the server's own reason, never its raw text. */
export function exportErrorMessage(status: number, body: unknown, fallback: string): string {
  if (status === 401) return SIGNED_OUT_MESSAGE;
  const error = body && typeof body === "object" ? (body as { error?: unknown }).error : undefined;
  if (typeof error === "string" && error.trim()) return error;
  return fallback;
}

/**
 * TS-211: fetches an export as a file. Throws an ApiError carrying a message fit to show on the page
 * when the answer isn't the file (or there's no answer at all).
 */
export async function fetchExportFile(path: string, fallback: string): Promise<Blob> {
  let res: Response;
  try {
    res = await fetchWithRetry(path, { method: "GET", credentials: "include" });
  } catch {
    throw new ApiError(NETWORK_MESSAGE, NETWORK_ERROR_STATUS);
  }
  if (!res.ok) {
    const body = await res.json().catch(() => null);
    throw new ApiError(exportErrorMessage(res.status, body, fallback), res.status);
  }
  try {
    return await res.blob();
  } catch {
    throw new ApiError(NETWORK_MESSAGE, NETWORK_ERROR_STATUS);
  }
}

/** TS-211: saves a fetched file under `fileName`. */
export function saveBlob(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  // Long enough for the browser to start the download.
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

/**
 * TS-211: a PDF export -- a new tab is opened at once (while the click still counts, so it isn't
 * blocked as a pop-up), then shown the PDF once it has arrived; if it fails, the tab is closed and
 * the message comes back for the page to show. With no tab (pop-ups blocked), the PDF is saved.
 */
export async function openPdfExport(path: string, fileName: string, fallback: string): Promise<string | null> {
  const tab = typeof window !== "undefined" ? window.open("", "_blank") : null;
  try {
    const blob = await fetchExportFile(exportUrl(path), fallback);
    const pdf = blob.type === "application/pdf" ? blob : new Blob([blob], { type: "application/pdf" });
    if (tab && !tab.closed) {
      const url = URL.createObjectURL(pdf);
      tab.location.href = url;
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
    } else {
      saveBlob(pdf, fileName);
    }
    return null;
  } catch (err) {
    if (tab && !tab.closed) tab.close();
    return err instanceof ApiError ? err.message : fallback;
  }
}

/** TS-211: a CSV export -- downloaded, or the message for the page to show. */
export async function downloadCsvExport(path: string, fileName: string, fallback: string): Promise<string | null> {
  try {
    saveBlob(await fetchExportFile(path, fallback), fileName);
    return null;
  } catch (err) {
    return err instanceof ApiError ? err.message : fallback;
  }
}
