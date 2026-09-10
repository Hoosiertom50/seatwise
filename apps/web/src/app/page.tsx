import Link from "next/link";

export default function Home() {
  return (
    <main className="flex flex-1 flex-col items-center justify-center gap-6 px-6 text-center">
      <h1 className="text-4xl font-semibold tracking-tight">Seatwise</h1>
      <p className="max-w-md text-neutral-600 dark:text-neutral-300">
        Build your guest list, define who has to sit together, and let Seatwise generate a
        seating chart that respects every rule.
      </p>
      <div className="flex gap-3">
        <Link
          href="/signup"
          className="rounded-md bg-neutral-900 dark:bg-neutral-100 px-4 py-2 text-sm font-medium text-white dark:text-neutral-900 hover:bg-neutral-700 dark:hover:bg-neutral-300 dark:hover:bg-neutral-300"
        >
          Get started
        </Link>
        <Link
          href="/login"
          className="rounded-md border border-neutral-300 dark:border-neutral-600 px-4 py-2 text-sm font-medium hover:bg-neutral-50 dark:hover:bg-neutral-800 dark:hover:bg-neutral-800"
        >
          Log in
        </Link>
      </div>
    </main>
  );
}
