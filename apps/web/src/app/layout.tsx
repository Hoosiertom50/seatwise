import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import { SessionExpiredNotice } from "@/components/SessionExpiredNotice";
import { SupportFooter } from "@/components/SupportFooter";
import { APPEARANCE_BOOT_SCRIPT } from "@/lib/appearance";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  // TS-175: each page names itself ("Sign in · Seatwise").
  title: { template: "%s · Seatwise", default: "Seatwise" },
  description: "Wedding seating & table assignment planner",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
      // TS-257: the script below sets data-theme before React loads, so React mustn't call it a mismatch.
      suppressHydrationWarning
    >
      <head>
        {/* TS-257: apply a saved Light/Dark choice before the page is drawn (no flash of the other theme). */}
        <script dangerouslySetInnerHTML={{ __html: APPEARANCE_BOOT_SCRIPT }} />
      </head>
      <body className="min-h-full flex flex-col">
        <SessionExpiredNotice />
        {children}
        <SupportFooter />
      </body>
    </html>
  );
}
