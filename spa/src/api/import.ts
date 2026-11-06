// Import 视图 API + 客户端预览解析器. 对应 master src/lib/import/parsers.ts +
// src/app/api/import/{json,csv,markdown}/route.ts 三条 POST.
//
// 功能:
//  - 类型 + 3 Parse 器 (客户端预览解析, 与 Next 同口径, 见 docs/usage/08-import-sync.md).
//  - 3 个 POST 入口 (走 /api/import/{json|csv|markdown}, 后端硬复刻 master 解析路径).
//
// 关注点:
//  - 客户端解析器为「预览」服务 — 提交时后端会再跑一遍 parsers.ts 并强校验 ownership.
//    前端预览可让用户在不调用接口的情况下看到解析结果 (含错误行提示).
//  - Parser 实现 1:1 移植 master TypeScript 实现, 不做简化 — Next 端用户依赖的行为
//    (CSV 双引号转义、Markdown 两种模式自动 fallback) 必须保留.
//  - ImportedTaskDefinition 字段集对齐 master `Omit<TaskDefinition, "project_id"|"version_id">`;
//    后端最终把它 project_id/version_id 补齐后 createTask. 故提交 body 仅需 content + 两
//    个 location 字段.
//  - POST 走 http.ts 的 post() helper (自动 401 refresh + JSON header), 与 Schedules /
//    Webhooks 同款.

import { post } from './http';

/* ------------------------------------------------------------------ */
/*  类型 (客户端预览共享)                                              */
/* ------------------------------------------------------------------ */

/** 与 master ImportedTaskDefinition 1:1 (Omit<TaskDefinition, project_id|version_id>).
    客户端预览显示这些字段; 后端 createTask 时再补 project_id/version_id. */
export interface ImportedTaskDefinition {
  title: string;
  prompt: string;
  description?: string;
  priority?: number;
  cwd?: string;
  auto_approve?: boolean;
  model?: string;
  allowedTools?: string[];
  maxTurns?: number;
  effort?: string;
  tags?: string[];
}

/** 解析结果 — tasks 是有效项, errors 是行/项级错误 (用户可见的提示). */
export interface ImportParseResult {
  tasks: ImportedTaskDefinition[];
  errors: string[];
}

/** 三种格式 — 与 sheet R31 字面要求 + Next page.tsx 1:1. */
export type ImportFormat = 'json' | 'csv' | 'markdown';

/** 提交到后端的 body — POST /api/import/{format} 入参. */
export interface ImportRequestBody {
  content: string;
  project_id: string;
  version_id?: string;
}

/** 后端响应 — 与 master json/csv/markdown route 同款 (imported + task_ids + 可选 errors). */
export interface ImportResponse {
  imported: number;
  task_ids?: string[];
  errors?: string[];
}

/* ------------------------------------------------------------------ */
/*  JSON 解析器                                                        */
/* ------------------------------------------------------------------ */

/** JSON: 期望 [{title, prompt, ...}, ...] 数组; 缺必填字段 → errors 累积 + skip. */
export function parseJsonImport(content: string): ImportParseResult {
  const errors: string[] = [];
  let parsed: unknown;

  try {
    parsed = JSON.parse(content);
  } catch (e) {
    return { tasks: [], errors: [`Invalid JSON: ${(e as Error).message}`] };
  }

  if (!Array.isArray(parsed)) {
    return { tasks: [], errors: ['JSON must be an array of task objects'] };
  }

  const tasks: ImportedTaskDefinition[] = [];
  for (let i = 0; i < parsed.length; i++) {
    const item = parsed[i] as Record<string, unknown>;
    if (!item.title || !item.prompt) {
      errors.push(`Item ${i + 1}: missing required 'title' or 'prompt'`);
      continue;
    }
    tasks.push({
      title: String(item.title),
      prompt: String(item.prompt),
      description: item.description ? String(item.description) : undefined,
      priority: item.priority ? Number(item.priority) : undefined,
      cwd: item.cwd ? String(item.cwd) : undefined,
      auto_approve: item.auto_approve === true || item.autoApprove === true,
      model: item.model ? String(item.model) : undefined,
      allowedTools: Array.isArray(item.allowedTools)
        ? (item.allowedTools as string[])
        : undefined,
      maxTurns: item.maxTurns ? Number(item.maxTurns) : undefined,
      effort: (item.effort as string) || undefined,
      tags: Array.isArray(item.tags) ? (item.tags as string[]) : undefined,
    });
  }

  return { tasks, errors };
}

/* ------------------------------------------------------------------ */
/*  CSV 解析器                                                         */
/* ------------------------------------------------------------------ */

/** 简单 CSV 行解析器 (处理双引号包裹的字段 + "" 转义). 与 master parseCsvLine 1:1. */
function parseCsvLine(line: string): string[] {
  const result: string[] = [];
  let current = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (i + 1 < line.length && line[i + 1] === '"') {
          current += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        current += ch;
      }
    } else {
      if (ch === '"') {
        inQuotes = true;
      } else if (ch === ',') {
        result.push(current);
        current = '';
      } else {
        current += ch;
      }
    }
  }
  result.push(current);
  return result;
}

/** CSV: 第一行表头必须含 title 和 prompt; tags 用分号分隔. */
export function parseCsvImport(content: string): ImportParseResult {
  const errors: string[] = [];
  const lines = content.trim().split('\n');

  if (lines.length < 2) {
    return {
      tasks: [],
      errors: ['CSV must have a header row and at least one data row'],
    };
  }

  const headers = parseCsvLine(lines[0]).map((h) => h.trim().toLowerCase());
  const titleIdx = headers.indexOf('title');
  const promptIdx = headers.indexOf('prompt');

  if (titleIdx === -1 || promptIdx === -1) {
    return { tasks: [], errors: ["CSV must have 'title' and 'prompt' columns"] };
  }

  const descIdx = headers.indexOf('description');
  const priorityIdx = headers.indexOf('priority');
  const cwdIdx = headers.indexOf('cwd');
  const tagsIdx = headers.indexOf('tags');
  const modelIdx = headers.indexOf('model');

  const tasks: ImportedTaskDefinition[] = [];
  for (let i = 1; i < lines.length; i++) {
    if (!lines[i].trim()) continue;

    const cols = parseCsvLine(lines[i]);
    const title = cols[titleIdx]?.trim();
    const prompt = cols[promptIdx]?.trim();

    if (!title || !prompt) {
      errors.push(`Row ${i + 1}: missing title or prompt`);
      continue;
    }

    tasks.push({
      title,
      prompt,
      description: descIdx >= 0 ? cols[descIdx]?.trim() : undefined,
      priority:
        priorityIdx >= 0 && cols[priorityIdx] ? Number(cols[priorityIdx]) : undefined,
      cwd: cwdIdx >= 0 ? cols[cwdIdx]?.trim() : undefined,
      model: modelIdx >= 0 ? cols[modelIdx]?.trim() : undefined,
      tags:
        tagsIdx >= 0 && cols[tagsIdx]
          ? cols[tagsIdx]
              .split(';')
              .map((t) => t.trim())
              .filter(Boolean)
          : undefined,
    });
  }

  return { tasks, errors };
}

/* ------------------------------------------------------------------ */
/*  Markdown 解析器                                                    */
/* ------------------------------------------------------------------ */

/** Markdown: 复选框 (- [ ] Title) 优先; 缺则退化到 ## Title 段. */
export function parseMarkdownImport(content: string): ImportParseResult {
  const errors: string[] = [];
  const tasks: ImportedTaskDefinition[] = [];

  const checkboxPattern = /^[-*]\s*\[[ x]\]\s*(.+)$/gm;
  const headingPattern = /^(#{1,3})\s+(.+)$/gm;

  let match: RegExpExecArray | null;

  // 尝试复选框模式.
  const checkboxTasks: Array<{ title: string; prompt: string }> = [];
  while ((match = checkboxPattern.exec(content)) !== null) {
    checkboxTasks.push({ title: match[1].trim(), prompt: match[1].trim() });
  }

  if (checkboxTasks.length > 0) {
    const lines = content.split('\n');
    let currentTask: { title: string; prompt: string } | null = null;
    let promptLines: string[] = [];

    for (const line of lines) {
      const cbMatch = line.match(/^[-*]\s*\[[ x]\]\s*(.+)$/);
      if (cbMatch) {
        if (currentTask) {
          currentTask.prompt =
            promptLines.length > 0
              ? currentTask.prompt + '\n' + promptLines.join('\n')
              : currentTask.prompt;
          tasks.push(currentTask);
        }
        currentTask = { title: cbMatch[1].trim(), prompt: cbMatch[1].trim() };
        promptLines = [];
      } else if (currentTask && line.trim()) {
        const detailMatch = line.match(/^\s*:\s*(.+)$/);
        if (detailMatch) {
          promptLines.push(detailMatch[1]);
        } else if (line.trim().startsWith('>')) {
          promptLines.push(line.trim().replace(/^>\s*/, ''));
        }
      }
    }
    if (currentTask) {
      currentTask.prompt =
        promptLines.length > 0
          ? currentTask.prompt + '\n' + promptLines.join('\n')
          : currentTask.prompt;
      tasks.push(currentTask);
    }
  } else {
    // 退化到标题模式.
    const sections: Array<{ title: string; content: string[] }> = [];
    let current: { title: string; content: string[] } | null = null;

    for (const line of content.split('\n')) {
      const hMatch = line.match(/^(#{1,3})\s+(.+)$/);
      if (hMatch) {
        if (current) sections.push(current);
        current = { title: hMatch[2].trim(), content: [] };
      } else if (current && line.trim()) {
        current.content.push(line.trim());
      }
    }
    if (current) sections.push(current);

    for (const section of sections) {
      tasks.push({
        title: section.title,
        prompt:
          section.content.length > 0 ? section.content.join('\n') : section.title,
      });
    }
  }

  if (tasks.length === 0) {
    errors.push("No tasks found. Use '- [ ] Title' format or '## Title' headings.");
  }

  return { tasks, errors };
}

/* ------------------------------------------------------------------ */
/*  调度 (POST /api/import/{format})                                   */
/* ------------------------------------------------------------------ */

/** 三种格式的 path 段 — 与 master json/csv/markdown route 1:1. */
const FORMAT_PATH: Record<ImportFormat, string> = {
  json: '/api/import/json',
  csv: '/api/import/csv',
  markdown: '/api/import/markdown',
};

/** 通用导入 — content + project_id 必填, version_id 选填. 后端 404 当 project 不存在/无权限. */
export async function importTasks(
  format: ImportFormat,
  body: ImportRequestBody,
): Promise<ImportResponse> {
  return post<ImportResponse>(FORMAT_PATH[format], body);
}