// 需求点状态进程条 (R78 W3 §4.1 (1)).
//
// 功能: 把 6 态画成 stepper, 让详情页一眼看到"现在到哪一步 + 还能往哪走".
//   pending → has_suggestion ↔ awaiting_reply ↔ blocked → done
//   closed 走单独"已关闭"分支, 不进主流程.
//
// 关注点:
//   - server component, 纯渲染 (没交互; 切换状态走现有的 status-flow.tsx dropdown).
//   - 配色沿用 status-flow.tsx 的 STATUS_COLOR, 不重设计.
//   - 阶段连接线按主流程链渲染, 当前态高亮; 中间态不互斥 ("has_suggestion" 和
//     "awaiting_reply" 都用蓝色环表示"在等 damo 拍板"的活跃中间态).
//   - closed 单独一行, 不与 done 共线.

import type { RequirementStatus } from "@/lib/db/requirements";

const STATUS_LABEL: Record<RequirementStatus, string> = {
  pending: "未开始",
  done: "已完成",
  awaiting_reply: "等回复",
  has_suggestion: "有建议",
  blocked: "需拍板",
  closed: "已关闭",
};

// 主流程顺序 (pending → done) + 中间态环 (has_suggestion/awaiting_reply/blocked)
// 都是"中间活跃态", 都用蓝/紫/橙区分, 但 stepper 主轴只走 pending → done.
const MAIN_FLOW: RequirementStatus[] = ["pending", "done"];
const INTERMEDIATE: RequirementStatus[] = [
  "has_suggestion",
  "awaiting_reply",
  "blocked",
];
// 中间态专用配色 (pending/done/closed 在主流程轴上, 不会被这里使用; 给空字符串占位即可).
const INTERMEDIATE_COLOR: Record<RequirementStatus, string> = {
  pending: "",
  done: "",
  closed: "",
  has_suggestion: "bg-purple-100 text-purple-700 border-purple-300",
  awaiting_reply: "bg-blue-100 text-blue-700 border-blue-300",
  blocked: "bg-orange-100 text-orange-700 border-orange-300",
};

export default function StatusStepper({
  current,
}: {
  current: RequirementStatus;
}) {
  // closed 单独显示, 不参与主流程.
  if (current === "closed") {
    return (
      <div className="bg-white rounded-lg shadow p-4 mb-6">
        <div className="flex items-center gap-2 text-sm">
          <span className="inline-block w-2.5 h-2.5 rounded-full bg-gray-400" />
          <span className="text-gray-500 font-medium">已关闭</span>
          <span className="text-xs text-gray-400 ml-2">软删, 后续可改回其他状态</span>
        </div>
      </div>
    );
  }

  const currentIdx = MAIN_FLOW.indexOf(current);
  const isIntermediate = INTERMEDIATE.includes(current);

  return (
    <div className="bg-white rounded-lg shadow p-4 mb-6">
      <div className="flex items-center gap-3 flex-wrap">
        {MAIN_FLOW.map((s, i) => {
          const reached = currentIdx >= i;
          const isCurrent = current === s;
          return (
            <div key={s} className="flex items-center gap-3">
              <div className="flex items-center gap-2">
                <span
                  className={`inline-flex items-center justify-center w-7 h-7 rounded-full text-xs font-semibold border-2 ${
                    isCurrent
                      ? "bg-blue-600 text-white border-blue-600"
                      : reached
                        ? "bg-blue-50 text-blue-700 border-blue-300"
                        : "bg-gray-50 text-gray-400 border-gray-200"
                  }`}
                >
                  {reached ? "✓" : i + 1}
                </span>
                <span
                  className={`text-sm ${
                    isCurrent
                      ? "font-semibold text-gray-900"
                      : reached
                        ? "text-gray-700"
                        : "text-gray-400"
                  }`}
                >
                  {STATUS_LABEL[s]}
                </span>
              </div>
              {i < MAIN_FLOW.length - 1 && (
                <span
                  className={`h-0.5 w-8 ${
                    reached ? "bg-blue-300" : "bg-gray-200"
                  }`}
                />
              )}
            </div>
          );
        })}
        {isIntermediate && (
          <div className="flex items-center gap-2 ml-2 pl-3 border-l border-gray-200">
            <span className="text-xs text-gray-400">当前:</span>
            <span
              className={`text-xs px-2 py-0.5 rounded-full border ${
                INTERMEDIATE_COLOR[current]
              }`}
            >
              {STATUS_LABEL[current]}
            </span>
          </div>
        )}
      </div>
    </div>
  );
}
