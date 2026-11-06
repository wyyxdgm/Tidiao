<script setup lang="ts">
/* 功能: 项目高级选项面板 — 镜像 master src/app/projects-client.tsx:1199-1482.
   5 个子区块 (parallel_limit / timeout_minutes / ports / wiki_extra_extensions /
   runners), 一次性 PATCH /api/projects/[id] 提交. 由父视图控制 :open,
   自身管所有 inputs / saving / validation.

   关注点:
   - 单 PATCH 五字段并发改 (master 同款): 父视图的 edit 模式聚合多个字段 (后端
     接受 undefined = 不动, null = 清空).
   - 验证顺序: extensions → parallel → timeout → ports → runners; 任一 toast.error
     + abort. 一次只一条 toast (SPA 习惯, 不堆列表).
   - PORT_POOL_CONFLICT 409 结构化错误: 解析 e.conflict (outOfPool + conflicting),
     toast 列冲突端口 + 占用项目 (master 同款).
   - wiki_extra_extensions 走 normalize (扩展名白名单 + 去重 + 大小写归一 +
     md 永远放行不计额度). 这套算法 master 在 src/lib/wiki-files.ts,
     本组件 inline 镜像, 单消费者不抽 lib.
   - ports 字段同步走 parseStoredPorts 容错 (DB 列 = JSON 字符串, 也接受 array).
   - runners: 编辑态接受 draft entries 数组, save 时 command_patterns 字符串
     split('\n').filter(Boolean). os_type 由 select 自动从 listRunners 取
     (race: 还没加载 = 不传, 后端视为不限 OS).
   - 内部常量 (MAX_PARALLEL_LIMIT / MIN/MAX_TIMEOUT_MINUTES / MAX_RUNNER_ENTRIES)
     跟 master 同源, 没引 lib (单消费者).
   - 保存成功保持面板打开 + 刷新 project 字段 (emit 'updated' 让父视图 reload
     projectsStore / loadProject). */
import { computed, onMounted, reactive, ref, watch } from 'vue';
import { isHttpError } from '@/api/http';
import { listRunners, type Runner } from '@/api/runners';
import { updateProject as apiUpdateProject, type Project, type RunnerEntry, type UpdateProjectBody } from '@/api/projects';
import { useToast } from '@/composables/useToast';
import Button from '@/components/Button.vue';
import Input from '@/components/Input.vue';
import Textarea from '@/components/Textarea.vue';
import Select from '@/components/Select.vue';

const props = defineProps<{ project: Project; open: boolean }>();
const emit = defineEmits<{
  (e: 'close'): void;
  (e: 'updated'): void;
}>();

const toast = useToast();

/* ------------------------------------------------------------------ */
/*  Constants (mirror master src/app/projects-client.tsx:35-37)        */
/* ------------------------------------------------------------------ */
const MAX_PARALLEL_LIMIT = 10;
const MIN_TIMEOUT_MINUTES = 1;
const MAX_TIMEOUT_MINUTES = 1440;
const MAX_RUNNER_ENTRIES = 16;
const MAX_EXTRA_EXTENSIONS = 20;
const SUGGESTED_EXTENSIONS = [
  'txt', 'json', 'yaml', 'yml', 'csv', 'toml', 'ini', 'sql',
  'sh', 'ts', 'tsx', 'js', 'py', 'log',
];
const EXT_PATTERN = /^[a-z0-9]{1,16}$/;
const DENIED_EXTENSIONS = new Set([
  'env', 'pem', 'key', 'p12', 'pfx', 'keystore', 'jks', 'ppk', 'asc', 'gpg',
  'kdbx', 'netrc', 'htpasswd', 'cer', 'der', 'crt',
]);

/* ------------------------------------------------------------------ */
/*  Parse helpers (容错 DB 列 = JSON 字符串)                             */
/* ------------------------------------------------------------------ */

/** ports 解析: 接受 number[] / string (JSON 或 CSV) / null. */
function parseStoredPorts(stored: number[] | string | null | undefined): number[] {
  if (stored == null) return [];
  let arr: number[];
  if (Array.isArray(stored)) {
    arr = stored;
  } else {
    const s = String(stored).trim();
    try {
      const parsed = s.startsWith('[') ? JSON.parse(s) : s.split(',');
      arr = Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }
  return arr.map((n) => Number(n)).filter((n) => Number.isInteger(n) && n > 0);
}

/** wiki_extra_extensions 解析: 接受 string[] / JSON string / null. */
function parseStoredExtensions(stored: string[] | string | null | undefined): string[] {
  if (!stored) return [];
  let parsed: unknown;
  if (Array.isArray(stored)) parsed = stored;
  else {
    try {
      parsed = JSON.parse(stored);
    } catch {
      return [];
    }
  }
  if (!Array.isArray(parsed)) return [];
  const out: string[] = [];
  for (const item of parsed) {
    if (typeof item !== 'string') continue;
    const ext = item.trim().replace(/^\.+/, '').toLowerCase();
    if (!ext || ext === 'md' || DENIED_EXTENSIONS.has(ext)) continue;
    if (!EXT_PATTERN.test(ext)) continue;
    if (!out.includes(ext)) out.push(ext);
  }
  return out;
}

/** runners 解析: 接受 RunnerEntry[] / JSON string / null. */
function parseStoredRunners(stored: RunnerEntry[] | string | null | undefined): RunnerEntry[] {
  if (!stored) return [];
  let parsed: unknown;
  if (Array.isArray(stored)) parsed = stored;
  else {
    try {
      parsed = JSON.parse(stored);
    } catch {
      return [];
    }
  }
  if (!Array.isArray(parsed)) return [];
  return parsed.filter(
    (e): e is RunnerEntry =>
      !!e &&
      typeof e === 'object' &&
      typeof (e as RunnerEntry).runner_id === 'string' &&
      typeof (e as RunnerEntry).purpose === 'string' &&
      typeof (e as RunnerEntry).cwd_mapping === 'string' &&
      Array.isArray((e as RunnerEntry).command_patterns),
  );
}

/** normalize 用户输入: array / 空格或逗号分隔 string → 合法扩展名数组. */
function normalizeExtensionsInput(raw: string): { ok: true; value: string[] } | { ok: false; error: string } {
  if (raw.trim() === '') return { ok: true, value: [] };
  const parts = raw.split(/[,\s;]+/);
  const out: string[] = [];
  for (const p of parts) {
    const ext = p.trim().replace(/^\.+/, '').toLowerCase();
    if (ext === '') continue;
    if (ext === '*') return { ok: false, error: '不允许 `*`(放行一切) —— 必须逐个列出扩展名' };
    if (!EXT_PATTERN.test(ext)) return { ok: false, error: `非法扩展名 ${JSON.stringify(p)}：只允许小写字母和数字，1-16 位` };
    if (DENIED_EXTENSIONS.has(ext)) return { ok: false, error: `扩展名 ${ext} 属密钥/凭据类，禁止放行到 wiki` };
    if (ext === 'md') continue;
    if (!out.includes(ext)) out.push(ext);
  }
  if (out.length > MAX_EXTRA_EXTENSIONS) {
    return { ok: false, error: `最多 ${MAX_EXTRA_EXTENSIONS} 个额外扩展名，当前 ${out.length} 个` };
  }
  return { ok: true, value: out };
}

/* ------------------------------------------------------------------ */
/*  State (mirror master projects-client.tsx:153-167)                  */
/* ------------------------------------------------------------------ */

const wikiExtInput = ref<string>('');
const parallelInput = ref<string>('1');
const timeoutInput = ref<string>(''); // "" = inherit global
const portsInput = ref<string>('');   // "" = clear
const runOptions = ref<Runner[]>([]);
const runnerEntries = ref<RunnerEntry[]>([]);

const draftRunnerId = ref<string>('');
const draftPurpose = ref<string>('');
const draftCwdMapping = ref<string>('');
const draftPatterns = ref<string>('');

const saving = ref<boolean>(false);

/* ------------------------------------------------------------------ */
/*  Lifecycle                                                          */
/* ------------------------------------------------------------------ */

/* `:open` 变 true 才 hydrate (避免 mount 即拉 listRunners) + 拉 runner list. */
watch(
  () => [props.open, props.project.id] as const,
  async ([isOpen, projectId]) => {
    if (!isOpen) return;
    hydrateFromProject();
    if (runOptions.value.length === 0) {
      try {
        const resp = await listRunners();
        runOptions.value = Array.isArray(resp?.runners) ? resp.runners : [];
      } catch {
        // runOptions 留空 → runner 子区块显示「去 /runners 注册」; 不阻塞其他字段保存.
      }
    }
  },
  { immediate: true },
);

function hydrateFromProject(): void {
  wikiExtInput.value = parseStoredExtensions(props.project.wiki_extra_extensions).join(' ');
  parallelInput.value = String(props.project.parallel_limit ?? 1);
  timeoutInput.value = props.project.timeout_minutes == null ? '' : String(props.project.timeout_minutes);
  portsInput.value = parseStoredPorts(props.project.ports).join(', ');
  runnerEntries.value = parseStoredRunners(props.project.runners);
  draftRunnerId.value = '';
  draftPurpose.value = '';
  draftCwdMapping.value = '';
  draftPatterns.value = '';
}

/* ------------------------------------------------------------------ */
/*  Wiki ext pill toggles                                              */
/* ------------------------------------------------------------------ */

const currentExtSet = computed<Set<string>>(() => {
  const s = new Set<string>();
  for (const p of wikiExtInput.value.split(/[,\s;]+/)) {
    const ext = p.trim().replace(/^\.+/, '').toLowerCase();
    if (ext) s.add(ext);
  }
  return s;
});

function toggleExt(ext: string): void {
  const cur = wikiExtInput.value
    .split(/[,\s;]+/)
    .map((x) => x.trim().replace(/^\.+/, '').toLowerCase())
    .filter(Boolean);
  const on = cur.includes(ext);
  const next = on ? cur.filter((x) => x !== ext) : [...cur, ext];
  wikiExtInput.value = next.join(' ');
}

/* ------------------------------------------------------------------ */
/*  Runners draft                                                      */
/* ------------------------------------------------------------------ */

function addRunnerEntry(): void {
  if (!draftRunnerId.value.trim()) {
    toast.error('请选择 runner');
    return;
  }
  if (!draftPurpose.value.trim()) {
    toast.error('请填写 purpose');
    return;
  }
  if (!draftCwdMapping.value.trim()) {
    toast.error('请填写 cwd_mapping');
    return;
  }
  const patterns = draftPatterns.value.split('\n').map((p) => p.trim()).filter(Boolean);
  if (patterns.length === 0) {
    toast.error('请至少填一条 command_patterns');
    return;
  }
  if (patterns.length > 32) {
    toast.error(`单条 entry 最多 32 条 pattern, 当前 ${patterns.length} 条`);
    return;
  }
  if (runnerEntries.value.length >= MAX_RUNNER_ENTRIES) {
    toast.error(`runner entry 最多 ${MAX_RUNNER_ENTRIES} 条`);
    return;
  }
  const opt = runOptions.value.find((r) => r.id === draftRunnerId.value);
  const entry: RunnerEntry = {
    runner_id: draftRunnerId.value,
    purpose: draftPurpose.value.trim(),
    cwd_mapping: draftCwdMapping.value.trim(),
    command_patterns: patterns,
  };
  if (opt?.os_type) entry.os_type = opt.os_type;
  runnerEntries.value = [...runnerEntries.value, entry];
  draftRunnerId.value = '';
  draftPurpose.value = '';
  draftCwdMapping.value = '';
  draftPatterns.value = '';
}

function removeRunnerEntry(idx: number): void {
  runnerEntries.value = runnerEntries.value.filter((_, i) => i !== idx);
}

function runnerLabel(r: Runner): string {
  return `${r.name} (${r.host}:${r.port})`;
}

/* ------------------------------------------------------------------ */
/*  Save                                                               */
/* ------------------------------------------------------------------ */

async function saveAll(): Promise<void> {
  // 1. extensions normalize
  const extNorm = normalizeExtensionsInput(wikiExtInput.value);
  if (!extNorm.ok) {
    toast.error(extNorm.error);
    return;
  }

  // 2. parallel_limit
  const parallelNum = Number(parallelInput.value);
  if (!Number.isInteger(parallelNum) || parallelNum < 1 || parallelNum > MAX_PARALLEL_LIMIT) {
    toast.error(`同目录并发上限必须是 1-${MAX_PARALLEL_LIMIT} 的整数`);
    return;
  }

  // 3. timeout_minutes ("" = null/inherit)
  let timeout: number | null = null;
  if (timeoutInput.value.trim() !== '') {
    const n = Number(timeoutInput.value);
    if (!Number.isInteger(n) || n < MIN_TIMEOUT_MINUTES || n > MAX_TIMEOUT_MINUTES) {
      toast.error(`任务超时必须是 ${MIN_TIMEOUT_MINUTES}-${MAX_TIMEOUT_MINUTES} 的整数(分钟), 留空=继承全局`);
      return;
    }
    timeout = n;
  }

  // 4. ports ("" = null/clear)
  let ports: number[] | null = null;
  if (portsInput.value.trim() !== '') {
    const parts = portsInput.value.split(',').map((p) => p.trim()).filter(Boolean);
    if (parts.length > 5) {
      toast.error('端口最多 5 个, 逗号分隔');
      return;
    }
    const parsed: number[] = [];
    for (const p of parts) {
      const n = Number(p);
      if (!Number.isInteger(n) || n < 1024 || n > 65535) {
        toast.error(`端口 "${p}" 非法: 需 1024-65535 整数`);
        return;
      }
      parsed.push(n);
    }
    ports = parsed;
  }

  // 5. runners ([]/[]-like = null/clear)
  const runners: RunnerEntry[] | null = runnerEntries.value.length === 0 ? null : runnerEntries.value;

  const body: UpdateProjectBody = {
    wiki_extra_extensions: extNorm.value,
    parallel_limit: parallelNum,
    timeout_minutes: timeout,
    ports,
    runners,
  };

  saving.value = true;
  try {
    await apiUpdateProject(props.project.id, body);
    toast.success(
      `已保存: 同目录并发 ${parallelNum}, 超时 ${timeout === null ? '跟随全局默认' : `${timeout} 分钟`}`,
    );
    emit('updated');
    emit('close');
  } catch (e: unknown) {
    if (isHttpError(e) && e.code === 'PORT_POOL_CONFLICT') {
      const conflict = (e as unknown as { conflict?: { outOfPool?: number[]; conflicting?: Array<{ port: number; owner_project_id: string }> } }).conflict;
      const outOfPool = conflict?.outOfPool ?? [];
      const conflicting = conflict?.conflicting ?? [];
      const parts: string[] = [];
      if (outOfPool.length) parts.push(`出池端口: ${outOfPool.slice(0, 3).join(', ')}`);
      if (conflicting.length) parts.push(`占用端口: ${conflicting.slice(0, 3).map((c) => `${c.port} (项目 ${c.owner_project_id.slice(0, 8)})`).join(', ')}`);
      toast.error(parts.length ? `端口冲突: ${parts.join('；')}` : (e.message || '保存失败'));
    } else if (isHttpError(e)) {
      toast.error(e.message || '保存失败');
    } else {
      toast.error('保存失败');
    }
  } finally {
    saving.value = false;
  }
}
</script>

<template>
  <div v-if="open" class="adv-panel">
    <!-- A. 同目录并发上限 -->
    <div class="adv-block">
      <div class="adv-head">⚡ 高级选项 · 同目录并发上限</div>
      <p class="adv-hint">
        本项目<strong>共享同一个工作目录</strong>的任务默认只能跑一个（避免两个 agent 同时改同一棵 git 工作树）。调高后可让 N 个任务同时跑在同一目录。
        <br />
        <span class="adv-warn">
          🔴 只适合基本不写工作目录的项目（巡检/研究/问答）。会写文件或 <code>git commit</code> 的项目调高 = <code>index.lock</code> 冲突 + 同名文件互相覆盖。实际并行度 = min(全局并发, 本值, 账号上限)。
        </span>
      </p>
      <Input
        v-model="parallelInput"
        type="number"
        :min="1"
        :max="MAX_PARALLEL_LIMIT"
        :disabled="saving"
        class-name="adv-input-parallel"
      />
    </div>

    <!-- B. 任务超时 -->
    <div class="adv-block">
      <div class="adv-head">⏱ 高级选项 · 任务超时（分钟）</div>
      <p class="adv-hint">
        单个任务最长运行多久。<strong>留空 = 跟随全局默认</strong>（设置页「任务超时」，缺省 30 分钟）。到点后走「暂停」同一条路径：打断当前一轮但保留上下文，可恢复续跑。
        <br />
        <span class="adv-warn">
          🔴 调长的代价：<code>paused</code> 是非终态，定时任务防重派闸门按「非终态」算在飞 —— 超时挂着的任务会挡住后续触发更久。对已在跑的任务不生效（下一次启动/恢复才吃到新值）。
        </span>
      </p>
      <Input
        v-model="timeoutInput"
        type="number"
        :min="MIN_TIMEOUT_MINUTES"
        :max="MAX_TIMEOUT_MINUTES"
        placeholder="跟随全局"
        :disabled="saving"
        class-name="adv-input-timeout"
      />
    </div>

    <!-- C. 项目端口 -->
    <div class="adv-block">
      <div class="adv-head">🔌 高级选项 · 项目端口</div>
      <p class="adv-hint">
        本项目占用的端口列表（逗号分隔, 最多 5 个）。必须落在 admin 配置的<strong>端口池</strong>内, 也不能与其它项目撞. 出池或撞端口时保存会回 409 + 冲突明细. <strong>留空 = 清空</strong>.
      </p>
      <Input
        v-model="portsInput"
        type="text"
        placeholder="13001, 13002（留空 = 清空）"
        :disabled="saving"
        class-name="adv-input-ports"
      />
      <div class="adv-preview muted">
        当前: {{ parseStoredPorts(project.ports).join(', ') || '（未分配）' }}
      </div>
    </div>

    <!-- D. Wiki 可读取的文件类型 -->
    <div class="adv-block">
      <div class="adv-head">🔧 高级选项 · Wiki 可读取的文件类型</div>
      <p class="adv-hint">
        Wiki 默认只读取 <code>.md</code>。在此追加扩展名(空格或逗号分隔),即可在 Wiki 里浏览 agent 产出的 json / csv 等文件。留空保存 = 恢复默认(只读 .md)。
        <br />
        <span class="adv-warn">
          仅小写字母数字,最多 {{ MAX_EXTRA_EXTENSIONS }} 个;隐藏文件(<code>.env</code> 等以 . 开头的)和密钥类扩展名始终不可读取。非 .md 文件有 1 MiB 大小上限。
        </span>
      </p>
      <Input
        v-model="wikiExtInput"
        type="text"
        placeholder="json csv txt yaml"
        :disabled="saving"
        class-name="adv-input-exts"
      />
      <div class="adv-ext-pills">
        <button
          v-for="ext in SUGGESTED_EXTENSIONS"
          :key="ext"
          type="button"
          :class="['adv-ext-pill', currentExtSet.has(ext) ? 'is-on' : '']"
          :disabled="saving"
          @click="toggleExt(ext)"
        >.{{ ext }}</button>
      </div>
    </div>

    <!-- E. Runners 子块 -->
    <div class="adv-runners">
      <div class="adv-head">🛰️ 高级选项 · Runners（远程执行白名单）</div>
      <p class="adv-hint">
        把本项目命中命令白名单的 Bash 调到目标机的 runner daemon 执行 (例：<code>cargo tauri build</code> 必须在 mac 上跑)。每条 entry = 一个 runner + 一个目的 (purpose) + 路径映射 (runner 物理路径, 与平台 WSL 的 /home/user/... 不同) + 命令白名单 (每行一条, R3 escape 后 .* 匹配).
        <br />
        <span class="adv-warn">
          🔴 runner_id 必须真在 /runners 里注册过; <code>cwd_mapping</code> 错了 exec 必失败; <code>.*</code> 等过宽正则 = 把 Bash 几乎全打到 runner 上, 慎填. 留空 = 清空 (回 NULL, 全部走本地 SDK bash, 不走远程).
        </span>
      </p>

      <!-- 已配 entry 列表 -->
      <div v-if="runnerEntries.length > 0" class="adv-runner-list">
        <div v-for="(e, idx) in runnerEntries" :key="idx" class="adv-runner-row">
          <div class="adv-runner-info">
            <div class="adv-runner-name" :title="e.runner_id">
              runner: {{ runOptions.find((r) => r.id === e.runner_id)?.name ?? e.runner_id }}
              <span class="muted">({{ runOptions.find((r) => r.id === e.runner_id)?.host ?? '?' }}:{{ runOptions.find((r) => r.id === e.runner_id)?.port ?? '?' }})</span>
            </div>
            <div class="muted small">purpose: {{ e.purpose }}</div>
            <div class="muted small mono" :title="e.cwd_mapping">cwd_mapping: {{ e.cwd_mapping }}</div>
            <div class="muted small">
              patterns ({{ e.command_patterns.length }}):
              {{ e.command_patterns.slice(0, 3).join(', ') }}{{ e.command_patterns.length > 3 ? ` … (+${e.command_patterns.length - 3})` : '' }}
            </div>
          </div>
          <button
            type="button"
            class="adv-runner-del"
            :disabled="saving"
            @click="removeRunnerEntry(idx)"
          >删除</button>
        </div>
      </div>

      <!-- 新增 entry 草稿 -->
      <div class="adv-runner-draft">
        <div class="adv-runner-grid">
          <label class="adv-form-label">
            runner
            <Select
              v-model="draftRunnerId"
              :options="runOptions.map((r) => ({ value: r.id, label: runnerLabel(r) }))"
              :placeholder="runOptions.length === 0 ? '无可用 runner, 去 /runners 注册' : '选择 runner'"
              :disabled="saving || runOptions.length === 0"
            />
          </label>
          <label class="adv-form-label">
            purpose
            <Input
              v-model="draftPurpose"
              placeholder="mac-tauri-build"
              :disabled="saving"
            />
          </label>
        </div>
        <label class="adv-form-label">
          cwd_mapping
          <Input
            v-model="draftCwdMapping"
            placeholder="/Users/user/workspace/agent-orchestrator-dev"
            :disabled="saving"
            class-name="adv-input-cwd"
          />
        </label>
        <label class="adv-form-label">
          command_patterns
          <Textarea
            v-model="draftPatterns"
            :rows="4"
            placeholder="cargo tauri build&#10;npm run tauri build"
            :disabled="saving"
            class-name="adv-input-patterns"
          />
        </label>
        <div class="adv-runner-draft-actions">
          <Button
            size="sm"
            variant="primary"
            :disabled="saving || runnerEntries.length >= MAX_RUNNER_ENTRIES"
            @click="addRunnerEntry"
          >+ 加入列表</Button>
        </div>
      </div>
    </div>

    <!-- F. Footer -->
    <div class="adv-footer">
      <Button variant="primary" size="sm" :loading="saving" :disabled="saving" @click="saveAll">保存</Button>
      <Button variant="ghost" size="sm" :disabled="saving" @click="emit('close')">取消</Button>
      <router-link :to="`/${project.id}/wiki`" class="adv-wiki-link" target="_blank">
        打开 Wiki →
      </router-link>
    </div>
  </div>
</template>

<style scoped>
/* R70: ProjectAdvancedOptionsPanel — amber 调 (与 LLM panel 蓝调区分).
   scoped, 不污染其他视图. 调色用 inline hex 不抽 token (panel-specific). */
.adv-panel {
  background: var(--tw-amber-50);
  border-top: 1px solid var(--tw-amber-200);
  padding: 12px 14px;
  display: flex;
  flex-direction: column;
  gap: 14px;
}
.adv-block {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.adv-head {
  font-size: 12px;
  font-weight: 600;
  color: var(--color-text);
}
.adv-hint {
  margin: 0;
  font-size: 11.5px;
  line-height: 1.5;
  color: var(--color-text-muted);
}
.adv-hint code {
  background: rgba(0, 0, 0, 0.04);
  padding: 0 4px;
  border-radius: 3px;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 11px;
}
.adv-warn {
  color: var(--tw-amber-700);
}
.adv-warn code {
  background: rgba(180, 83, 9, 0.08);
  color: var(--tw-amber-700);
}

:deep(.adv-input-parallel) {
  width: 96px;
}
:deep(.adv-input-parallel input) {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
}
:deep(.adv-input-timeout) {
  width: 112px;
}
:deep(.adv-input-timeout input) {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
}
:deep(.adv-input-ports) {
  width: 256px;
}
:deep(.adv-input-ports input) {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
}
:deep(.adv-input-exts input) {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
}
.adv-preview {
  font-size: 11px;
  margin-top: 2px;
}

.adv-ext-pills {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  margin-top: 4px;
}
.adv-ext-pill {
  background: var(--color-bg-elevated);
  border: 1px solid var(--color-border-strong);
  color: var(--color-text-muted);
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 11px;
  padding: 2px 8px;
  border-radius: var(--radius);
  cursor: pointer;
}
.adv-ext-pill:hover:not(:disabled) {
  border-color: var(--color-primary);
}
.adv-ext-pill.is-on {
  background: var(--color-primary);
  border-color: var(--color-primary);
  color: #fff;
}
.adv-ext-pill:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.adv-runners {
  padding-top: 10px;
  border-top: 1px solid var(--tw-amber-200);
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.adv-runner-list {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.adv-runner-row {
  background: var(--color-bg-elevated);
  border: 1px solid var(--tw-amber-200);
  border-radius: var(--radius);
  padding: 6px 8px;
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 8px;
  font-size: 11.5px;
}
.adv-runner-info {
  display: flex;
  flex-direction: column;
  gap: 2px;
  flex: 1;
  min-width: 0;
}
.adv-runner-name {
  font-weight: 500;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
}
.adv-runner-del {
  background: transparent;
  border: 0;
  color: var(--tw-red-700);
  font-size: 11px;
  cursor: pointer;
  padding: 0;
  flex-shrink: 0;
}
.adv-runner-del:hover:not(:disabled) {
  text-decoration: underline;
}

.adv-runner-draft {
  background: var(--tw-amber-100);
  border: 1px solid var(--tw-amber-200);
  border-radius: var(--radius);
  padding: 8px;
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.adv-runner-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 6px;
}
.adv-form-label {
  display: flex;
  flex-direction: column;
  gap: 3px;
  font-size: 11.5px;
  color: var(--color-text);
}
:deep(.adv-input-cwd input) {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
}
:deep(.adv-input-patterns textarea) {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 11.5px;
}
.adv-runner-draft-actions {
  display: flex;
  justify-content: flex-end;
}

.adv-footer {
  display: flex;
  align-items: center;
  gap: 8px;
  padding-top: 8px;
  border-top: 1px solid var(--tw-amber-200);
}
.adv-wiki-link {
  margin-left: auto;
  font-size: 12px;
  color: var(--color-primary);
  text-decoration: none;
}
.adv-wiki-link:hover {
  text-decoration: underline;
}

.muted {
  color: var(--color-text-muted);
}
.small {
  font-size: 11px;
}
</style>