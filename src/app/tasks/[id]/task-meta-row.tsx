// 功能: 渲染任务元信息行（模型/强度/最大轮次/创建/上下文/超时剩余），不含状态。
// 关注点: 上下文配色阈值（>=85 红 / >=60 橙），与 TaskHeader 原内联逻辑一致。
//   超时剩余配色阈值 (<1min 红 / <5min 橙), 由调用方传 timeoutRemainingMs + timeoutTotalMs.
import { parseDbTime } from "@/lib/datetime";

function formatCreatedAt(iso: string): string {
  const d = parseDbTime(iso);
  if (!d) return "";
  const Y = d.getFullYear();
  const M = (d.getMonth() + 1).toString().padStart(2, "0");
  const D = d.getDate().toString().padStart(2, "0");
  const h = d.getHours().toString().padStart(2, "0");
  const m = d.getMinutes().toString().padStart(2, "0");
  return `${Y}-${M}-${D} ${h}:${m}`;
}

// 功能: 把剩余毫秒拼成 H:MM:SS 或 MM:SS. 小时位 0 时省掉.
function formatRemaining(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n: number) => n.toString().padStart(2, "0");
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
}

export default function TaskMetaRow({
  model,
  effort,
  maxTurns,
  createdAt,
  contextTokens,
  contextMax,
  cost,
  timeoutRemainingMs,
  timeoutTotalMs,
}: {
  model?: string | null;
  effort?: string | null;
  maxTurns?: number | null;
  createdAt?: string;
  contextTokens?: number | null;
  contextMax?: number | null;
  cost?: number | null;
  timeoutRemainingMs?: number | null;
  timeoutTotalMs?: number | null;
}) {
  return (
    <div className="flex gap-4 text-sm text-gray-600 flex-wrap">
      <span>模型: <strong className="text-gray-900">{model || "默认"}</strong></span>
      {effort && <span>强度: {effort}</span>}
      {maxTurns && <span>最大轮次: {maxTurns}</span>}
      {createdAt && (
        <span>创建: <strong className="text-gray-900">{formatCreatedAt(createdAt)}</strong></span>
      )}
      {contextTokens != null && contextTokens > 0 && (() => {
        const pct = contextMax ? Math.round((contextTokens / contextMax) * 100) : null;
        const fmt = (n: number) => n >= 1000 ? `${(n / 1000).toFixed(0)}k` : `${n}`;
        const color = pct == null ? "text-gray-600" : pct >= 85 ? "text-red-600" : pct >= 60 ? "text-orange-600" : "text-gray-600";
        return (
          <span className={color} title="任务停止时的上下文占用（据此判断是否需要 fork/压缩后继续）">
            上下文: {fmt(contextTokens)}{contextMax ? ` / ${fmt(contextMax)}` : ""}{pct != null ? ` (${pct}%)` : ""}
          </span>
        );
      })()}
      {timeoutRemainingMs != null && (() => {
        // <1min 红 / <5min 橙 / 其它灰. tooltip 显示总时长 (分钟) 便于对照.
        const color = timeoutRemainingMs < 60_000
          ? "text-red-600"
          : timeoutRemainingMs < 5 * 60_000
          ? "text-orange-600"
          : "text-gray-600";
        const total = timeoutTotalMs ? `${Math.round(timeoutTotalMs / 60_000)} 分钟` : undefined;
        return (
          <span className={color} title={total ? `总超时 ${total}（剩余时间到点会暂停任务）` : "剩余时间到点会暂停任务"}>
            剩余: {formatRemaining(timeoutRemainingMs)}
          </span>
        );
      })()}
      {cost != null && cost > 0 && (
        <span>💰 ${cost.toFixed(3)}</span>
      )}
    </div>
  );
}
