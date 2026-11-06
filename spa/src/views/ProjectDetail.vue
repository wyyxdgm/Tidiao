<script setup lang="ts">
/* 功能: 项目详情入口 — 原镜像 Next.js /[projectId] 307 redirect (跳当前版本);
   R177 起改跳「任务画布总控制台」(#/{projectId}/console, damo 拍板画布替代
   项目 Board 作为门面). 流程:
     1. project 存在 → replace(`/${id}/console`) — 有无版本都跳, 画布是项目级
        全景, 不依赖版本.
     2. project 不存在 → ErrorView (404 "项目不存在"; 401/403 "无权限").

   SPA 适配:
     - 路由: hash 模式 → #/[projectId] (1:1 镜像 Next.js URL).
     - 老看板不删: 版本看板 /:projectId/:versionId 与任务看板
       /:projectId/unversioned 全保留, 画布顶部「📋 任务」一键可达.

   关注点:
     - 用 router.replace: redirect 是直达链, 不该让中间页入历史栈.
     - hideInTabs=true: redirect 一次完成, 不需要 keep-alive 缓存 (与 R15/R23 同款).
     - 与 R17 ProjectDetailView.vue 共存: /projects/:projectId 走丰富 UI (元数据 +
       版本列表), /:projectId 走 redirect-only. 两 URL 不同语义.
     - admin / 非 admin 鉴权: SPA 走 /api/projects/[id], 后端自动按 owner_id
       过滤 (R17 已验证). 401/403 走 ErrorView; 404 → "项目不存在".
     - 历史行为 (跳 /projects/[id]/versions/[current]) 回滚: git reset 本
       commit -- spa/src/views/ProjectDetail.vue.
     - i18n (W4b): 用户可见文案走 t('residual.projectRedirect.*'). */
import { computed, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { useI18n } from 'vue-i18n';
import { get, HttpError } from '@/api/http';
import ErrorView from '@/components/ErrorView.vue';
import Loading from '@/components/Loading.vue';
import { useToastStore } from '@/stores/toast';

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

/** /api/projects/[id] 响应投影. 字段集对齐 master src/lib/db/projects.ts Project. */
interface Project {
  id: string;
  name: string;
  description: string | null;
  cwd: string | null;
  ports: number[] | string | null;
  owner_id?: string | null;
  current_version_id?: string | null;
  created_at: number;
}

/* ------------------------------------------------------------------ */
/*  Route + stores                                                     */
/* ------------------------------------------------------------------ */

const route = useRoute();
const router = useRouter();
const toast = useToastStore();
const { t } = useI18n();

/** 路由参数 :projectId (Next.js [projectId] 1:1 镜像). 强转 string 兜底
    (Vue Router 4 params 类型推断为 string | string[]). */
const projectId = computed(() => String(route.params.projectId));

/* ------------------------------------------------------------------ */
/*  State                                                              */
/* ------------------------------------------------------------------ */

const loading = ref(true);
/** 用户可见错误: 404 → "项目不存在"; 401/403 → "无权限"; 其他 → message/兜底. */
const error = ref<string | null>(null);

/* ------------------------------------------------------------------ */
/*  Actions                                                            */
/* ------------------------------------------------------------------ */

/** 返回项目列表 (ErrorView 无 retry 时唯一的逃生口). */
function goProjects(): void {
  void router.push('/projects');
}

/** 主流程: 拿 project → replace 到画布总控制台 (R177). */
async function redirect(): Promise<void> {
  loading.value = true;
  error.value = null;
  try {
    // GET /api/projects/[id] — 校验项目存在/可见 (admin 跨用户 / 非 admin
    // 按 owner_id 过滤, 后端自动处理, SPA 端无需传 ownerId).
    const data = await get<{ project: Project }>(`/api/projects/${projectId.value}`);
    const project = data.project;

    // R177: 画布替代版本看板作项目门面 — 有无版本都跳画布.
    void router.replace(`/${project.id}/console`);
  } catch (e: unknown) {
    if (e instanceof HttpError) {
      if (e.status === 404) {
        // Next.js 跳 /?error=project_not_found; SPA 跳 /projects + toast.
        error.value = t('residual.projectRedirect.errNotFound');
      } else if (e.status === 401 || e.status === 403) {
        error.value = t('residual.projectRedirect.errForbidden');
      } else {
        error.value = e.message || t('residual.projectRedirect.errHttp', { status: e.status });
      }
    } else if (e instanceof Error) {
      error.value = t('residual.projectRedirect.errNetwork', { msg: e.message });
    } else {
      error.value = t('residual.projectRedirect.errGeneric');
    }
  } finally {
    loading.value = false;
  }
}

/* ------------------------------------------------------------------ */
/*  Lifecycle                                                          */
/* ------------------------------------------------------------------ */

/** 监听路由参数: 用户从子页 (e.g. /projects/abc/versions/xyz) 回到本路由,
    或直接键入另一个 projectId 时, Vue 可能不重新挂载组件 (hideInTabs 已
    阻止 keep-alive, 但路由 param 变化时仍需重跑 redirect). immediate:true
    让首次进入也走 watch 路径, 不依赖 onMounted (挂载时机对 SPA router 不可靠). */
watch(
  () => route.params.projectId,
  () => {
    void redirect();
  },
  { immediate: true },
);
</script>

<template>
  <div class="project-detail">
    <!-- loading: 在 redirect 完成前占位, 不让用户看到空帧. -->
    <div v-if="loading" class="state-block">
      <Loading size="lg" :label="t('residual.projectRedirect.loadingLabel')" />
      <p class="state-text muted">{{ t('residual.projectRedirect.loading') }}</p>
    </div>

    <!-- 错误态: 404 / 401 / 403 / 网络异常等. show-retry=false 因 retry
         会再次跑同样 404, 没意义; 给"返回项目列表"按钮作逃生口. -->
    <ErrorView
      v-else-if="error"
      :title="t('residual.projectRedirect.loadFailedTitle')"
      :description="error"
      variant="error"
      :show-retry="false"
    >
      <button type="button" class="action-btn" @click="goProjects">
        {{ t('residual.projectRedirect.backToProjects') }}
      </button>
    </ErrorView>
  </div>
</template>

<style scoped>
.project-detail {
  padding: 18px;
  max-width: 960px;
  margin: 0 auto;
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.state-block {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
  padding: 32px 16px;
}
.state-text {
  margin: 0;
  font-size: 13px;
}
.muted {
  color: var(--color-text-muted);
}

/* "返回项目列表"按钮: 不引 R7 Button 避免给 redirect 页加视觉重量, 简单原生按钮足够. */
.action-btn {
  margin-top: 12px;
  padding: 7px 16px;
  background: var(--color-primary);
  color: #fff;
  border: none;
  border-radius: var(--radius);
  cursor: pointer;
  font-size: 13px;
  line-height: 1.2;
}
.action-btn:hover {
  background: var(--color-primary-hover);
}
.action-btn:focus-visible {
  outline: none;
  box-shadow: 0 0 0 3px rgba(37, 99, 235, 0.25);
}
</style>