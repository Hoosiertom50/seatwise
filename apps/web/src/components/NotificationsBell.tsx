"use client";

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
};

// TS-13/FR-10.2: a lightweight bell + dropdown, polled rather than pushed (no websocket in this
// app) — good enough for "check back and see what changed" without adding real-time infrastructure.
export function NotificationsBell() {
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
    load();
    const interval = setInterval(load, 30000);
    return () => clearInterval(interval);
  }, []);

  useEffect(() => {
    function onClickOutside(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onClickOutside);
    return () => document.removeEventListener("mousedown", onClickOutside);
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
        onClick={() => setOpen((o) => !o)}
        aria-label={`Notifications${unreadCount > 0 ? ` (${unreadCount} unread)` : ""}`}
        className="relative flex h-11 w-11 items-center justify-center rounded-md border border-neutral-300 text-lg hover:bg-neutral-50"
      >
        🔔
        {unreadCount > 0 && (
          <span className="absolute -right-1 -top-1 flex h-5 min-w-5 items-center justify-center rounded-full bg-red-600 px-1 text-xs font-medium text-white">
            {unreadCount > 9 ? "9+" : unreadCount}
          </span>
        )}
      </button>

      {open && (
        <div className="absolute right-0 z-20 mt-2 w-80 rounded-lg border border-neutral-200 bg-white shadow-lg">
          <div className="flex items-center justify-between border-b border-neutral-100 px-4 py-2">
            <p className="text-sm font-medium">Notifications</p>
            {unreadCount > 0 && (
              <button onClick={onMarkAllRead} className="text-xs text-neutral-500 hover:underline">
                Mark all read
              </button>
            )}
          </div>
          <div className="max-h-96 overflow-y-auto">
            {notifications.length === 0 ? (
              <p className="px-4 py-6 text-center text-sm text-neutral-500">No notifications yet.</p>
            ) : (
              notifications.map((n) => (
                <button
                  key={n.id}
                  onClick={() => onMarkOneRead(n.id)}
                  className={`flex w-full flex-col items-start gap-0.5 border-b border-neutral-50 px-4 py-3 text-left last:border-0 hover:bg-neutral-50 ${
                    n.isRead ? "" : "bg-blue-50/50"
                  }`}
                >
                  <div className="flex w-full items-center justify-between gap-2">
                    <span className="text-xs font-medium text-neutral-500">
                      {TYPE_LABELS[n.type] ?? n.type} · {n.weddingName}
                    </span>
                    {!n.isRead && <span className="h-2 w-2 shrink-0 rounded-full bg-blue-600" />}
                  </div>
                  <span className="text-sm text-neutral-800">{n.message}</span>
                  <span className="text-xs text-neutral-500">
                    {new Date(n.createdAt).toLocaleString()}
                  </span>
                </button>
              ))
            )}
          </div>
          <div className="border-t border-neutral-100 px-4 py-2 text-center">
            <Link href="/dashboard" className="text-xs text-neutral-500 hover:underline">
              Back to dashboard
            </Link>
          </div>
        </div>
      )}
    </div>
  );
}
