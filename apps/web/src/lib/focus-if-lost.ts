// TS-212: after a control the person was using goes away (an edit box swapping back to its row,
// say), focus goes to a stable control by id -- but only if focus was really lost, so someone who
// has clicked elsewhere keeps their place.
// Checked more than once: straight after, and again over the next moment. The screen is often drawn
// again only after the first check (Safari runs a zero-delay timer before React has put the new row
// in), and then the box that had focus disappears afterwards and focus drops to the page.
// PR #115 (CI on Edge): checked for up to a second, not just at 150 ms -- on a slow machine the
// control came back (or was enabled) after the last check, and focus stayed lost. A control that
// isn't there yet or is disabled can't take focus, so it's tried again.
const CHECKS_FOR_MS = 1_000;

export function focusIfLost(id: string): void {
  const started = Date.now();
  const restore = () => {
    const active = document.activeElement;
    if (active && active !== document.body && active.isConnected) {
      // Focus is somewhere -- after the first moment that's settled (someone may have clicked
      // elsewhere), so stop looking.
      if (Date.now() - started >= 150) return;
    } else {
      const target = document.getElementById(id);
      if (target && !(target as HTMLButtonElement).disabled) target.focus();
    }
    if (Date.now() - started < CHECKS_FOR_MS) setTimeout(restore, 50);
  };
  setTimeout(restore, 0);
}
