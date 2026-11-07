import { watch, createApp } from 'vue';
import { createPinia } from 'pinia';
import App from './App.vue';
import { router } from './router';
import { i18n, getLang } from './i18n';
import { applyInstanceTitle } from './lib/instance-title';
import { initTheme } from './lib/theme';
import './assets/theme-vars.css';
import './assets/main.css';

// R193: 按访问入口给 title 加实例标识, 2026-10-25 拍板格式 提调（mac/air/wsl/dev/pulu）, 便于多实例混开时区分。
// 2026-11-07 i18n 接入: title + <html lang> 跟随语言实时重算 (LangToggle / Settings 切语言即生效)。
applyInstanceTitle();
watch(getLang, applyInstanceTitle);

// R206: 应用主题偏好 (深色/浅色/随系统). index.html 内联脚本已先落一次防闪, 此处接管监听.
initTheme();

const app = createApp(App);
app.use(createPinia());
app.use(i18n);
app.use(router);
app.mount('#app');