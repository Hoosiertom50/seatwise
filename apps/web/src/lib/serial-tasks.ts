"use client";

import { useCallback, useRef } from "react";

// TS-166: a plan edit carries the plan's revision, so the server can refuse a change made against
// an older copy. Two quick edits from the same screen (drag two guests in a row) used to both send
// the revision from before either landed, and the second was refused as if someone else had
// changed the plan. Edits queued through this run one after another instead; each reads the
// latest revision when its turn comes. A failed task never blocks the ones after it.
export function useSerialTasks(): <T>(task: () => Promise<T>) => Promise<T> {
  const tail = useRef<Promise<unknown>>(Promise.resolve());
  return useCallback(<T,>(task: () => Promise<T>): Promise<T> => {
    const run = tail.current.then(task, task);
    tail.current = run.catch(() => undefined);
    return run;
  }, []);
}
