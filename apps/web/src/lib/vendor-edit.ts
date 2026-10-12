// TS-235: a vendor's open edit box when the vendor list is loaded again underneath it (after an
// access change). Every box nobody has changed takes the fresh copy -- an edit opened from the View
// copy (contract notes left out) used to keep its empty notes and save them over the real ones.
// What the person has typed is kept. `was` is the copy the edit was opened from (if still known).
export function editAfterReload<T extends object>(cur: Partial<T>, was: T | undefined, now: T): Partial<T> {
  const next: Partial<T> = { ...now };
  if (!was) return next;
  for (const key of Object.keys(cur) as (keyof T)[]) {
    const typed = cur[key] ?? null;
    if (typed !== (was[key] ?? null)) next[key] = cur[key];
  }
  return next;
}
