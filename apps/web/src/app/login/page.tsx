"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { api, ApiError } from "@/lib/api-client";
import type { AuthResponse } from "@seatwise/shared";

export default function LoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      await api.post<AuthResponse>("/api/v1/auth/login", { email, password });
      router.push("/dashboard");
      router.refresh();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Something went wrong");
    } finally {
      setLoading(false);
    }
  }

  return (
    <main className="flex flex-1 items-center justify-center px-6">
      <div className="w-full max-w-sm">
        <h1 className="mb-6 text-2xl font-semibold">Log in</h1>
        <form onSubmit={onSubmit} className="flex flex-col gap-4">
          <div>
            <label htmlFor="login-email" className="mb-1 block text-sm font-medium">
              Email
            </label>
            <input
              id="login-email"
              type="email"
              className="w-full rounded-md border border-neutral-300 dark:border-neutral-600 px-3 py-2 text-sm"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
            />
          </div>
          <div>
            <label htmlFor="login-password" className="mb-1 block text-sm font-medium">
              Password
            </label>
            <input
              id="login-password"
              type="password"
              className="w-full rounded-md border border-neutral-300 dark:border-neutral-600 px-3 py-2 text-sm"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
            />
          </div>
          {error && <p className="text-sm text-red-600 dark:text-red-400">{error}</p>}
          <button
            type="submit"
            disabled={loading}
            className="rounded-md bg-neutral-900 dark:bg-neutral-100 px-4 py-2 text-sm font-medium text-white dark:text-neutral-900 hover:bg-neutral-700 dark:hover:bg-neutral-300 dark:hover:bg-neutral-300 disabled:opacity-50"
          >
            {loading ? "Logging in..." : "Log in"}
          </button>
        </form>
        <p className="mt-4 text-sm text-neutral-600 dark:text-neutral-300">
          Don&apos;t have an account?{" "}
          <Link href="/signup" className="font-medium underline">
            Sign up
          </Link>
        </p>
      </div>
    </main>
  );
}
