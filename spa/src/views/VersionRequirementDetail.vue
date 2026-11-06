<script setup lang="ts">
/* 功能: 版本下需求详情壳 — 完整镜像 Next.js src/app/[projectId]/[versionId]/
   requirements/[id]/page.tsx 的 redirect 行为. Next.js 该页面本身无 UI, 只是
   「跳到全局需求点详情」壳:

     const { id } = await params;
     redirect(`/requirements/${id}`);

   SPA 适配:
     - 路由: hash 模式 → #/[projectId]/[versionId]/requirements/[id]
       (1:1 镜像 Next.js URL 形态).
     - 跳转目标: /requirements/[id] (?project_id + ?version_id 携带版本上下文,
       与 R16 RequirementDetail URL ?project_id=&version_id= 同款).
     - 用 router.replace: redirect 是「直达链」, 不该让中间壳入历史栈
       (浏览器后退不会回到空壳).
     - hideInTabs=true: redirect 一次完成, 不需要 keep-alive 缓存
       (与 R24 ProjectDetail 同款).

   关注点:
     - Next.js 忽略 projectId/versionId (只读 id), 我们镜像这点 → 这两个 param
       只用于语义编码 + 携带 query context, 不发请求.
     - 跳转用 router.replace 在 nextTick 之后触发, 避免在 setup 同步阶段直接
       改导航导致 Vue Router 警告 (replace 在 nextTick 之后是 SPA 友好做法). */
import { computed, nextTick } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { useI18n } from 'vue-i18n';
import Loading from '@/components/Loading.vue';

/* ------------------------------------------------------------------ */
/*  Route                                                              */
/* ------------------------------------------------------------------ */

const route = useRoute();
const router = useRouter();
// i18n (W3c A2): 用户可见字符串走 t('requirements.version.reqDetail.*').
const { t } = useI18n();

/** 路由参数 :id (Next.js [id] 1:1 镜像). 强转 string 兜底
    (Vue Router 4 params 类型推断为 string | string[]). */
const requirementId = computed(() => String(route.params.id));

/** 镜像 Next.js URL 形态, 把版本上下文 (?project_id + ?version_id) 透传到
    目标页. URL 编码防注入: project_id/version_id 是 UUID, 实际无歧义字符,
    encodeURIComponent 是防御性兜底 (与 R24/R15 同款). */
const targetPath = computed(() => {
  const parts: string[] = [`/requirements/${requirementId.value}`];
  const qs: string[] = [];
  const p = route.params.projectId;
  const v = route.params.versionId;
  if (p) qs.push(`project_id=${encodeURIComponent(String(p))}`);
  if (v) qs.push(`version_id=${encodeURIComponent(String(v))}`);
  if (qs.length > 0) parts.push('?' + qs.join('&'));
  return parts.join('');
});

/* ------------------------------------------------------------------ */
/*  Actions                                                            */
/* ------------------------------------------------------------------ */

/** 主流程: router.replace 到 /requirements/[id] (带版本上下文). 镜像
    Next.js line 9 redirect(`/requirements/${id}`) 1:1. */
function doRedirect(): void {
  void router.replace(targetPath.value);
}

/* ------------------------------------------------------------------ */
/*  Lifecycle                                                          */
/* ------------------------------------------------------------------ */

/** nextTick 让组件先挂载, 再发起 replace — 避免 setup 同步阶段直接
    改导航时 Vue Router 警告 "Navigating to current location" / 渲染未挂载. */
nextTick(() => {
  doRedirect();
});
</script>

<template>
  <div class="version-requirement-detail">
    <!-- 占位: 在 redirect 完成前不让用户看到空帧. 镜像 R24 ProjectDetail 同款
         loading 态, 1:1 视觉. -->
    <div class="state-block">
      <Loading size="lg" :label="t('requirements.version.reqDetail.loading')" />
      <p class="state-text muted">{{ t('requirements.version.reqDetail.redirecting') }}</p>
    </div>
  </div>
</template>

<style scoped>
.version-requirement-detail {
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
</style>
