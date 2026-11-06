// Batch import: parse various formats into TaskDefinition arrays

import type { TaskDefinition } from "../runtime/types";

export type ImportedTaskDefinition = Omit<TaskDefinition, "project_id" | "version_id">;

export interface ImportResult {
  tasks: ImportedTaskDefinition[];
  errors: string[];
}

// ---- JSON Import ----
// Expects an array of objects with at least { title, prompt }
export function parseJsonImport(content: string): ImportResult {
  const errors: string[] = [];
  let parsed: unknown;

  try {
    parsed = JSON.parse(content);
  } catch (e) {
    return { tasks: [], errors: ["Invalid JSON: " + (e as Error).message] };
  }

  if (!Array.isArray(parsed)) {
    return { tasks: [], errors: ["JSON must be an array of task objects"] };
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
      allowedTools: Array.isArray(item.allowedTools) ? item.allowedTools as string[] : undefined,
      maxTurns: item.maxTurns ? Number(item.maxTurns) : undefined,
      effort: item.effort as any || undefined,
      tags: Array.isArray(item.tags) ? item.tags as string[] : undefined,
    });
  }

  return { tasks, errors };
}

// ---- CSV Import ----
// Expects header row with at least title,prompt columns
export function parseCsvImport(content: string): ImportResult {
  const errors: string[] = [];
  const lines = content.trim().split("\n");

  if (lines.length < 2) {
    return { tasks: [], errors: ["CSV must have a header row and at least one data row"] };
  }

  // Parse header
  const headers = parseCsvLine(lines[0]).map((h) => h.trim().toLowerCase());
  const titleIdx = headers.indexOf("title");
  const promptIdx = headers.indexOf("prompt");

  if (titleIdx === -1 || promptIdx === -1) {
    return { tasks: [], errors: ["CSV must have 'title' and 'prompt' columns"] };
  }

  const descIdx = headers.indexOf("description");
  const priorityIdx = headers.indexOf("priority");
  const cwdIdx = headers.indexOf("cwd");
  const tagsIdx = headers.indexOf("tags");
  const modelIdx = headers.indexOf("model");

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
      priority: priorityIdx >= 0 && cols[priorityIdx] ? Number(cols[priorityIdx]) : undefined,
      cwd: cwdIdx >= 0 ? cols[cwdIdx]?.trim() : undefined,
      model: modelIdx >= 0 ? cols[modelIdx]?.trim() : undefined,
      tags: tagsIdx >= 0 && cols[tagsIdx] ? cols[tagsIdx].split(";").map((t) => t.trim()).filter(Boolean) : undefined,
    });
  }

  return { tasks, errors };
}

// Simple CSV line parser (handles quoted fields)
function parseCsvLine(line: string): string[] {
  const result: string[] = [];
  let current = "";
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
      } else if (ch === ",") {
        result.push(current);
        current = "";
      } else {
        current += ch;
      }
    }
  }
  result.push(current);
  return result;
}

// ---- Markdown Import ----
// Parses task lists: - [ ] Title or ## Title patterns
// Prompt is extracted from text after the title until the next task heading
export function parseMarkdownImport(content: string): ImportResult {
  const errors: string[] = [];
  const tasks: ImportedTaskDefinition[] = [];

  // Pattern 1: - [ ] Title (checkbox list)
  const checkboxPattern = /^[-*]\s*\[[ x]\]\s*(.+)$/gm;
  // Pattern 2: ## Title (heading sections)
  const headingPattern = /^(#{1,3})\s+(.+)$/gm;

  let match: RegExpExecArray | null;

  // Try checkbox pattern first
  const checkboxTasks: Array<{ title: string; prompt: string }> = [];
  while ((match = checkboxPattern.exec(content)) !== null) {
    checkboxTasks.push({ title: match[1].trim(), prompt: match[1].trim() });
  }

  if (checkboxTasks.length > 0) {
    // Try to extract prompt from text between checkboxes
    const lines = content.split("\n");
    let currentTask: { title: string; prompt: string } | null = null;
    let promptLines: string[] = [];

    for (const line of lines) {
      const cbMatch = line.match(/^[-*]\s*\[[ x]\]\s*(.+)$/);
      if (cbMatch) {
        if (currentTask) {
          currentTask.prompt = promptLines.length > 0
            ? currentTask.prompt + "\n" + promptLines.join("\n")
            : currentTask.prompt;
          tasks.push(currentTask);
        }
        currentTask = { title: cbMatch[1].trim(), prompt: cbMatch[1].trim() };
        promptLines = [];
      } else if (currentTask && line.trim()) {
        // Text after checkbox might contain the detailed prompt
        const detailMatch = line.match(/^\s*:\s*(.+)$/);
        if (detailMatch) {
          promptLines.push(detailMatch[1]);
        } else if (line.trim().startsWith(">")) {
          promptLines.push(line.trim().replace(/^>\s*/, ""));
        }
      }
    }
    if (currentTask) {
      currentTask.prompt = promptLines.length > 0
        ? currentTask.prompt + "\n" + promptLines.join("\n")
        : currentTask.prompt;
      tasks.push(currentTask);
    }
  } else {
    // Try heading pattern
    const sections: Array<{ title: string; content: string[] }> = [];
    let current: { title: string; content: string[] } | null = null;

    for (const line of content.split("\n")) {
      const hMatch = line.match(/^(#{1,3})\s+(.+)$/);
      if (hMatch) {
        if (current) {
          sections.push(current);
        }
        current = { title: hMatch[2].trim(), content: [] };
      } else if (current && line.trim()) {
        current.content.push(line.trim());
      }
    }
    if (current) {
      sections.push(current);
    }

    for (const section of sections) {
      tasks.push({
        title: section.title,
        prompt: section.content.length > 0
          ? section.content.join("\n")
          : section.title,
      });
    }
  }

  if (tasks.length === 0) {
    errors.push("No tasks found. Use '- [ ] Title' format or '## Title' headings.");
  }

  return { tasks, errors };
}
