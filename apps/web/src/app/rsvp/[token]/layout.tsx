import type { Metadata } from "next";

// TS-175: the browser tab says which page this is (every tab used to say just "Seatwise").
export const metadata: Metadata = { title: "RSVP" };

export default function Layout({ children }: { children: React.ReactNode }) {
  return children;
}
