import { createApp } from 'vue';
import { createPinia } from 'pinia';
import App from './App.vue';
import { router } from './router';
import { i18n } from './i18n';
import { instanceTitle } from './lib/instance-title';
import { initTheme } from './lib/theme';
import './assets/theme-vars.css';
import './assets/main.css';

// R193: 按访问入口给 title 加实例标识, 2026-10-25 拍板格式 提调（mac/air/wsl/dev/pulu）, 便于多实例混开时区分。
document.title = instanceTitle(location.hostname, location.port);

// R206: 应用主题偏好 (深色/浅色/随系统). index.html 内联脚本已先落一次防闪, 此处接管监听.
initTheme();

const app = createApp(App);
app.use(createPinia());
app.use(i18n);
app.use(router);
app.mount('#app');