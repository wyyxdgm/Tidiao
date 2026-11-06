"use client";

// Runner 管理客户端 (R4: UI).
//
// 关注点:
//  - 列 / 注册 / 删除 / 健康检查 4 个动作; 注册成功后弹窗一次性 token (不落
//    state 之外的任何地方, 关弹窗就看不到).
//  - 不引入新的 UI 抽象: 用现成 Select / ConfirmDialog / Toast. 红线由
//    src/app/runners/page.tsx (server component) 守住 admin gating, 这里
//    再 fetch 一次 /api/runners 失败的话 toast.error 即可.

import { useCallback, useEffect, useState } from "react";
import Select from "@/components/Select";
import ConfirmDialog from "@/components/ConfirmDialog";
import { useToastActions } from "@/components/Toast";

type Runner = {
  id: string;
  name: string;
  host: string;
  port: number;
  os_type: "macos" | "windows" | "linux";
  capabilities: string | null;
  status: "online" | "offline" | "dead";
  last_heartbeat_at: string | null;
  last_health_json: string | null;
  created_at: string;
};

type DeleteTarget = { id: string; name: string };

// mac/win/linux 三个常量写死 (UI 不会变). 跟 src/lib/db/runners.ts 的
// OS_TYPES 保持一致 — 后端 validate 仍是权威, 这里只是 options 来源.
const OS_OPTIONS = [
  { value: "macos", label: "macOS" },
  { value: "windows", label: "Windows" },
  { value: "linux", label: "Linux" },
];

const STATUS_COLORS: Record<Runner["status"], string> = {
  online: "bg-emerald-100 text-emerald-700",
  offline: "bg-gray-200 text-gray-700",
  dead: "bg-red-100 text-red-700",
};

const STATUS_LABEL: Record<Runner["status"], string> = {
  online: "在线",
  offline: "离线",
  dead: "失联",
};

function formatTime(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
    `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
  );
}

function parseCapabilities(raw: string | null): string {
  if (!raw) return "—";
  try {
    const obj = JSON.parse(raw);
    const parts: string[] = [];
    if (Array.isArray(obj.shells)) parts.push(`shells=${obj.shells.join(",")}`);
    if (typeof obj.max_concurrent === "number") parts.push(`max=${obj.max_concurrent}`);
    return parts.length > 0 ? parts.join(" · ") : "—";
  } catch {
    return raw.length > 40 ? `${raw.slice(0, 40)}…` : raw;
  }
}

export default function RunnersClient() {
  const toast = useToastActions();
  const [runners, setRunners] = useState<Runner[]>([]);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const [host, setHost] = useState("");
  const [port, setPort] = useState("");
  const [osType, setOsType] = useState<Runner["os_type"]>("macos");
  const [registToken, setRegistedToken] = useState<string | null>(null);
  const [registeredRunner, setRegisteredRunner] = useState<Runner | null>(null);
  const [tokenCopied, setTokenCopied] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<DeleteTarget | null>(null);
  const [healthLoadingId, setHealthLoadingId] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const res = await fetch("/api/runners");
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        toast.error(`加载失败：${data.error || res.statusText}`);
        setRunners([]);
        return;
      }
      const data = await res.json();
      setRunners(data.runners || []);
    } catch (err) {
      toast.error(`加载失败：${(err as Error).message}`);
    } finally {
      setLoading(false);
    }
  }, [toast]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  async function handleRegister() {
    const trimmedName = name.trim();
    const trimmedHost = host.trim();
    if (!trimmedName) {
      toast.error("name 必填");
      return;
    }
    if (!trimmedHost) {
      toast.error("host 必填");
      return;
    }
    const portNum = Number(port);
    if (!Number.isInteger(portNum) || portNum < 1 || portNum > 65535) {
      toast.error("port 必须是 1-65535 整数");
      return;
    }
    setCreating(true);
    try {
      const res = await fetch("/api/runners", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: trimmedName,
          host: trimmedHost,
          port: portNum,
          os_type: osType,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        const dup = data.code === "DUPLICATE_HOST_PORT";
        toast.error(dup ? `已注册同 host:port 的 runner: ${trimmedHost}:${portNum}` : (data.error || `HTTP ${res.status}`));
        return;
      }
      // token 用 modal-local state, 关弹窗就看不到 (也不从 registry 重读)
      setRegisteredRunner(data.runner);
      setRegistedToken(data.token);
      setTokenCopied(false);
      setName("");
      setHost("");
      setPort("");
      await refresh();
    } catch (err) {
      toast.error(`注册失败：${(err as Error).message}`);
    } finally {
      setCreating(false);
    }
  }

  function closeTokenModal() {
    setRegistedToken(null);
    setRegisteredRunner(null);
    setTokenCopied(false);
  }

  async function copyToken() {
    if (!registToken) return;
    try {
      await navigator.clipboard.writeText(registToken);
      setTokenCopied(true);
      toast.success("Token 已复制到剪贴板");
    } catch {
      toast.error("复制失败，请手动选中复制");
    }
  }

  async function handleDelete() {
    if (!deleteTarget) return;
    try {
      const res = await fetch(`/api/runners/${deleteTarget.id}`, { method: "DELETE" });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        toast.error(`删除失败：${data.error || res.statusText}`);
        return;
      }
      toast.success(`已删除 runner「${deleteTarget.name}」`);
      await refresh();
    } catch (err) {
      toast.error(`删除失败：${(err as Error).message}`);
    } finally {
      setDeleteTarget(null);
    }
  }

  async function handleHealthCheck(r: Runner) {
    setHealthLoadingId(r.id);
    try {
      const res = await fetch(`/api/runners/${r.id}/health`, { method: "POST" });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(`健康检查失败：${data.error || res.statusText}`);
        return;
      }
      // 200 + health 字段就是 runner 的 /v1/health JSON
      const text = (() => {
        try {
          return JSON.stringify(JSON.parse(data.health), null, 2);
        } catch {
          return data.health || "(空)";
        }
      })();
      toast.info(`「${r.name}」健康检查\n${text}`);
      await refresh();
    } catch (err) {
      toast.error(`健康检查失败：${(err as Error).message}`);
    } finally {
      setHealthLoadingId(null);
    }
  }

  return (
    // 🆕 飞书 R139 第二批: 同款右滚修复 (与 schedules-client 一致), 根容器改 h-full flex-col, header shrink-0, main 自滚.
    <div className="h-full flex flex-col bg-gray-50">
      <header className="bg-white border-b border-gray-200 px-4 md:px-6 py-4 shrink-0">
        <h1 className="text-xl md:text-2xl font-bold text-gray-900">Runners</h1>
        <p className="text-sm text-gray-500 mt-1">
          跨机器白名单命令的远程执行 daemon。每条 runner = 一台目标机上一个独立的
          <code className="mx-1 bg-gray-100 rounded px-1">agent-orch-runner</code>
          进程, 用 256-bit token 鉴权心跳。MVP 手动起 (不进 launchd / Windows service)。
        </p>
      </header>

      <main className="flex-1 min-h-0 overflow-y-auto max-w-6xl w-full mx-auto px-4 md:px-6 py-6 space-y-5">
        {/* 注册表单 */}
        <section className="bg-white rounded-lg border border-gray-200 px-5 py-4">
          <div className="text-sm font-semibold text-gray-800 mb-3">注册 Runner</div>
          <div className="grid grid-cols-1 md:grid-cols-[1fr_1fr_120px_140px_auto] gap-3 items-end">
            <label className="flex flex-col gap-1">
              <span className="text-xs text-gray-600">name</span>
              <input
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="mac-build"
                className="border border-gray-300 rounded px-3 py-1.5 text-sm"
              />
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-xs text-gray-600">host (IP 或域名)</span>
              <input
                type="text"
                value={host}
                onChange={(e) => setHost(e.target.value)}
                placeholder="192.168.3.243"
                className="border border-gray-300 rounded px-3 py-1.5 text-sm font-mono"
              />
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-xs text-gray-600">port</span>
              <input
                type="text"
                value={port}
                onChange={(e) => setPort(e.target.value)}
                placeholder="8081"
                inputMode="numeric"
                className="border border-gray-300 rounded px-3 py-1.5 text-sm font-mono"
              />
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-xs text-gray-600">os_type</span>
              <Select
                value={osType}
                onChange={(v) => setOsType(v as Runner["os_type"])}
                options={OS_OPTIONS}
              />
            </label>
            <button
              type="button"
              onClick={handleRegister}
              disabled={creating}
              className="px-4 py-2 bg-blue-600 text-white rounded-lg text-sm hover:bg-blue-700 disabled:opacity-50"
            >
              {creating ? "注册中..." : "注册"}
            </button>
          </div>
          <p className="text-xs text-amber-700 mt-3 leading-5">
            🔴 注册成功后弹窗一次性显示 token, 关掉就没了, 请立刻拷给运维在
            目标机上配 <code className="bg-amber-50 px-1 rounded">~/.agent-orch-runner/config.json</code>。
            port 不要暴露到公网; agent 跑的是白名单命令, 但 token 是
            shared secret, 一旦泄露 = 这台机器被任意执行白名单命令。
          </p>
        </section>

        {/* 列表 */}
        <section className="bg-white rounded-lg border border-gray-200 overflow-hidden">
          <div className="px-5 py-3 border-b border-gray-100 flex items-center justify-between">
            <div className="text-sm font-semibold text-gray-800">已注册 Runner</div>
            <button
              type="button"
              onClick={refresh}
              className="text-xs px-2 py-1 text-gray-600 hover:text-gray-900"
            >
              刷新
            </button>
          </div>
          {loading && <div className="px-5 py-8 text-sm text-gray-500">加载中...</div>}
          {!loading && runners.length === 0 && (
            <div className="px-5 py-12 text-center text-sm text-gray-500">
              还没有注册任何 runner。
            </div>
          )}
          {!loading && runners.length > 0 && (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-xs text-gray-500 border-b border-gray-100 bg-gray-50">
                    <th className="px-5 py-2 font-medium">name</th>
                    <th className="px-3 py-2 font-medium">host:port</th>
                    <th className="px-3 py-2 font-medium">os</th>
                    <th className="px-3 py-2 font-medium">状态</th>
                    <th className="px-3 py-2 font-medium">last_heartbeat</th>
                    <th className="px-3 py-2 font-medium">capabilities</th>
                    <th className="px-5 py-2 font-medium text-right">操作</th>
                  </tr>
                </thead>
                <tbody>
                  {runners.map((r) => (
                    <tr key={r.id} className="border-b border-gray-100 last:border-b-0 hover:bg-gray-50">
                      <td className="px-5 py-2 font-medium text-gray-900">{r.name}</td>
                      <td className="px-3 py-2 font-mono text-xs text-gray-600">
                        {r.host}:{r.port}
                      </td>
                      <td className="px-3 py-2 text-xs text-gray-600">{r.os_type}</td>
                      <td className="px-3 py-2">
                        <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${STATUS_COLORS[r.status]}`}>
                          {STATUS_LABEL[r.status]}
                        </span>
                      </td>
                      <td className="px-3 py-2 text-xs text-gray-500 font-mono">
                        {formatTime(r.last_heartbeat_at)}
                      </td>
                      <td className="px-3 py-2 text-xs text-gray-500 font-mono truncate max-w-[220px]" title={r.last_health_json || ""}>
                        {parseCapabilities(r.capabilities || r.last_health_json)}
                      </td>
                      <td className="px-5 py-2 text-right">
                        <div className="flex items-center justify-end gap-2">
                          <button
                            type="button"
                            onClick={() => handleHealthCheck(r)}
                            disabled={healthLoadingId === r.id}
                            className="text-xs px-2 py-1 border border-gray-300 text-gray-700 rounded hover:bg-gray-50 disabled:opacity-50"
                          >
                            {healthLoadingId === r.id ? "检查中..." : "健康检查"}
                          </button>
                          <button
                            type="button"
                            onClick={() => setDeleteTarget({ id: r.id, name: r.name })}
                            className="text-xs px-2 py-1 border border-red-200 text-red-600 rounded hover:bg-red-50"
                          >
                            删除
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      </main>

      {/* 一次性 token 弹窗 */}
      {registToken && registeredRunner && (
        <div className="fixed inset-0 z-50 flex items-center justify-center">
          <div
            className="absolute inset-0 bg-black/40 backdrop-blur-sm"
            onClick={closeTokenModal}
          />
          <div className="relative bg-white rounded-xl shadow-2xl w-[560px] max-w-[92vw] p-6">
            <div className="flex items-center gap-2 mb-3">
              <span className="flex h-8 w-8 items-center justify-center rounded-full bg-amber-100 text-amber-600">
                🔑
              </span>
              <h3 className="text-lg font-semibold text-gray-900">
                Runner「{registeredRunner.name}」注册成功
              </h3>
            </div>
            <p className="text-sm text-gray-600 mb-3 leading-5">
              下面是这台 runner 的 <strong>一次性 token</strong>, 关掉这个弹窗 token 就看不到了。
              把它写到目标机的 <code className="bg-gray-100 px-1 rounded">~/.agent-orch-runner/config.json</code>{" "}
              (文件权限 <code className="bg-gray-100 px-1 rounded">0600</code>) 里, 然后
              <code className="bg-gray-100 px-1 rounded mx-1">./runner --daemon</code> 起。
            </p>
            <div className="bg-gray-900 text-emerald-200 font-mono text-xs rounded-lg p-3 break-all">
              {registToken}
            </div>
            <div className="flex items-center gap-2 mt-4">
              <button
                type="button"
                onClick={copyToken}
                className="px-4 py-2 bg-blue-600 text-white rounded-lg text-sm hover:bg-blue-700"
              >
                {tokenCopied ? "已复制 ✓" : "复制 token"}
              </button>
              <button
                type="button"
                onClick={closeTokenModal}
                className="px-4 py-2 border border-gray-300 text-gray-700 rounded-lg text-sm hover:bg-gray-50"
              >
                关闭 (token 不再可见)
              </button>
            </div>
          </div>
        </div>
      )}

      <ConfirmDialog
        open={!!deleteTarget}
        title={`删除 runner「${deleteTarget?.name ?? ""}」`}
        message={`确定要删除吗？同时会撤销它的 token, 已配置的 daemon 下次心跳会 401。host:port (${runners.find((r) => r.id === deleteTarget?.id)?.host}:${runners.find((r) => r.id === deleteTarget?.id)?.port}) 之后可以重新注册。`}
        confirmLabel="删除"
        variant="danger"
        onConfirm={handleDelete}
        onCancel={() => setDeleteTarget(null)}
      />

      {/* 健康检查 loading 遮罩 (避免连点) */}
      {healthLoadingId && (
        <div className="fixed inset-0 z-50 flex items-center justify-center pointer-events-none">
          <div className="bg-white/80 backdrop-blur-sm rounded-lg px-4 py-2 text-sm text-gray-600 shadow">
            正在调用 /v1/health …
          </div>
        </div>
      )}
    </div>
  );
}
