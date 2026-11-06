<script setup lang="ts">
/* 功能: Import 批量导入视图 — 对应 Next src/app/import/page.tsx, R31 字面要求 =
   JSON / CSV / Markdown 三种格式入口; 上传 + 预览 + 确认. 视图范围按 sheet 红线
   只动本文件 + 必要 glue (api/import.ts + router + ProjectSidebar).

   关注点 (sheet R31 + 与现实分歧):
   - sheet 字面 "三种格式入口; 上传 + 预览 + 确认" 对齐 Next 端 page.tsx:
     (1) 项目 + 版本下拉 (版本可选, 选 = 把任务绑到该 version, 不选 = 项目级「其他任务」,
        走 createTask project_id+version_id undefined, 与 master route validateTaskLocation
        同款); (2) 格式 tab 切换; (3) 格式说明 + 内容 textarea; (4) 预览解析按钮 → 走
        客户端 parser (parseJsonImport / parseCsvImport / parseMarkdownImport, 与 master
        parsers.ts 1:1); (5) 预览卡片列表; (6) 确认导入按钮 → POST /api/import/{format}.
   - parser 实现 1:1 移植 master src/lib/import/parsers.ts (内联在 api/import.ts),
     客户端预览 = 仅看解析结果, 实际创建任务由后端 parsers.ts 二次校验 — 这是 Next
     端页面的同款设计 (源文件名 page.tsx 注释也指出 "Preview parsed tasks without
     actually importing"). 客户端解析只为了「不调接口就能看到解析结果 + 错误行提示」.
   - 与 Next 端 3 处差异:
     (1) sheet 字面 "API: POST /api/import/{json,csv,markdown}", master route 实际接受
         {content, project_id, version_id} body, 与 Next page.tsx 同款, 走 importTasks()
        一处抽象 (format 参数派 path); (2) sheet 没显式要求展示后端返回的 task_ids, 但
        master json/csv/markdown route 都返回 imported + task_ids + 可选 errors, 提示
        「成功导入 N 个任务」够用, task_ids 仅作为可点击跳详情 (R+ 范畴); (3) sheet
        没显式要求处理后端 404 (project 不存在或非 owner), 但 master route 会返回
        404 + code: PROJECT_NOT_FOUND, 落到 isHttpError(e).status === 404 → 显示
        "项目不存在或无权限", 让用户切回正确的 project 下拉 (与 Next 端无 404 特殊
        处理略有差异, 但后端路径已经清晰, 加上更友好).
   - 状态机三态: loading (拉 projects 列表), error (拉失败), empty (没项目), normal.
     projects 拉取用 onMounted 一次性, 与 Next useEffect 同款. 版本下拉由 projectId
     变化触发 watch (Vue 风格替代 useEffect).
   - 复用 Layer 0: R7 Button (variant=primary/secondary, loading 自动带 spinner) +
     R8 Textarea (v-model + autosize, 这里用 rows=14 + CSS 锁定 min-height 256px
     模拟 Next 端 h-64 固定高度; font-family 走 class-name deep 覆盖 mono) +
     R9 Select (项目 + 版本下拉) + useToast (成功后绿色提示, 失败红色). 不引 R13
     Empty / ErrorView — 该视图本身不是「数据列表」而是「操作面板」, 没有数据卡片
     状态机.
   - 预览卡片含 `prompt` (完整字段) + tags (行首和 Next 同款 chip). */
import { computed, onMounted, onUnmounted, ref, watch } from 'vue';
import {
  parseJsonImport,
  parseCsvImport,
  parseMarkdownImport,
  importTasks,
  type ImportFormat,
  type ImportParseResult,
  type ImportedTaskDefinition,
} from '@/api/import';
import { listProjects, listVersions, type Project, type Version } from '@/api/projects';
import { getCliImportState, startCliImport, type CliImportState } from '@/api/cli-import';
import { isHttpError } from '@/api/http';
import { useToast } from '@/composables/useToast';
import Button from '@/components/Button.vue';
import Select from '@/components/Select.vue';
import Textarea from '@/components/Textarea.vue';

/* ------------------------------------------------------------------ */
/*  常量                                                                */
/* ------------------------------------------------------------------ */

/** 与 Next page.tsx FORMAT_HELP 1:1. */
const FORMAT_HELP: Record<ImportFormat, string> = {
  json: '[{"title": "任务标题", "prompt": "详细指令", "description": "可选描述", "tags": ["tag1"]}]',
  csv: 'title,prompt,description,tags\n任务标题,详细指令,可选描述,tag1;tag2',
  markdown: '- [ ] 任务标题\n  : 详细指令（可选）\n- [ ] 另一个任务',
};

const FORMAT_OPTIONS: { value: ImportFormat; label: string }[] = [
  { value: 'json', label: 'JSON' },
  { value: 'csv', label: 'CSV' },
  { value: 'markdown', label: 'Markdown' },
];

/* ------------------------------------------------------------------ */
/*  状态                                                                */
/* ------------------------------------------------------------------ */

const toast = useToast();

const projects = ref<Project[]>([]);
const versions = ref<Version[]>([]);
const projectsLoading = ref<boolean>(true);
const projectsError = ref<string | null>(null);

const format = ref<ImportFormat>('json');
const projectId = ref<string>('');
const versionId = ref<string>('');
const content = ref<string>('');

const preview = ref<ImportedTaskDefinition[] | null>(null);
const parseErrors = ref<string[]>([]);

const importing = ref<boolean>(false);
const result = ref<{ imported: number; errors?: string[] } | null>(null);

/* ------------------------------------------------------------------ */
/*  派生                                                                */
/* ------------------------------------------------------------------ */

const projectOptions = computed<{ value: string; label: string }[]>(() => [
  { value: '', label: '请选择项目' },
  ...projects.value.map((p) => ({ value: p.id, label: p.name })),
]);

const versionOptions = computed<{ value: string; label: string }[]>(() => [
  { value: '', label: '其他任务（无版本）' },
  ...versions.value.map((v) => ({ value: v.id, label: v.name })),
]);

const canPreview = computed<boolean>(() => content.value.trim().length > 0);
const canImport = computed<boolean>(
  () =>
    preview.value !== null &&
    preview.value.length > 0 &&
    projectId.value !== '' &&
    !importing.value,
);

/* ------------------------------------------------------------------ */
/*  数据加载                                                            */
/* ------------------------------------------------------------------ */

async function loadProjects(): Promise<void> {
  projectsLoading.value = true;
  projectsError.value = null;
  try {
    const resp = await listProjects();
    projects.value = Array.isArray(resp.projects) ? resp.projects : [];
  } catch (e: unknown) {
    if (isHttpError(e)) {
      projectsError.value = e.message || `加载项目失败 (HTTP ${e.status})`;
    } else if (e instanceof Error) {
      projectsError.value = `网络异常: ${e.message}`;
    } else {
      projectsError.value = '加载项目失败';
    }
    projects.value = [];
  } finally {
    projectsLoading.value = false;
  }
}

async function loadVersions(pid: string): Promise<void> {
  if (!pid) {
    versions.value = [];
    versionId.value = '';
    return;
  }
  try {
    const resp = await listVersions(pid);
    versions.value = Array.isArray(resp.versions) ? resp.versions : [];
  } catch {
    versions.value = [];
  }
}

/** 切项目 → 清空版本 (与 Next setProjectId 同款, versionId 必须重新选). */
function onProjectChange(v: string | null): void {
  projectId.value = v ?? '';
  versionId.value = '';
  void loadVersions(projectId.value);
}

function onVersionChange(v: string | null): void {
  versionId.value = v ?? '';
}

/* ------------------------------------------------------------------ */
/*  原生 CLI 会话导入 (一键 sync, 状态轮询)                              */
/* ------------------------------------------------------------------ */

const cliState = ref<CliImportState | null>(null);
const cliStarting = ref<boolean>(false);
let cliPollTimer: ReturnType<typeof setInterval> | null = null;

const CLI_PHASE_LABEL: Record<string, string> = {
  scan: '扫描本机会话',
  summarize: 'LLM 摘要中',
  ingest: '入库中',
  done: '空闲',
  error: '上次出错',
};

const cliStatusText = computed<string>(() => {
  const s = cliState.value;
  if (!s) return '读取状态中…';
  if (!s.phase && !s.running) return '从未运行';
  if (s.running) return CLI_PHASE_LABEL[s.phase || ''] || s.phase || '';
  if (s.phase === 'error') return `上次出错: ${s.message || '未知'}`;
  if (s.phase === 'done' && s.stats) {
    return `上次: 新建 ${s.stats.imported} / 跳过 ${s.stats.skipped} / 自动建项目 ${s.stats.projects_created}`;
  }
  return s.message || '空闲';
});

async function refreshCliState(): Promise<void> {
  try {
    cliState.value = await getCliImportState();
  } catch {
    cliState.value = { running: false, phase: null, message: '状态读取失败' };
  }
  // 跑完自动停轮询
  if (cliState.value && !cliState.value.running && cliPollTimer) {
    clearInterval(cliPollTimer);
    cliPollTimer = null;
  }
}

async function handleCliSync(): Promise<void> {
  cliStarting.value = true;
  try {
    await startCliImport();
    await refreshCliState();
    if (!cliPollTimer) cliPollTimer = setInterval(() => void refreshCliState(), 3000);
    toast.success('CLI 会话同步已启动 — 完成后任务按项目归档');
  } catch (e) {
    if (isHttpError(e) && e.status === 409) {
      await refreshCliState();
      if (!cliPollTimer) cliPollTimer = setInterval(() => void refreshCliState(), 3000);
    } else {
      toast.error(isHttpError(e) ? `启动失败: ${e.message}` : '启动失败');
    }
  } finally {
    cliStarting.value = false;
  }
}

onMounted(() => {
  void loadProjects();
  void refreshCliState();
});

onUnmounted(() => {
  if (cliPollTimer) {
    clearInterval(cliPollTimer);
    cliPollTimer = null;
  }
});

/** format 切换 → 清空预览 + parse 错误 + 导入结果 (与 Next setFormat 同款). */
watch(format, () => {
  preview.value = null;
  parseErrors.value = [];
  result.value = null;
});

/** content 变化 → 清预览 / 错 / 结果 (textarea @input 触发, 与 Next onChange 同款). */
watch(content, () => {
  preview.value = null;
  parseErrors.value = [];
  result.value = null;
});

/* ------------------------------------------------------------------ */
/*  操作                                                                */
/* ------------------------------------------------------------------ */

function runParse(fmt: ImportFormat, raw: string): ImportParseResult {
  switch (fmt) {
    case 'json':
      return parseJsonImport(raw);
    case 'csv':
      return parseCsvImport(raw);
    case 'markdown':
      return parseMarkdownImport(raw);
  }
}

function handlePreview(): void {
  result.value = null;
  const parsed = runParse(format.value, content.value);
  preview.value = parsed.tasks;
  parseErrors.value = parsed.errors;
  if (parsed.tasks.length === 0 && parsed.errors.length === 0) {
    parseErrors.value = ['未识别到任何任务，请检查内容格式'];
  }
}

async function handleImport(): Promise<void> {
  const list = preview.value;
  if (!list || list.length === 0) return;
  if (!projectId.value) {
    toast.error('请先选择目标项目');
    return;
  }
  importing.value = true;
  result.value = null;
  try {
    const resp = await importTasks(format.value, {
      content: content.value,
      project_id: projectId.value,
      version_id: versionId.value || undefined,
    });
    result.value = {
      imported: resp.imported,
      errors: resp.errors,
    };
    if (resp.errors && resp.errors.length > 0) {
      toast.warn(`导入 ${resp.imported} 个任务（${resp.errors.length} 项有警告）`);
    } else {
      toast.success(`已成功导入 ${resp.imported} 个任务`);
    }
    preview.value = null;
    content.value = '';
  } catch (e: unknown) {
    const errs: string[] = [];
    if (isHttpError(e)) {
      if (e.status === 404) {
        errs.push('项目不存在或无权限 (HTTP 404)');
      } else {
        errs.push(e.message || `导入失败 (HTTP ${e.status})`);
      }
    } else if (e instanceof Error) {
      errs.push(`网络异常: ${e.message}`);
    } else {
      errs.push('导入失败');
    }
    parseErrors.value = errs;
    toast.error(errs[0]);
  } finally {
    importing.value = false;
  }
}
</script>

<template>
  <div class="import-page">
    <!-- Header -->
    <header class="page-header">
      <div class="header-text">
        <h1 class="page-title">批量导入任务</h1>
        <p class="page-subtitle">
          支持 JSON / CSV / Markdown 三种格式 — 选项目 → 粘贴内容 → 预览 → 确认导入.
        </p>
      </div>
    </header>

    <div class="page-body">
      <!-- 原生 CLI 会话导入 — 一键把本机 Claude Code CLI 历史同步为平台任务 -->
      <div class="cli-import-card">
        <div class="cli-import-text">
          <h2 class="cli-import-title">从原生 CLI 会话导入</h2>
          <p class="cli-import-desc">
            把本机 Claude Code CLI 的历史会话（~/.claude/projects/）导入为平台任务：
            一个会话 = 一个已完成任务，带自动摘要，对话记录可在任务详情直接查看。
            增量幂等，重复点只补新会话。
          </p>
          <p class="cli-import-status" :class="{ 'cli-import-status-running': cliState?.running }">
            {{ cliState?.running ? '● ' : '' }}{{ cliStatusText }}
          </p>
        </div>
        <Button
          variant="primary"
          size="md"
          :loading="cliStarting"
          :disabled="cliState?.running"
          @click="handleCliSync"
        >{{ cliState?.running ? '同步中…' : '开始同步' }}</Button>
      </div>

      <!-- 项目 / 版本 — 与 Next 端 grid 2 列对齐 -->
      <div class="target-row">
        <div class="target-field">
          <label class="field-label">项目 <span class="required">*</span></label>
          <Select
            :model-value="projectId"
            :options="projectOptions"
            placeholder="请选择项目"
            :disabled="projectsLoading || !!projectsError"
            @update:model-value="onProjectChange"
          />
        </div>
        <div class="target-field">
          <label class="field-label">版本</label>
          <Select
            :model-value="versionId"
            :options="versionOptions"
            placeholder="其他任务（无版本）"
            :disabled="!projectId"
            @update:model-value="onVersionChange"
          />
        </div>
      </div>

      <!-- 格式 tabs — 与 Next 同款 (selected bg-blue-600, 未选 bg-gray-100). -->
      <div class="format-tabs">
        <button
          v-for="opt in FORMAT_OPTIONS"
          :key="opt.value"
          type="button"
          :class="['format-tab', { 'format-tab-active': format === opt.value }]"
          @click="format = opt.value"
        >
          {{ opt.label }}
        </button>
      </div>

      <!-- 格式说明 — 与 Next bg-gray-50 rounded-lg p-3 等价. -->
      <div class="format-help">{{ FORMAT_HELP[format] }}</div>

      <!-- Content textarea — 与 Next <textarea w-full h-64 font-mono> 1:1. -->
      <Textarea
        v-model="content"
        :placeholder="`粘贴 ${format.toUpperCase()} 内容...`"
        :rows="14"
        class-name="content-input"
      />

      <!-- 操作按钮 — 与 Next 同款 (解析按钮 + 条件显示导入按钮). -->
      <div class="action-row">
        <Button
          variant="secondary"
          size="md"
          :disabled="!canPreview"
          @click="handlePreview"
        >预览解析</Button>

        <Button
          v-if="preview && preview.length > 0"
          variant="primary"
          size="md"
          :loading="importing"
          :disabled="!canImport"
          @click="handleImport"
        >{{ importing ? '导入中…' : `确认导入 (${preview.length} 个任务)` }}</Button>
      </div>

      <!-- 解析错误 — 与 Next bg-red-50 border-red-200 等价. -->
      <div v-if="parseErrors.length > 0" class="error-block">
        <div v-for="(err, i) in parseErrors" :key="i" class="error-line">
          ⚠️ {{ err }}
        </div>
      </div>

      <!-- 导入结果 — 与 Next bg-green-50 border-green-200 等价 (含 errors 时叠加黄字). -->
      <div v-if="result" class="result-block">
        <div class="result-line">✅ 成功导入 {{ result.imported }} 个任务</div>
        <div
          v-for="(err, i) in result.errors || []"
          :key="`r-${i}`"
          class="result-warn-line"
        >⚠️ {{ err }}</div>
      </div>

      <!-- 预览列表 — 与 Next bg-white border rounded-lg p-3 等价. -->
      <div v-if="preview && preview.length > 0" class="preview-section">
        <h2 class="section-title">预览 ({{ preview.length }} 个任务)</h2>
        <div class="preview-list">
          <div
            v-for="(task, i) in preview"
            :key="i"
            class="preview-card"
          >
            <div class="preview-title">
              {{ i + 1 }}. {{ task.title }}
            </div>
            <div class="preview-prompt">{{ task.prompt }}</div>
            <div v-if="task.tags && task.tags.length > 0" class="tag-row">
              <span v-for="(tag, j) in task.tags" :key="j" class="tag-chip">
                {{ tag }}
              </span>
            </div>
          </div>
        </div>
      </div>

      <!-- 项目列表加载失败 — 操作面板也需要兜底 -->
      <div v-if="projectsError" class="page-error">
        ⚠️ 项目列表加载失败: {{ projectsError }} — 重新刷新页面可重试.
      </div>
    </div>
  </div>
</template>

<style scoped>
.import-page {
  display: flex;
  flex-direction: column;
  min-height: 100%;
  background: var(--color-bg);
  color: var(--color-text);
}
.page-header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
  padding: 18px 24px 14px;
  background: var(--color-bg-elevated);
  border-bottom: 1px solid var(--color-border);
}
.header-text { min-width: 0; }
.page-title {
  margin: 0;
  font-size: 20px;
  font-weight: 600;
  line-height: 1.3;
}
.page-subtitle {
  margin: 4px 0 0;
  font-size: 13px;
  color: var(--color-text-muted);
  line-height: 1.5;
}

.page-body {
  flex: 1;
  padding: 18px 24px 32px;
  display: flex;
  flex-direction: column;
  gap: 14px;
  overflow-y: auto;
}

/* 原生 CLI 会话导入卡片 — 横排文字+按钮, 跟 page 面板同底色 */
.cli-import-card {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  padding: 14px 16px;
  background: var(--color-bg-elevated);
  border: 1px solid var(--color-border);
  border-radius: 8px;
}
.cli-import-text { min-width: 0; }
.cli-import-title {
  margin: 0;
  font-size: 14px;
  font-weight: 600;
  line-height: 1.4;
}
.cli-import-desc {
  margin: 4px 0 0;
  font-size: 12px;
  color: var(--color-text-muted);
  line-height: 1.5;
}
.cli-import-status {
  margin: 6px 0 0;
  font-size: 12px;
  color: var(--color-text-muted);
  font-variant-numeric: tabular-nums;
}
.cli-import-status-running { color: var(--color-success, #16a34a); }
.cli-import-card > :last-child { flex-shrink: 0; }

/* 项目 / 版本 — 与 Next grid-cols-2 gap-4 等价 */
.target-row {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 14px;
}
.target-field {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.field-label {
  font-size: 13px;
  font-weight: 500;
  color: var(--color-text);
}
.required { color: var(--tw-red-600); margin-left: 2px; }

/* 格式 tab — 与 Next bg-blue-600 text-white / bg-gray-100 等价 */
.format-tabs {
  display: inline-flex;
  gap: 6px;
  flex-wrap: wrap;
}
.format-tab {
  padding: 6px 14px;
  font-size: 13px;
  font-weight: 500;
  border: 1px solid var(--color-border);
  background: var(--color-bg);
  color: var(--color-text-muted);
  border-radius: var(--radius);
  cursor: pointer;
  transition: background 0.15s, color 0.15s, border-color 0.15s;
}
.format-tab:hover {
  background: var(--color-bg-elevated);
  color: var(--color-text);
}
.format-tab-active {
  background: var(--color-primary);
  border-color: var(--color-primary);
  color: #fff;
}
.format-tab-active:hover {
  background: var(--color-primary-hover);
  color: #fff;
}

/* 格式说明 — 与 Next bg-gray-50 rounded-lg p-3 font-mono 等价 */
.format-help {
  background: var(--color-bg);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  padding: 10px 12px;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 12px;
  color: var(--color-text-muted);
  white-space: pre-wrap;
  line-height: 1.5;
}

/* content textarea — 与 Next w-full h-64 font-mono 等价
   关注点: class-name="content-input" 透到 Textarea 组件的 .textarea-wrap; 这里
   用 :deep() 把 height + font 透到内层 .textarea-native, 否则默认 padding/font
   会盖过 Next 端的 mono + 256px 视觉. Textarea 自身已带 gray 描边 + 蓝聚焦,
   这里只覆盖 font + 锁定 min-height (不让 autosize 撑高). */
.content-input :deep(.textarea-native) {
  height: 256px;
  min-height: 256px;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 13px;
}
.content-input :deep(.textarea-row) {
  border-color: var(--color-border-strong);
  border-radius: var(--radius-md);
}

/* action row */
.action-row {
  display: flex;
  gap: 10px;
  flex-wrap: wrap;
}

/* 错误块 — 与 Next bg-red-50 border-red-200 等价 */
.error-block {
  background: var(--tw-red-50);
  border: 1px solid var(--tw-red-200);
  border-radius: var(--radius-md);
  padding: 10px 12px;
}
.error-line {
  font-size: 13px;
  color: var(--tw-red-700);
  line-height: 1.6;
}

/* 结果块 — 与 Next bg-green-50 border-green-200 等价 */
.result-block {
  background: var(--tw-green-50);
  border: 1px solid var(--tw-green-200);
  border-radius: var(--radius-md);
  padding: 10px 12px;
}
.result-line {
  font-size: 13px;
  color: var(--tw-green-700);
  font-weight: 500;
}
.result-warn-line {
  font-size: 13px;
  color: var(--tw-yellow-700);
  line-height: 1.6;
}

/* 预览列表 */
.preview-section {
  margin-top: 4px;
}
.section-title {
  margin: 0 0 8px;
  font-size: 16px;
  font-weight: 600;
}
.preview-list {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.preview-card {
  background: var(--color-bg-elevated);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  padding: 10px 12px;
}
.preview-title {
  font-size: 13px;
  font-weight: 500;
  color: var(--color-text);
  line-height: 1.5;
}
.preview-prompt {
  margin-top: 4px;
  font-size: 12px;
  color: var(--color-text-muted);
  line-height: 1.5;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}
.tag-row {
  margin-top: 6px;
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
}
.tag-chip {
  display: inline-block;
  padding: 1px 8px;
  font-size: 11px;
  color: var(--color-text-muted);
  background: var(--color-bg);
  border: 1px solid var(--color-border);
  border-radius: var(--radius);
  line-height: 1.6;
}

.page-error {
  padding: 10px 12px;
  background: var(--tw-red-50);
  border: 1px solid var(--tw-red-200);
  border-radius: var(--radius-md);
  font-size: 13px;
  color: var(--tw-red-700);
}
</style>