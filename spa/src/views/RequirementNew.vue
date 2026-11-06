<script setup lang="ts">
/* 功能: 新建需求点视图 — 完整镜像 Next.js src/app/requirements/new/page.tsx +
   src/app/requirements/new/new-requirement-form.tsx. sheet R15 字面要求.

   关注点 (与 Next 端 1:1 + 与现实分歧):
   - 项目 → 版本级联 select, 提交走 POST /api/requirements (与 Next 同款契约).
   - sheet R107 R 列跟进: 接受 ?project_id= + ?version_id= 让"← 需求点列表"
     和"取消"按钮携带原页面上下文. SPA 在 hash 路由下用 useRoute().query 拿.
   - 与 Next 端差异 (本视图内):
     (1) sheet 字面 "CreateTaskButton" 不存在 (Next /requirements/[id] 才挂),
         本视图是创建页不是详情页, 不引入派发按钮 (符合 Next 端原意).
     (2) 创建成功跳转目标 = /requirements?project_id=X&version_id=Y (带原上下文回
         列表), 而非 Next 的 /requirements/[id] (SPA 无 detail 路由, R+ 范畴
         单独排期, 与 R11 webhook detail 同款拍板). 列表页 Requirements.vue
         已支持 project_id 过滤 (R28), version_id 过滤 (R28 + R64), 跳过去
         用户能立刻看到刚建的条目 + 上下文.
     (3) SPA 不显式给"标题 * 必填" 客户端阻断, 但走与 Next 同款 inline check
         (project_id 空 或 title 空 → toast.error + return); 不引 R3 字段级
         error UI (auth 页面风格, 该视图是表单密集型, 与 LoginView 不同语境).
     (4) Sheet 描述 "完整功能对等", 复制 R71 多附件上传 — 创建后逐文件
         POST /api/requirements/[id]/attachments (multipart, 10MB 上限, 失败
         console.warn 不阻断跳转). 与 assets.ts uploadAttachmentToTask 同款
         原生 fetch + FormData 模式 (不能用 http.ts api() 强制 application/json).
     (5) Sheet 没明说 required field UI 风格, 沿用 Next "label * " 标记必填.
   - 版本 select 三态 sentinel: '' = 自动取项目当前版本 (不传 version_id);
     '__none__' = 显式不挂版本 (传 null); 其他 = 指定 version id.
   - 切换项目时必须重置 version 选择 — 否则 A 项目 version 提交到 B 项目
     (API 400 VERSION_PROJECT_MISMATCH, 与 Next 同款 UX 防御).
   - 项目过滤走 NavigationTree.ownedProjects 同一规则: 当前账号名下的项目
     才显示 (owner_id === currentUserId). userId 拿不到时不过滤, 保持兜底. */

import { computed, onMounted, reactive, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { listVersions, type Version } from '@/api/projects';
import { listProjects, type Project } from '@/api/projects';
import { getMyProfile } from '@/api/user';
import {
  createRequirement,
  type CreateRequirementBody,
} from '@/api/requirements';
import { HttpError, isHttpError } from '@/api/http';
import { useToast } from '@/composables/useToast';
import Button from '@/components/Button.vue';
import Input from '@/components/Input.vue';
import Textarea from '@/components/Textarea.vue';
import Select from '@/components/Select.vue';
import Loading from '@/components/Loading.vue';
import ErrorView from '@/components/ErrorView.vue';
import FileInput from '@/components/FileInput.vue';

/* ------------------------------------------------------------------ */
/*  URL 参数 (R107)                                                     */
/* ------------------------------------------------------------------ */

const route = useRoute();
const router = useRouter();

/** 入口 URL 上的 ?project_id= + ?version_id= (R107 R 列跟进). */
const presetProjectId = computed<string>(() => {
  const v = route.query.project_id;
  return typeof v === 'string' ? v : '';
});
const presetVersionId = computed<string>(() => {
  const v = route.query.version_id;
  return typeof v === 'string' ? v : '';
});

/** 构造回到列表的 href — 与 Next buildBackToListHref 同款.
    有 project_id → /requirements?project_id=X&version_id=Y; 无 → /requirements. */
function buildBackToListHref(
  projectId: string | undefined,
  versionId: string | undefined,
): string {
  if (!projectId) return '/requirements';
  const qs = new URLSearchParams();
  qs.set('project_id', projectId);
  if (versionId) qs.set('version_id', versionId);
  return `/requirements?${qs.toString()}`;
}

const backHref = computed<string>(() =>
  buildBackToListHref(presetProjectId.value, presetVersionId.value),
);

/* ------------------------------------------------------------------ */
/*  状态                                                                */
/* ------------------------------------------------------------------ */

const projects = ref<Project[]>([]);
const versions = ref<Version[]>([]);
const currentUserId = ref<string | null>(null);
const loading = ref<boolean>(true);
const loadError = ref<string | null>(null);

const projectId = ref<string>(presetProjectId.value);
// '' = 自动取项目当前版本 (不传 version_id); '__none__' = 显式不挂版本 (传 null);
// 其他 = 指定 version id.
const versionId = ref<string>(presetVersionId.value);
const title = ref<string>('');
const description = ref<string>('');
const priority = ref<string>(''); // '' = 无, 1-5 = P1-P5
const tags = ref<string>(''); // 逗号分隔
const error = ref<string | null>(null);
const submitting = ref<boolean>(false);

// R71 多附件 (浏览器 File 对象数组, 提交后逐文件 POST).
const pendingFiles = ref<File[]>([]);
const fileInputRef = ref<InstanceType<typeof FileInput> | null>(null);

/* ------------------------------------------------------------------ */
/*  派生                                                                */
/* ------------------------------------------------------------------ */

/** 与 NavigationTree.ownedProjects 同款过滤: 只显示当前账号名下的项目. */
const visibleProjects = computed<Project[]>(() =>
  currentUserId.value
    ? projects.value.filter((p) => p.owner_id === currentUserId.value)
    : projects.value,
);

const projectOptions = computed<{ value: string; label: string }[]>(() =>
  visibleProjects.value.map((p) => ({ value: p.id, label: p.name })),
);

const selectedProject = computed<Project | null>(
  () => visibleProjects.value.find((p) => p.id === projectId.value) ?? null,
);

const projectVersions = computed<Version[]>(() =>
  versions.value.filter((v) => v.project_id === projectId.value),
);

const versionOptions = computed<{ value: string; label: string }[]>(() => [
  { value: '__none__', label: '(不挂版本)' },
  ...projectVersions.value.map((v) => ({
    value: v.id,
    label:
      v.name + (v.id === selectedProject.value?.current_version_id ? '  · 当前' : ''),
  })),
]);

const priorityOptions: { value: string; label: string }[] = [
  { value: '', label: '--' },
  { value: '1', label: 'P1' },
  { value: '2', label: 'P2' },
  { value: '3', label: 'P3' },
  { value: '4', label: 'P4' },
  { value: '5', label: 'P5' },
];

/* ------------------------------------------------------------------ */
/*  数据加载                                                            */
/* ------------------------------------------------------------------ */

async function loadAll(): Promise<void> {
  loading.value = true;
  loadError.value = null;
  try {
    // 与 Next onMounted 同款三路并发: projects (sort=manual 与导航同源) + versions
    // (全量, 用于切项目时按需过滤, 与 R28 Requirements.vue loadAllVersions 同口径)
    // + user/me (拿 owner_id 用于 visibleProjects 过滤).
    const [pResp, vResp, me] = await Promise.all([
      listProjects('manual'),
      listVersions(),
      getMyProfile().catch(() => null),
    ]);
    projects.value = pResp.projects ?? [];
    versions.value = vResp.versions ?? [];
    if (me?.id) currentUserId.value = me.id;
  } catch (e: unknown) {
    if (isHttpError(e)) {
      loadError.value = e.message || `加载失败 (HTTP ${e.status})`;
    } else if (e instanceof Error) {
      loadError.value = `网络异常: ${e.message}`;
    } else {
      loadError.value = '加载失败';
    }
  } finally {
    loading.value = false;
  }
}

function onLoadRetry(): void {
  void loadAll();
}

onMounted(() => {
  void loadAll();
});

/* ------------------------------------------------------------------ */
/*  级联 (切换项目重置 version)                                          */
/* ------------------------------------------------------------------ */

watch(
  () => projectId.value,
  (next) => {
    // 切换项目必须重置 version — 防止把上一个项目的 version 带过去.
    versionId.value = '';
    // 同时校正: 若 presetVersionId 是另一项目的, 也清掉 (避免无效初始值).
    if (presetVersionId.value && next && next !== presetProjectId.value) {
      // no-op — versionId 已是 '', 上面已重置.
    }
  },
);

/* ------------------------------------------------------------------ */
/*  附件上传 (R71)                                                       */
/* ------------------------------------------------------------------ */

async function uploadAttachments(requirementId: string): Promise<void> {
  for (const file of pendingFiles.value) {
    try {
      const fd = new FormData();
      fd.append('file', file);
      const res = await fetch(
        `/api/requirements/${requirementId}/attachments`,
        {
          method: 'POST',
          body: fd,
          credentials: 'include',
        },
      );
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        console.warn(
          `[requirement] attachment upload failed for ${file.name}:`,
          data.error,
        );
      }
    } catch (err) {
      console.warn(
        `[requirement] attachment upload error for ${file.name}:`,
        err,
      );
    }
  }
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function onDropFiles(fileList: FileList | null): void {
  if (!fileList || fileList.length === 0) return;
  const files = Array.from(fileList);
  pendingFiles.value = [...pendingFiles.value, ...files];
}

function onPickFiles(files: FileList | null): void {
  onDropFiles(files);
  // 重置 input.value 让同名文件可再次选择.
  fileInputRef.value?.reset();
}

function removeFile(index: number): void {
  pendingFiles.value = pendingFiles.value.filter((_, idx) => idx !== index);
}

/* ------------------------------------------------------------------ */
/*  提交                                                                */
/* ------------------------------------------------------------------ */

const toast = useToast();

async function onSubmit(): Promise<void> {
  error.value = null;
  if (!projectId.value || !title.value.trim()) {
    error.value = '项目和标题必填';
    toast.error('项目和标题必填');
    return;
  }
  submitting.value = true;
  try {
    const body: CreateRequirementBody = {
      project_id: projectId.value,
      title: title.value.trim(),
    };
    const desc = description.value.trim();
    if (desc) body.description = desc;
    if (priority.value) body.priority = parseInt(priority.value);
    const tagList = tags.value
      .split(',')
      .map((t) => t.trim())
      .filter(Boolean);
    if (tagList.length) body.tags = tagList;
    // '' 不传 = DB 兜到项目当前版本; '__none__' 显式 null.
    if (versionId.value === '__none__') body.version_id = null;
    else if (versionId.value) body.version_id = versionId.value;

    const created = await createRequirement(body);

    // R71 两步上传附件 — 失败不阻断跳转, 只 console.warn.
    if (pendingFiles.value.length > 0) {
      await uploadAttachments(created.id);
    }

    // 跳回列表页, 携带项目/版本上下文 (R107 R 列跟进). SPA 无 requirement
    // detail 路由, 走列表页 (Requirements.vue 支持 project_id + version_id 过滤).
    const detailQs = new URLSearchParams();
    detailQs.set('project_id', projectId.value);
    if (versionId.value === '__none__') {
      detailQs.set('version_id', 'null');
    } else if (versionId.value) {
      detailQs.set('version_id', versionId.value);
    }
    toast.success(`已创建: ${created.title}`);
    await router.push(`/requirements?${detailQs.toString()}`);
  } catch (e: unknown) {
    if (isHttpError(e)) {
      const he = e as HttpError;
      error.value = he.message || `创建失败 (HTTP ${he.status})`;
      toast.error(error.value);
    } else if (e instanceof Error) {
      error.value = `创建失败: ${e.message}`;
      toast.error(error.value);
    } else {
      error.value = '创建失败';
      toast.error(error.value);
    }
    submitting.value = false;
  }
}

function onCancel(): void {
  router.push(backHref.value);
}
</script>

<template>
  <div class="req-new-page">
    <div class="req-new-back">
      <router-link :to="backHref" class="req-new-back-link">← 需求点列表</router-link>
    </div>

    <h1 class="req-new-title">新建需求点</h1>

    <Loading v-if="loading" />

    <ErrorView
      v-else-if="loadError"
      variant="error"
      title="加载失败"
      :description="loadError"
      @retry="onLoadRetry"
    />

    <form v-else class="req-new-form" @submit.prevent="onSubmit">
      <div v-if="error" class="req-new-error">{{ error }}</div>

      <div class="req-new-field">
        <label class="req-new-label" for="rn-project">项目 *</label>
        <Select
          :model-value="projectId"
          @update:model-value="(v: string | null) => (projectId = v ?? '')"
          :options="projectOptions"
          :disabled="loading"
          :placeholder="loading ? '加载中…' : '-- 选择项目 --'"
          class-name="req-new-select"
        />
        <p
          v-if="!loading && visibleProjects.length === 0"
          class="req-new-hint req-new-hint-error"
        >
          当前账号名下没有项目，先去
          <router-link to="/" class="req-new-inline-link">首页</router-link>
          创建一个。
        </p>
      </div>

      <div class="req-new-field">
        <label class="req-new-label" for="rn-version">版本 (可选)</label>
        <Select
          :model-value="versionId || null"
          @update:model-value="(v: string | null) => (versionId = v ?? '')"
          :options="versionOptions"
          :disabled="!projectId"
          :placeholder="projectId ? '-- (自动 = 项目当前版本) --' : '先选项目'"
          class-name="req-new-select"
        />
        <p class="req-new-hint">
          默认 = 项目的「当前版本」. 允许跨版本迁移 (v1 → v2, 跟进迭代).
        </p>
      </div>

      <div class="req-new-field">
        <label class="req-new-label" for="rn-title">标题 *</label>
        <Input
          id="rn-title"
          v-model="title"
          :maxlength="200"
          placeholder=""
        />
      </div>

      <div class="req-new-field">
        <label class="req-new-label" for="rn-description">描述</label>
        <Textarea
          id="rn-description"
          v-model="description"
          :rows="4"
          placeholder=""
        />
      </div>

      <div class="req-new-grid">
        <div class="req-new-field">
          <label class="req-new-label" for="rn-priority">优先级 (1-5)</label>
          <Select
            :model-value="priority || null"
            @update:model-value="(v: string | null) => (priority = v ?? '')"
            :options="priorityOptions"
            placeholder="--"
            class-name="req-new-select"
          />
        </div>

        <div class="req-new-field">
          <label class="req-new-label" for="rn-tags">标签 (逗号分隔)</label>
          <Input
            id="rn-tags"
            v-model="tags"
            placeholder="ui, p1"
          />
        </div>
      </div>

      <div class="req-new-field">
        <label class="req-new-label">附件</label>
        <div
          class="req-new-drop"
          @dragover.prevent
          @drop.prevent="onDropFiles($event.dataTransfer?.files ?? null)"
          @click="fileInputRef?.open()"
        >
          拖拽文件到此处，或点击选择（创建需求点后自动上传，单文件 ≤10MB）
          <FileInput
            ref="fileInputRef"
            multiple
            @change="onPickFiles"
          />
        </div>
        <ul v-if="pendingFiles.length > 0" class="req-new-files">
          <li
            v-for="(f, i) in pendingFiles"
            :key="`${f.name}-${i}`"
            class="req-new-file"
          >
            <span class="req-new-file-name">
              {{ f.name }} <span class="req-new-file-size">({{ formatSize(f.size) }})</span>
            </span>
            <button
              type="button"
              class="req-new-file-remove"
              @click.stop="removeFile(i)"
            >
              ×
            </button>
          </li>
        </ul>
      </div>

      <div class="req-new-actions">
        <Button
          type="submit"
          variant="primary"
          :loading="submitting"
          :disabled="submitting"
        >
          {{ submitting ? '创建中…' : '创建' }}
        </Button>
        <Button type="button" variant="secondary" :disabled="submitting" @click="onCancel">
          取消
        </Button>
      </div>
    </form>
  </div>
</template>

<style scoped>
.req-new-page {
  max-width: 640px;
  margin: 0 auto;
  padding: 24px;
}
.req-new-back {
  margin-bottom: 16px;
}
.req-new-back-link {
  font-size: 13px;
  color: var(--tw-blue-600);
  text-decoration: none;
}
.req-new-back-link:hover {
  text-decoration: underline;
}
.req-new-title {
  font-size: 24px;
  font-weight: 700;
  margin: 0 0 24px 0;
  color: var(--color-text, #111827);
}
.req-new-form {
  background: var(--color-bg-elevated, #fff);
  border: 1px solid var(--color-border, #e5e7eb);
  border-radius: 8px;
  padding: 24px;
  box-shadow: 0 1px 2px rgba(0, 0, 0, 0.04);
  display: flex;
  flex-direction: column;
  gap: 16px;
}
.req-new-error {
  background: var(--tw-red-50);
  color: var(--tw-red-700);
  padding: 12px;
  border-radius: 4px;
  font-size: 13px;
}
.req-new-field {
  display: flex;
  flex-direction: column;
}
.req-new-label {
  display: block;
  font-size: 13px;
  font-weight: 500;
  color: var(--color-text, #374151);
  margin-bottom: 4px;
}
.req-new-hint {
  margin-top: 4px;
  font-size: 12px;
  color: var(--color-text-muted, #6b7280);
}
.req-new-hint-error {
  color: var(--tw-red-700);
}
.req-new-inline-link {
  color: var(--tw-blue-600);
  text-decoration: underline;
}
.req-new-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 16px;
}
.req-new-select {
  width: 100%;
}
.req-new-drop {
  border: 1px dashed var(--color-border, #d1d5db);
  border-radius: 8px;
  padding: 16px;
  text-align: center;
  font-size: 13px;
  color: var(--color-text-muted, #6b7280);
  cursor: pointer;
  transition: all 0.15s ease;
}
.req-new-drop:hover {
  border-color: var(--tw-blue-400);
  background: rgba(239, 246, 255, 0.4);
}
.req-new-files {
  margin-top: 8px;
  display: flex;
  flex-direction: column;
  gap: 4px;
  list-style: none;
  padding: 0;
}
.req-new-file {
  display: flex;
  align-items: center;
  justify-content: space-between;
  font-size: 12px;
  color: var(--tw-gray-600);
  background: var(--tw-gray-50);
  border-radius: 4px;
  padding: 4px 8px;
}
.req-new-file-name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  flex: 1;
  min-width: 0;
}
.req-new-file-size {
  color: var(--tw-gray-400);
}
.req-new-file-remove {
  background: transparent;
  border: none;
  color: var(--tw-gray-400);
  cursor: pointer;
  font-size: 14px;
  line-height: 1;
  padding: 0 4px;
  margin-left: 8px;
}
.req-new-file-remove:hover {
  color: var(--tw-red-500);
}
.req-new-actions {
  display: flex;
  gap: 8px;
  padding-top: 16px;
}
</style>