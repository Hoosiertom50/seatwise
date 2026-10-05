"use client";

import Link from "next/link";
import { useEffect } from "react";

// TS-175: a page that fails to draw shows this, with a way to try again, instead of the browser's
// bare error screen.
export default function Error({ error, retry }: { error: Error & { digest?: string }; retry: () => void }) {
  useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <main className="mx-auto flex w-full max-w-md flex-1 flex-col items-center justify-center gap-4 px-6 py-16 text-center">
      <title>Something went wrong · Seatwise</title>
      <h1 className="text-xl font-semibold">Something went wrong</h1>
      <p className="text-sm text-neutral-600 dark:text-neutral-300">
        This page couldn&apos;t be shown. Your saved work is safe — try again, or go back to your dashboard.
      </p>
      <div className="flex gap-3">
        <button
          type="button"
          onClick={() => retry()}
          className="rounded-md bg-neutral-900 dark:bg-neutral-100 px-4 py-2 text-sm font-medium text-white dark:text-neutral-900 hover:bg-neutral-700 dark:hover:bg-neutral-300"
        >
          Try again
        </button>
        <Link href="/dashboard" className="rounded-md border border-neutral-300 dark:border-neutral-600 px-4 py-2 text-sm hover:bg-neutral-50 dark:hover:bg-neutral-800">
          Dashboard
        </Link>
      </div>
    </main>
  );
}
