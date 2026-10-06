"use client";

import { formatDateTime } from "@/lib/display-format";
import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { api } from "@/lib/api-client";
import type { NotificationDTO } from "@seatwise/shared";

const TYPE_LABELS: Record<string, string> = {
  PLAN_SHARED: "Plan shared",
  COMMENT_REPLY: "Reply",
  TABLE_CHANGED: "Table change",
  GUEST_ADDED: "Guest added",
  GUEST_REMOVED: "Guest removed",
  ATTENDANCE_CHANGED: "Attendance",
  STATUS_CHANGED: "Status change",
  RSVP_RECEIVED: "RSVP",
};

// TS-13/FR-10.2: a lightweight bell + dropdown, polled rather than pushed (no websocket in this
// app) — good enough for "check back and see what changed" without adding real-time infrastructure.
export function NotificationsBell({
  onLeave,
}: {
  /**
   * TS-166: asked before following the bell's "Back to dashboard" link. Returning false stops it
   * (the wedding page uses this to ask first when a tab has unsaved input).
   */
  onLeave?: (href: string) => boolean;
} = {}) {
  const [notifications, setNotifications] = useState<NotificationDTO[]>([]);
  const [unreadCount, setUnreadCount] = useState(0);
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  async function load() {
    try {
      const res = await api.get<{ notifications: NotificationDTO[]; unreadCount: number }>(
        "/api/v1/notifications"
      );
      setNotifications(res.notifications);
      setUnreadCount(res.unreadCount);
    } catch {
      // best-effort — a failed notification fetch shouldn't break the page around it
    }
  }

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- TS-176: loads notifications on open, then every 30 seconds.
    load();
    const interval = setInterval(load, 30000);
    return () => clearInterval(interval);
  }, []);

  // TS-175: closes on a tap outside (pointerdown -- iPhone taps don't always send mousedown) and
  // on Escape, which returns focus to the bell.
  const buttonRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    function onPointerOutside(e: PointerEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape" && ref.current?.contains(document.activeElement)) {
        setOpen(false);
        buttonRef.current?.focus();
      }
    }
    document.addEventListener("pointerdown", onPointerOutside);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onPointerOutside);
      document.removeEventListener("keydown", onKey);
    };
  }, []);

  async function onMarkAllRead() {
    setNotifications((prev) => prev.map((n) => ({ ...n, isRead: true })));
    setUnreadCount(0);
    try {
      await api.post("/api/v1/notifications");
    } catch {
      load();
    }
  }

  async function onMarkOneRead(id: string) {
    setNotifications((prev) => prev.map((n) => (n.id === id ? { ...n, isRead: true } : n)));
    setUnreadCount((c) => Math.max(0, c - 1));
    try {
      await api.post(`/api/v1/notifications/${id}/read`);
    } catch {
      load();
    }
  }

  return (
    <div ref={ref} className="relative">
      <button
        ref={buttonRef}
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        aria-label={`Notifications${unreadCount > 0 ? ` (${unreadCount} unread)` : ""}`}
        className="relative flex h-11 w-11 items-center justify-center rounded-md border border-neutral-300 dark:border-neutral-600 text-lg hover:bg-neutral-50 dark:hover:bg-neutral-800"
      >
        🔔
        {unreadCount > 0 && (
          <span className="absolute -right-1 -top-1 flex h-5 min-w-5 items-center justify-center rounded-full bg-red-600 dark:bg-red-500 px-1 text-xs font-medium text-white">
            {unreadCount > 9 ? "9+" : unreadCount}
          </span>
        )}
      </button>

      {open && (
        // TS-175: never wider than the screen (it was cut off on phones).
        <div className="absolute right-0 z-20 mt-2 w-80 max-w-[calc(100vw-2rem)] rounded-lg border border-neutral-200 dark:border-neutral-700 bg-white dark:bg-neutral-900 shadow-lg">
          <div className="flex items-center justify-between border-b border-neutral-100 dark:border-neutral-800 px-4 py-2">
            <p className="text-sm font-medium">Notifications</p>
            {unreadCount > 0 && (
              <button onClick={onMarkAllRead} className="text-xs text-neutral-500 dark:text-neutral-400 hover:underline">
                Mark all read
              </button>
            )}
          </div>
          <div className="max-h-96 overflow-y-auto">
            {notifications.length === 0 ? (
              <p className="px-4 py-6 text-center text-sm text-neutral-500 dark:text-neutral-400">No notifications yet.</p>
            ) : (
              notifications.map((n) => (
                <button
                  key={n.id}
                  onClick={() => onMarkOneRead(n.id)}
                  className={`flex w-full flex-col items-start gap-0.5 border-b border-neutral-50 px-4 py-3 text-left last:border-0 hover:bg-neutral-50 dark:hover:bg-neutral-800 ${
                    // TS-175: a dark-mode shade too -- the light one made unread rows unreadable.
                    n.isRead ? "" : "bg-blue-50/50 dark:bg-blue-950/60"
                  }`}
                >
                  <div className="flex w-full items-center justify-between gap-2">
                    <span className="text-xs font-medium text-neutral-500 dark:text-neutral-400">
                      {TYPE_LABELS[n.type] ?? n.type} · {n.weddingName}
                    </span>
                    {!n.isRead && <span className="h-2 w-2 shrink-0 rounded-full bg-blue-600 dark:bg-blue-500" />}
                  </div>
                  <span className="text-sm text-neutral-800 dark:text-neutral-200">{n.message}</span>
                  <span className="text-xs text-neutral-500 dark:text-neutral-400">
                    {formatDateTime(n.createdAt)}
                  </span>
                </button>
              ))
            )}
          </div>
          <div className="border-t border-neutral-100 dark:border-neutral-800 px-4 py-2 text-center">
            <Link
              href="/dashboard"
              onClick={(e) => {
                if (onLeave && !onLeave("/dashboard")) e.preventDefault();
              }}
              className="text-xs text-neutral-500 dark:text-neutral-400 hover:underline"
            >
              Back to dashboard
            </Link>
          </div>
        </div>
      )}
    </div>
  );
}
