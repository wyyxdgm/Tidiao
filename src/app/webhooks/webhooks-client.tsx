"use client";

import { useState } from "react";
import Link from "next/link";
import { useToastActions } from "@/components/Toast";
import ConfirmDialog from "@/components/ConfirmDialog";

type Webhook = {
  id: string;
  name: string;
  url: string;
  events: string[];
  active: number | boolean;
  created_at: string;
  secret?: string;
};

export default function WebhooksClient({
  initialWebhooks,
  availableEvents,
}: {
  initialWebhooks: Webhook[];
  availableEvents: string[];
}) {
  const [webhooks, setWebhooks] = useState<Webhook[]>(initialWebhooks);
  const { error: toastError } = useToastActions();
  const [showCreate, setShowCreate] = useState(false);
  const [creating, setCreating] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [deleteConfirm, setDeleteConfirm] = useState<{ id: string } | null>(null);
  const [createForm, setCreateForm] = useState({
    name: "",
    url: "",
    events: [] as string[],
    secret: "",
  });
  const [editForm, setEditForm] = useState<{ events: string[]; active: boolean }>({
    events: [],
    active: true,
  });
  const [createError, setCreateError] = useState<string | null>(null);

  async function refresh() {
    const res = await fetch("/api/webhooks");
    const data = await res.json();
    setWebhooks(data);
  }

  async function createWebhook() {
    if (!createForm.name || !createForm.url || !createForm.secret) {
      setCreateError("name/url/secret 必填");
      return;
    }
    if (createForm.events.length === 0) {
      setCreateError("至少选一个事件");
      return;
    }
    setCreating(true);
    setCreateError(null);
    try {
      const res = await fetch("/api/webhooks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(createForm),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      setShowCreate(false);
      setCreateForm({ name: "", url: "", events: [], secret: "" });
      await refresh();
    } catch (err) {
      setCreateError(err instanceof Error ? err.message : "创建失败");
    } finally {
      setCreating(false);
    }
  }

  async function confirmDeleteWebhook() {
    const id = deleteConfirm?.id;
    if (!id) return;
    await fetch(`/api/webhooks/${id}`, { method: "DELETE" });
    setDeleteConfirm(null);
    await refresh();
  }

  async function saveEdit(id: string) {
    const res = await fetch(`/api/webhooks/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        events: editForm.events,
        active: editForm.active,
      }),
    });
    const data = await res.json();
    if (!res.ok) {
      toastError(data.error || "保存失败");
      return;
    }
    setEditingId(null);
    await refresh();
  }

  function startEdit(w: Webhook) {
    setEditingId(w.id);
    setEditForm({ events: [...w.events], active: !!w.active });
  }

  function toggleEvent(setEvents: (next: string[]) => void, current: string[], ev: string) {
    setEvents(current.includes(ev) ? current.filter((e) => e !== ev) : [...current, ev]);
  }

  return (
    // 🆕 飞书 R139 第四批: /webhooks 右滚修复——同款套路.
    <div className="h-full flex flex-col bg-gray-50">
      <header className="bg-white border-b border-gray-200 px-6 py-4 shrink-0">
        <div className="flex items-center justify-between">
          <div>
            <div className="text-sm text-gray-500 mb-1">
              <Link href="/" className="hover:text-blue-600">项目</Link>
              <span className="mx-1">›</span>
              <span>Webhooks</span>
            </div>
            <h1 className="text-2xl font-bold text-gray-900">Webhook 管理</h1>
            <p className="text-sm text-gray-500 mt-1">
              监听 task lifecycle 事件。HMAC-SHA256 签名在 <code className="font-mono text-xs bg-gray-100 px-1 rounded">X-Signature</code> 头
            </p>
          </div>
          <button
            onClick={() => {
              setShowCreate(true);
              setCreateError(null);
            }}
            className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 text-sm"
          >
            + 新建 Webhook
          </button>
        </div>
      </header>

      <main className="flex-1 min-h-0 overflow-y-auto max-w-5xl w-full mx-auto px-6 py-6 space-y-4">
        {webhooks.length === 0 && (
          <div className="text-center py-12 bg-white rounded-lg border border-gray-200">
            <div className="text-4xl mb-3">🔔</div>
            <p className="text-gray-500 text-sm">还没有 webhook -- 点击"新建 Webhook"开始</p>
          </div>
        )}

        {webhooks.map((w) => {
          const isEditing = editingId === w.id;
          return (
            <div
              key={w.id}
              className="bg-white rounded-lg border border-gray-200 overflow-hidden"
            >
              <div className="px-5 py-4 flex items-start justify-between gap-3">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <h3 className="text-lg font-semibold text-gray-900">{w.name}</h3>
                    <span
                      className={`text-xs px-2 py-0.5 rounded-full ${
                        w.active
                          ? "bg-emerald-100 text-emerald-700"
                          : "bg-gray-100 text-gray-500"
                      }`}
                    >
                      {w.active ? "启用" : "禁用"}
                    </span>
                  </div>
                  <code className="block mt-1 text-xs text-gray-500 font-mono break-all">
                    {w.url}
                  </code>
                  <div className="mt-2 flex flex-wrap gap-1">
                    {w.events.map((ev) => (
                      <span
                        key={ev}
                        className="text-xs px-2 py-0.5 bg-blue-50 text-blue-700 rounded-full font-mono"
                      >
                        {ev}
                      </span>
                    ))}
                  </div>
                </div>
                <div className="flex flex-col items-end gap-1 shrink-0">
                  <Link
                    href={`/webhooks/${w.id}`}
                    className="text-xs text-gray-500 hover:text-blue-600 px-2"
                  >
                    详情 & 投递历史
                  </Link>
                  {!isEditing && (
                    <button
                      onClick={() => startEdit(w)}
                      className="text-xs text-gray-400 hover:text-blue-500 px-2"
                    >
                      编辑
                    </button>
                  )}
                  <button
                    onClick={() => setDeleteConfirm({ id: w.id })}
                    className="text-xs text-gray-400 hover:text-red-500 px-2"
                  >
                    删除
                  </button>
                </div>
              </div>
              {isEditing && (
                <div className="px-5 py-3 bg-gray-50 border-t border-gray-100 space-y-2">
                  <div className="text-xs text-gray-600">事件订阅</div>
                  <div className="flex flex-wrap gap-2">
                    {availableEvents.map((ev) => (
                      <label
                        key={ev}
                        className="flex items-center gap-1 text-xs cursor-pointer"
                      >
                        <input
                          type="checkbox"
                          checked={editForm.events.includes(ev)}
                          onChange={() =>
                            setEditForm({
                              ...editForm,
                              events: editForm.events.includes(ev)
                                ? editForm.events.filter((e) => e !== ev)
                                : [...editForm.events, ev],
                            })
                          }
                        />
                        <span className="font-mono">{ev}</span>
                      </label>
                    ))}
                  </div>
                  <label className="flex items-center gap-2 text-xs">
                    <input
                      type="checkbox"
                      checked={editForm.active}
                      onChange={(e) =>
                        setEditForm({ ...editForm, active: e.target.checked })
                      }
                    />
                    启用
                  </label>
                  <div className="flex items-center gap-2">
                    <button
                      onClick={() => saveEdit(w.id)}
                      className="px-3 py-1 bg-blue-600 text-white rounded text-sm"
                    >
                      保存
                    </button>
                    <button
                      onClick={() => setEditingId(null)}
                      className="px-3 py-1 text-gray-600 text-sm"
                    >
                      取消
                    </button>
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </main>

      {showCreate && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50">
          <div className="bg-white rounded-lg shadow-xl w-[520px] max-w-[92vw] p-5">
            <div className="flex items-center mb-3">
              <h3 className="text-base font-semibold text-gray-800">新建 Webhook</h3>
              <button
                onClick={() => setShowCreate(false)}
                className="ml-auto text-gray-400 hover:text-gray-700"
                title="关闭"
              >
                ✕
              </button>
            </div>
            <div className="space-y-3 text-sm">
              <div>
                <label className="block text-xs text-gray-600 mb-1">名称 *</label>
                <input
                  type="text"
                  value={createForm.name}
                  onChange={(e) => setCreateForm({ ...createForm, name: e.target.value })}
                  placeholder="如: CI 监听"
                  className="w-full border rounded px-2 py-1.5"
                />
              </div>
              <div>
                <label className="block text-xs text-gray-600 mb-1">URL *</label>
                <input
                  type="text"
                  value={createForm.url}
                  onChange={(e) => setCreateForm({ ...createForm, url: e.target.value })}
                  placeholder="https://example.com/hook"
                  className="w-full border rounded px-2 py-1.5 font-mono"
                />
              </div>
              <div>
                <label className="block text-xs text-gray-600 mb-1">Secret *</label>
                <input
                  type="text"
                  value={createForm.secret}
                  onChange={(e) => setCreateForm({ ...createForm, secret: e.target.value })}
                  placeholder="用于 HMAC-SHA256 签名的密钥"
                  className="w-full border rounded px-2 py-1.5 font-mono"
                />
              </div>
              <div>
                <label className="block text-xs text-gray-600 mb-1">订阅事件 (至少 1)</label>
                <div className="flex flex-wrap gap-2 max-h-40 overflow-y-auto border rounded p-2">
                  {availableEvents.map((ev) => (
                    <label
                      key={ev}
                      className="flex items-center gap-1 text-xs cursor-pointer"
                    >
                      <input
                        type="checkbox"
                        checked={createForm.events.includes(ev)}
                        onChange={() =>
                          setCreateForm({
                            ...createForm,
                            events: createForm.events.includes(ev)
                              ? createForm.events.filter((e) => e !== ev)
                              : [...createForm.events, ev],
                          })
                        }
                      />
                      <span className="font-mono">{ev}</span>
                    </label>
                  ))}
                </div>
              </div>
              {createError && (
                <div className="text-xs text-red-600">⚠ {createError}</div>
              )}
            </div>
            <div className="flex justify-end gap-2 mt-4">
              <button
                onClick={() => setShowCreate(false)}
                className="px-3 py-1.5 text-sm border rounded hover:bg-gray-50"
              >
                取消
              </button>
              <button
                onClick={createWebhook}
                disabled={creating}
                className="px-3 py-1.5 text-sm bg-blue-600 text-white rounded hover:bg-blue-700 disabled:bg-blue-400"
              >
                {creating ? "创建中..." : "创建"}
              </button>
            </div>
          </div>
        </div>
      )}

      <ConfirmDialog
        open={!!deleteConfirm}
        title="删除 Webhook"
        message="删除这个 webhook？"
        confirmLabel="删除"
        variant="danger"
        onConfirm={confirmDeleteWebhook}
        onCancel={() => setDeleteConfirm(null)}
      />
    </div>
  );
}
