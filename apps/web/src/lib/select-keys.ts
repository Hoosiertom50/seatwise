// TS-212: which keys open a closed <select>'s pop-up list rather than changing its value in place.
// CommitSelect saves a pick from the pop-up straight away (like a mouse pick) and holds a change
// made in place until Enter or leaving the list. Before, a list opened with the keyboard and then
// picked from (with the mouse or Enter) was held until blur, and a false "unsaved" prompt appeared.
// - Space and Alt+Up/Down (and F4 on Windows) open the list everywhere.
// - On a Mac, the arrow keys open it too (they never change a closed list's value there).
export function selectKeyOpensPopup(key: string, altKey: boolean, isMac: boolean): boolean {
  if (key === " " || key === "F4") return true;
  if (key === "ArrowDown" || key === "ArrowUp") return altKey || isMac;
  return false;
}

export function isMacPlatform(): boolean {
  if (typeof navigator === "undefined") return false;
  return /Mac|iPhone|iPad|iPod/.test(navigator.platform || navigator.userAgent);
}
