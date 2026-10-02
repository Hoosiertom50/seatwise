import { SUPPORT_EMAIL, SUPPORT_MAILTO, SUPPORT_PROMISE } from "@/lib/support";

// TS-100: a "Contact support" link at the bottom of every page.
export function SupportFooter() {
  return (
    <footer className="mt-auto border-t border-neutral-200 dark:border-neutral-800 px-4 py-4 text-center text-xs text-neutral-500 dark:text-neutral-400">
      Need help?{" "}
      <a href={SUPPORT_MAILTO} className="font-medium underline">
        Contact support
      </a>{" "}
      at {SUPPORT_EMAIL}. {SUPPORT_PROMISE}
    </footer>
  );
}
