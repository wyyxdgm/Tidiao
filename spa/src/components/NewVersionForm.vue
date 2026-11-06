<script setup lang="ts">
/* 功能: 新建版本表单 (含 AI 解析输入) — ProjectsView 内联展开 + ProjectDetailView
   接入共用 (飞书 R172 v513 + R172 迭代: 详情页 stub 换真表单).
   从 ProjectsView 迁移抽出, 防 AI 解析逻辑两处漂移.
   用法: <NewVersionForm :project-id="id" @created="onCreated" @cancel="onCancel" />
   关注点:
   - AI 解析: 粘自由文本 → POST /api/versions/ai-parse → 建议值填表单 (不落库),
     确定性解析 (URL 抽取 + sheet id→name) 优先于 LLM; AI 不可用降级纯确定性.
   - 创建成功后若项目无 current_version_id, 自动 PATCH 设为当前版本 (master
     projects-client.tsx:426-436 同口径), 再 emit created.
   - 失败: HTTP 非 2xx toast 报错 (name 重复 / 数据校验等), 表单不关可改完重试. */
import { ref } from 'vue';
import {
  aiParseVersion,
  createVersion,
  updateProject as apiUpdateProject,
  type Version,
  type VersionSuggestion,
} from '@/api/projects';
import { isHttpError } from '@/api/http';
import { useProjectsStore } from '@/stores/projects';
import { useToast } from '@/composables/useToast';
import Button from '@/components/Button.vue';
import Input from '@/components/Input.vue';
import Textarea from '@/components/Textarea.vue';
import Checkbox from '@/components/Checkbox.vue';

const props = defineProps<{ projectId: string }>();
const emit = defineEmits<{
  (e: 'created', v: Version): void;
  (e: 'cancel'): void;
}>();

const toast = useToast();
const projectsStore = useProjectsStore();

const newName = ref('');
const newDescription = ref('');
const newUrl = ref('');
const newSheet = ref('');
const newEnable = ref(true);
const aiText = ref('');
const aiLoading = ref(false);
/** 字段来源徽标 (ai / id-mapped / text), 空 = 手动填. */
const sources = ref<VersionSuggestion['sources'] | null>(null);

/** 来源徽标文案 —— 让用户一眼看出哪些字段是 AI/确定性解析填的. */
function aiSourceHint(s: NonNullable<typeof sources.value>): string {
  const parts: string[] = [];
  if (s.name === 'ai') parts.push('版本名 AI 生成');
  if (s.description === 'ai') parts.push('描述 AI 生成');
  if (s.feishu_url === 'text') parts.push('URL 来自文本');
  if (s.feishu_sheet === 'id-mapped') parts.push('sheet id 已转 name');
  if (s.feishu_sheet === 'ai') parts.push('sheet AI 选取');
  return parts.length ? `已填入: ${parts.join('、')}` : '未识别出可用信息';
}

/** AI 解析输入 → 后端解析 → 建议值填表单. 只填后端返回了建议的字段. */
async function aiFill(): Promise<void> {
  if (!aiText.value.trim()) {
    toast.error('请先粘贴要解析的文本');
    return;
  }
  aiLoading.value = true;
  try {
    const { suggestion, llmFailed } = await aiParseVersion(props.projectId, aiText.value);
    if (suggestion.name) newName.value = suggestion.name;
    if (suggestion.description) newDescription.value = suggestion.description;
    if (suggestion.feishu_url) newUrl.value = suggestion.feishu_url;
    if (suggestion.feishu_sheet) newSheet.value = suggestion.feishu_sheet;
    sources.value = suggestion.sources;
    if (llmFailed) {
      toast.info('AI 暂不可用，已填入可直接解析的部分（URL / sheet）');
    } else {
      toast.success('已按解析结果填入表单，可手动调整后保存');
    }
  } catch (e: unknown) {
    if (isHttpError(e)) {
      toast.error(`AI 解析失败: ${e.message}`);
    } else {
      toast.error('AI 解析失败');
    }
  } finally {
    aiLoading.value = false;
  }
}

/** POST /api/versions 提交. 首个版本自动设当前版本. */
async function submit(): Promise<void> {
  if (!newName.value.trim()) {
    toast.error('请填写版本名');
    return;
  }
  try {
    const v = await createVersion({
      project_id: props.projectId,
      name: newName.value.trim(),
      description: newDescription.value.trim() || undefined,
      feishu_url: newUrl.value.trim() || undefined,
      feishu_sheet: newSheet.value.trim() || undefined,
      enable: newEnable.value,
    });
    // 首个版本自动设当前版本 (master line 426-436).
    const proj = projectsStore.projects.find((x) => x.id === props.projectId);
    if (proj && !proj.current_version_id) {
      await apiUpdateProject(props.projectId, { current_version_id: v.id });
    }
    toast.success(`版本「${v.name}」已创建`);
    emit('created', v);
  } catch (e: unknown) {
    if (isHttpError(e)) {
      toast.error(`创建版本失败: ${e.message}`);
    } else {
      toast.error('创建版本失败');
    }
  }
}
</script>

<template>
  <div class="version-new">
    <!-- v513 (飞书 R172): AI 解析输入 —— 粘 URL / sheet 名或 id / 版本用途, 一键填表单 -->
    <div class="version-new-row version-new-ai">
      <Textarea
        v-model="aiText"
        :rows="2"
        placeholder="AI 解析：粘贴飞书 sheet URL / sheet 名或 id / 版本用途描述…（可留空手动填）"
        class-name="version-new-ai-text"
      />
      <Button size="sm" variant="secondary" :disabled="aiLoading" @click="aiFill">
        {{ aiLoading ? '解析中…' : 'AI 解析填表' }}
      </Button>
    </div>
    <div class="version-new-row">
      <Input
        v-model="newName"
        placeholder="版本名（如 v1.7）"
        class-name="version-new-name"
      />
      <Button size="sm" @click="submit">创建</Button>
      <Button size="sm" variant="secondary" @click="emit('cancel')">取消</Button>
    </div>
    <div class="version-new-row">
      <Input
        v-model="newDescription"
        placeholder="版本干啥的（可选，AI 可自动生成）"
        class-name="version-new-desc"
      />
    </div>
    <div class="version-new-row">
      <Input
        v-model="newUrl"
        placeholder="飞书 sheet URL（可选）"
        class-name="version-new-url"
      />
      <Input
        v-model="newSheet"
        placeholder="Sheet 名或 id（可选）"
        class-name="version-new-sheet"
      />
    </div>
    <div class="version-new-row">
      <Checkbox v-model="newEnable" label="开启自动派发" />
      <span v-if="sources" class="muted version-edit-hint">
        {{ aiSourceHint(sources) }}
      </span>
    </div>
  </div>
</template>

<style scoped>
.version-new {
  background: var(--tw-blue-50);
  border-radius: var(--radius);
  padding: 8px;
  margin-top: 6px;
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.version-new-row {
  display: flex;
  gap: 6px;
  align-items: center;
}
.version-new-ai {
  align-items: stretch;
}
:deep(.version-new-ai-text) {
  flex: 1;
}
:deep(.version-new-name) {
  flex: 1;
}
:deep(.version-new-desc) {
  flex: 1;
}
:deep(.version-new-url) {
  flex: 1;
}
:deep(.version-new-sheet) {
  width: 110px;
}
</style>
