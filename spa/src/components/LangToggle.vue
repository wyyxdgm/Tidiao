<script setup lang="ts">
// 功能: 语言切换按钮 — zh-CN / en-US 循环切换, 偏好由 i18n/index.ts 持久化 (localStorage tidiao-lang).
// 关注点: label 计算属性读 i18n.global.locale (ref), 切换后自动更新; floating 模式用于
//   登录/注册等无 AppHeader 的独立页 (固定右上角).
import { computed } from 'vue';
import { getLang, setLang, SUPPORTED_LANGS } from '@/i18n';

const props = defineProps<{ floating?: boolean }>();

const label = computed(() => (getLang() === 'zh-CN' ? 'EN' : '中文'));
const title = computed(() =>
  getLang() === 'zh-CN' ? 'Switch to English' : '切换到中文',
);

function toggle() {
  const i = SUPPORTED_LANGS.indexOf(getLang());
  setLang(SUPPORTED_LANGS[(i + 1) % SUPPORTED_LANGS.length]!);
}
</script>

<template>
  <button
    type="button"
    :class="['lang-toggle', { 'lang-toggle--floating': props.floating }]"
    :title="title"
    :aria-label="title"
    @click="toggle"
  >
    {{ label }}
  </button>
</template>

<style scoped>
.lang-toggle {
  border: 0;
  background: transparent;
  padding: 4px 8px;
  cursor: pointer;
  color: var(--color-text-muted);
  font-size: 12px;
  font-weight: 600;
  border-radius: 6px;
  transition: background 0.12s, color 0.12s;
}
.lang-toggle:hover {
  background: var(--color-bg, #f3f4f6);
  color: var(--color-text);
}
/* auth 独立页 (登录/注册, 无 AppHeader) 用固定右上角浮层 */
.lang-toggle--floating {
  position: fixed;
  top: 14px;
  right: 14px;
  z-index: 10;
}
</style>
