"use client";

import { useState } from "react";
import Link from "next/link";
import { addRecentAccount } from "@/lib/recent-accounts";

export default function RegisterPage() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    if (password.length < 6) {
      setError("密码至少 6 位");
      return;
    }
    setLoading(true);
    const res = await fetch("/api/auth/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password }),
    });
    setLoading(false);
    if (res.ok) {
      // Stash a long-lived switch token so the new account appears in the
      // AccountSwitcher dropdown from the very first login.
      const data = await res.json().catch(() => null);
      if (data?.switchToken && data?.user?.email) {
        addRecentAccount(data.user.email, data.switchToken);
      }
      // 硬导航（非 router.push）：set-cookie 后 client-side navigation 可能仍带旧 cookie
      // 状态被 middleware 弹回 login。window.location 触发完整刷新，确保带新 cookie。
      const params = new URLSearchParams(window.location.search);
      window.location.href = params.get("from") || "/";
      return;
    }
    if (res.status === 409) {
      setError("该邮箱已注册");
    } else {
      const data = await res.json().catch(() => ({}));
      setError(data.error || "注册失败，请重试");
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-50 px-4">
      <div className="w-full max-w-sm bg-white rounded-lg shadow p-8">
        <h1 className="text-xl font-semibold mb-6 text-center">注册</h1>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="block text-sm text-gray-600 mb-1">邮箱</label>
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
              autoComplete="email"
              className="w-full px-3 py-2 border border-gray-300 rounded focus:outline-none focus:border-blue-500"
            />
          </div>
          <div>
            <label className="block text-sm text-gray-600 mb-1">
              密码（至少 6 位）
            </label>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              autoComplete="new-password"
              className="w-full px-3 py-2 border border-gray-300 rounded focus:outline-none focus:border-blue-500"
            />
          </div>
          {error && <p className="text-sm text-red-600">{error}</p>}
          <button
            type="submit"
            disabled={loading}
            className="w-full py-2 bg-blue-600 text-white rounded hover:bg-blue-700 disabled:opacity-50"
          >
            {loading ? "注册中…" : "注册"}
          </button>
        </form>
        <p className="text-sm text-gray-500 text-center mt-4">
          已有账号？{" "}
          <Link href="/login" className="text-blue-600 hover:underline">
            登录
          </Link>
        </p>
      </div>
    </div>
  );
}
