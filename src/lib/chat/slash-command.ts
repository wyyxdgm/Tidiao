// 🆕 R143 五轮 (damo 2026-09-15): 聊天输入框支持 slash command. 对标 Claude Code
//   CLI 的 /loop + /goal, 复用已有 goal-loop / cron 基础设施, 不造新协议.
//
//   设计点:
//   - 解析在前端纯函数里, 单元测覆盖; 不读 DB / 不发请求.
//   - 解析失败 (空 prompt / 格式错) → caller 决定怎么显示错误 (toast / inline).
//   - interval 解析支持 Nx 简写 (30m / 2h / 1d), 转成 cron expr. 复杂格式 (cron
//     字面 / 一次性) v1 不支持, v2 看用户反馈再扩.
//
//   关注点:
//   - 此文件是 chat slash command 唯一解析点, 加新 slash 命令改这里 + 改 caller.
//     caller (task-detail-client.tsx:handleSendMessage) 分发到 POST /api/tasks 或
//     POST /api/schedules, 不直接走 SDK.
//   - /goal <prompt> 包装后 POST /api/tasks, prompt = `<goal>${prompt}</goal>`.
//     API 端 checkGoalMarkerAutoApprove 仍要求 autoApprove=true (默认), 与
//     /tasks/new UI 行为一致.
//   - /loop [interval] <prompt> 创建 cron schedule, exec_type=agent, schedule_type=cron.
//     project_id / version_id 复用当前 task 的归属 (chat input 绑在某个 task 上).

export type SlashCommand =
  | { kind: "goal"; prompt: string }
  | { kind: "loop"; interval: string; prompt: string; cronExpr: string }
  | { kind: "clearhistory" }
  | { kind: "none" };

// 功能: 把 chat 输入文本解析为 slash command. 不以 "/" 开头或格式错 → none
//   (caller 走普通消息路径).
// 关注点: 大小写不敏感 (/GOAL /goal 同义); 前导空白忽略.
export function parseSlashCommand(raw: string): SlashCommand {
  const text = (raw ?? "").trim();
  if (!text.startsWith("/")) return { kind: "none" };

  // /goal <prompt> — prompt 可为空 (caller 报「请输入目标」)
  if (/^\/goal\b/i.test(text)) {
    const prompt = text.replace(/^\/goal\b\s*/i, "").trim();
    return { kind: "goal", prompt };
  }

  // /clearhistory — R179: 清除本 task 输入历史 + 草稿 (SPA 前端动作). Next
  // 端 caller 不消费该 kind → 落到普通消息路径 (历史壳用户不可见, 行为无害).
  if (/^\/clearhistory\b/i.test(text)) {
    return { kind: "clearhistory" };
  }

  // /loop [interval] <prompt> — interval 必填, prompt 可为空
  const loopMatch = text.match(/^\/loop\s+(\S+)\s*([\s\S]*)$/i);
  if (loopMatch) {
    const interval = loopMatch[1];
    const prompt = (loopMatch[2] ?? "").trim();
    const cronExpr = intervalToCron(interval);
    if (!cronExpr) {
      // 格式错 → 走 none 让 caller 提示「无法识别的 interval」
      return { kind: "none" };
    }
    return { kind: "loop", interval, prompt, cronExpr };
  }

  // 未知 slash 命令 → 不拦截, 走 none 让原文本当普通消息发
  // (避免误吞 /xxx 当 slash command, 用户体验更宽容).
  return { kind: "none" };
}

// 功能: 简写 interval 转 cron 表达式. 支持 Nm (分钟) / Nh (小时) / Nd (天).
//   不支持的格式 (如纯数字 / 复杂 cron 字面 / "1w") → 返回 null, caller 报错.
//   "*/30 * * * *" 每 30 分钟; "0 */2 * * *" 每 2 小时 (整点); "0 9 * * *"
//   每天 9 点 (Nd 简化为每天该时刻的首次).
export function intervalToCron(raw: string): string | null {
  const s = (raw ?? "").trim();
  const m = s.match(/^(\d+)\s*([mhd])$/i);
  if (!m) return null;
  const n = parseInt(m[1], 10);
  const unit = m[2].toLowerCase();
  if (!Number.isFinite(n) || n <= 0) return null;
  if (unit === "m") {
    if (n < 1 || n > 59) return null;
    return `*/${n} * * * *`;
  }
  if (unit === "h") {
    if (n < 1 || n > 23) return null;
    return `0 */${n} * * *`;
  }
  if (unit === "d") {
    if (n !== 1) return null; // 多天 cron 表达式歧义大, v1 只支持 1d
    return `0 9 * * *`;
  }
  return null;
}
