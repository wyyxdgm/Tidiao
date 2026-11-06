// 🆕 R143 五轮 (damo 2026-09-15) 端口化 — SPA 输入框加 /goal / /loop slash command.
//   原实现只在 Next.js task-detail-client.tsx, SPA 整合后用户看不见 → 整段重
//   写为 Vue/TS 风格, 逻辑与 src/lib/chat/slash-command.ts 1:1 对齐.
//
//   设计点:
//   - 解析在 SPA 纯函数里, 无 DB / 无网络; 与 Next 共用语义独立, 但实现不复用
//     (跨仓共享会让 Nuxt-style 依赖倒置, Vue/TS 当前路径不接 Vitest). 后续
//     SPA vitest 落地后可考虑提到顶层 lib.
//   - 解析失败 → caller (TaskMessageInput.vue:send) 决定怎么显示错误.
//
//   关注点:
//   - 此文件是 SPA slash command 唯一解析点, 加新 slash 命令改这里 + 改 caller.
//   - /goal <prompt> → caller 用 buildGoalPrompt 拼 <goal>...</goal> 后 POST
//     /api/tasks, autoApprove=true 与 Next 一致.
//   - /loop [interval] <prompt> → caller 创建 cron schedule (agent 类型,
//     schedule_type=cron). project_id/version_id 从当前 task 复用.
//
//   同步线: 改此文件同时改 src/lib/chat/slash-command.ts + slash-command.test.ts
//   (caller 行为变更); 改语义两边都改, 否则 drift.

export type SlashCommand =
  | { kind: 'goal'; prompt: string }
  | { kind: 'loop'; interval: string; prompt: string; cronExpr: string }
  | { kind: 'clearhistory' }
  | { kind: 'none' };

// 功能: 把 chat 输入文本解析为 slash command. 不以 "/" 开头或格式错 → none
//   (caller 走普通消息路径).
// 关注点: 大小写不敏感 (/GOAL /goal 同义); 前导空白忽略.
export function parseSlashCommand(raw: string): SlashCommand {
  const text = (raw ?? '').trim();
  if (!text.startsWith('/')) return { kind: 'none' };

  // /goal <prompt> — prompt 可为空 (caller 报「请输入目标」)
  if (/^\/goal\b/i.test(text)) {
    const prompt = text.replace(/^\/goal\b\s*/i, '').trim();
    return { kind: 'goal', prompt };
  }

  // /clearhistory — R179: 清除本 task 输入历史 + 草稿. 纯前端动作不上
  // 服务器; 尾随文本忽略. caller (TaskMessageInput.vue) 只在 SPA 端有行为,
  // Next 端解析出该 kind 后无人消费 → 当普通消息发 (历史壳, 用户不可见).
  if (/^\/clearhistory\b/i.test(text)) {
    return { kind: 'clearhistory' };
  }

  // /loop [interval] <prompt> — interval 必填, prompt 可为空
  const loopMatch = text.match(/^\/loop\s+(\S+)\s*([\s\S]*)$/i);
  if (loopMatch) {
    const interval = loopMatch[1];
    const prompt = (loopMatch[2] ?? '').trim();
    const cronExpr = intervalToCron(interval);
    if (!cronExpr) {
      // 格式错 → 走 none 让 caller 提示「无法识别的 interval」
      return { kind: 'none' };
    }
    return { kind: 'loop', interval, prompt, cronExpr };
  }

  // 未知 slash 命令 → 不拦截, 走 none 让原文本当普通消息发
  // (避免误吞 /xxx 当 slash command, 用户体验更宽容).
  return { kind: 'none' };
}

// 功能: 简写 interval 转 cron 表达式. 支持 Nm (分钟) / Nh (小时) / Nd (天).
//   不支持的格式 (如纯数字 / 复杂 cron 字面 / "1w") → 返回 null, caller 报错.
//   "*/30 * * * *" 每 30 分钟; "0 */2 * * *" 每 2 小时 (整点); "0 9 * * *"
//   每天 9 点 (Nd 简化为每天该时刻的首次).
export function intervalToCron(raw: string): string | null {
  const s = (raw ?? '').trim();
  const m = s.match(/^(\d+)\s*([mhd])$/i);
  if (!m) return null;
  const n = parseInt(m[1], 10);
  const unit = m[2].toLowerCase();
  if (!Number.isFinite(n) || n <= 0) return null;
  if (unit === 'm') {
    if (n < 1 || n > 59) return null;
    return `*/${n} * * * *`;
  }
  if (unit === 'h') {
    if (n < 1 || n > 23) return null;
    return `0 */${n} * * *`;
  }
  if (unit === 'd') {
    if (n !== 1) return null; // 多天 cron 表达式歧义大, v1 只支持 1d
    return `0 9 * * *`;
  }
  return null;
}