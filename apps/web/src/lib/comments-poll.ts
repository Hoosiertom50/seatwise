// TS-221 / TS-228: whether the Comments tab's 4-second check may show the list it fetched. Not after
// the tab closed, not when one of this tab's own changes landed since it was sent (it could put
// back the list from before that change), not while a post or resolve is on its way -- and (TS-228)
// not while a comment or reply is being written: a check that set off before typing began used to
// redraw the list above the draft once, which the pause while typing is there to avoid.
export function mayApplyCommentsPoll(state: {
  cancelled: boolean;
  changesBefore: number;
  changesNow: number;
  busy: boolean;
  hasDraft: boolean;
}): boolean {
  return !state.cancelled && state.changesBefore === state.changesNow && !state.busy && !state.hasDraft;
}
