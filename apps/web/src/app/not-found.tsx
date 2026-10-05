import type { Metadata } from "next";
import Link from "next/link";

// TS-175: a Seatwise page for an address that doesn't exist, instead of the framework's default.
export const metadata: Metadata = { title: "Page not found" };

export default function NotFound() {
  return (
    <main className="mx-auto flex w-full max-w-md flex-1 flex-col items-center justify-center gap-4 px-6 py-16 text-center">
      <h1 className="text-xl font-semibold">Page not found</h1>
      <p className="text-sm text-neutral-600 dark:text-neutral-300">
        There&apos;s nothing at this address. If you followed a link from an email, it may be mistyped.
      </p>
      <Link href="/dashboard" className="rounded-md border border-neutral-300 dark:border-neutral-600 px-4 py-2 text-sm hover:bg-neutral-50 dark:hover:bg-neutral-800">
        Go to your dashboard
      </Link>
    </main>
  );
}
