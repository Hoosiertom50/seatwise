// TS-212: after a control the person was using goes away (an edit box swapping back to its row,
// say), focus goes to a stable control by id -- but only if focus was really lost, so someone who
// has clicked elsewhere keeps their place.
// Checked twice: straight after, and again a moment later. The screen is often drawn again only
// after the first check (Safari runs a zero-delay timer before React has put the new row in), and
// then the box that had focus disappears afterwards and focus drops to the page.
export function focusIfLost(id: string): void {
  const restore = () => {
    const active = document.activeElement;
    if (active && active !== document.body && active.isConnected) return;
    document.getElementById(id)?.focus();
  };
  setTimeout(restore, 0);
  setTimeout(restore, 150);
}
