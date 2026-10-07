// TS-206: the bookkeeping behind "you have unsaved changes", kept free of React so it can be unit
// tested (see unsaved-registry.test.mts). unsaved-changes.tsx wraps it for the wedding page.
//
// Three things are tracked:
// - dirty: fields and forms holding input that isn't saved (typed and not left yet, or a save that
//   failed and kept the typing in its box). Leaving a tab or the page asks about these.
// - saving: boxes that save when you leave them, whose save hasn't answered yet. These don't make a
//   tab click ask (the save is already on its way), but Back waits for them and only leaves once
//   every one has saved -- it used to leave straight away and a refused save was lost without a word.
// - notes: "Couldn't save <field>: <reason>" for a save that failed after its tab had closed. The
//   tab (and the box with the typing) is gone, so instead of a phantom unsaved mark that nothing
//   could clear, the page shows the reason until the planner dismisses it.

export interface UnsavedNote {
  id: number;
  text: string;
}

export class UnsavedRegistry {
  private dirty = new Set<string>();
  private saving = new Map<string, Set<Promise<boolean>>>();
  private notesList: UnsavedNote[] = [];
  private nextNoteId = 1;
  private listeners = new Set<() => void>();

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  private changed() {
    this.listeners.forEach((l) => l());
  }

  setDirty(key: string, dirty: boolean) {
    const had = this.dirty.has(key);
    if (dirty === had) return;
    if (dirty) this.dirty.add(key);
    else this.dirty.delete(key);
    this.changed();
  }
  hasUnsaved(): boolean {
    return this.dirty.size > 0;
  }
  dirtyCount(): number {
    return this.dirty.size;
  }
  clearDirty() {
    if (this.dirty.size === 0) return;
    this.dirty.clear();
    this.changed();
  }

  /**
   * A box that saves when you leave it registers its save here. `save` resolves to false when the
   * save didn't go through (anything else, including undefined, counts as saved); a rejection
   * counts as not saved too.
   */
  trackSave(key: string, save: Promise<unknown>): Promise<boolean> {
    const outcome: Promise<boolean> = Promise.resolve(save).then(
      (result) => result !== false,
      () => false,
    );
    let forKey = this.saving.get(key);
    if (!forKey) this.saving.set(key, (forKey = new Set()));
    forKey.add(outcome);
    this.changed();
    void outcome.then(() => {
      const set = this.saving.get(key);
      set?.delete(outcome);
      if (set && set.size === 0) this.saving.delete(key);
      this.changed();
    });
    return outcome;
  }
  isSaving(): boolean {
    return this.saving.size > 0;
  }
  /** Waits for every save registered so far (and any registered while waiting); true if all saved. */
  async waitForSaves(): Promise<boolean> {
    let allSaved = true;
    while (this.saving.size > 0) {
      const pending = [...this.saving.values()].flatMap((set) => [...set]);
      const results = await Promise.all(pending);
      if (results.includes(false)) allSaved = false;
      // Let the bookkeeping above (which runs on the same promises) catch up before looking again.
      await Promise.resolve();
    }
    return allSaved;
  }

  addNote(text: string) {
    // The same failure twice (e.g. retried) shows once.
    if (this.notesList.some((n) => n.text === text)) return;
    this.notesList = [...this.notesList, { id: this.nextNoteId++, text }];
    this.changed();
  }
  dismissNote(id: number) {
    this.notesList = this.notesList.filter((n) => n.id !== id);
    this.changed();
  }
  notes(): readonly UnsavedNote[] {
    return this.notesList;
  }
}

/** TS-206: the page-level note for a save that failed after its tab closed. */
export function couldntSaveNote(field: string, reason: string): string {
  const why = reason.trim().replace(/\.$/, "");
  return why ? `Couldn't save ${field}: ${why}.` : `Couldn't save ${field}.`;
}
