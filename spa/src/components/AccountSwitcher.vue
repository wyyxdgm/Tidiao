<script setup lang="ts">
/* 功能: 账号切换下拉 — 镜像 master `src/components/AccountSwitcher.tsx` 三态.
   三个 variant:
     - header (默认, AppHeader 右上角小头像): 单击 trigger 切换 dropdown
     - sidebar (ProjectSidebar 底部账号区): 显示 email + ▾, hover/单击 trigger 切换
     - sidebar-collapsed: 暂未接入
   dropdown 内容一致 (与 master AccountSwitcher.tsx 同款):
     - 当前账号 (高亮, 不可点)
     - 切换账号: 列出 localStorage recent-accounts (排除当前 email)
     - 每行右侧 × 按钮移除某条
     - 底部「+ 登录其他账号」链接 → /login
     - 「退出登录」按钮 → 调 auth.logout + 跳 /login
   切换走 `POST /api/auth/switch {email, token}` (master route.ts 已存在),
   成功 → hardNavigate('/#/') 整页重载 (hash 路由下仅 hash 变化的 href 赋值
   不触发重载, 必须 reload 才能清掉旧账号的 pinia / keep-alive 状态).

   关注点:
   - SPA 用 createWebHashHistory (router/index.ts:379), URL 形如 /#/path.
     window.location.href 必须带 /#/ 前缀才能命中对应路由, 否则 hash 不变.
   - dropdown 用 `<Teleport to="body">` + fixed 定位, 浮在 header / sidebar 之上.
     master R29 H 列硬约束: dropdown 必须浮在最顶层. SPA 侧栏也有 overflow-hidden,
     不 teleport 会被切.
   - 切账号 / 退出 触发整页跳 (window.location.href), 不用 router.push —— 新
     cookie 必须硬刷才生效, 与 LoginView 走硬导航同款 (R3-mirror).
   - 401 (token 失效) → removeRecentAccount + 跳 /login (与 master 同款). */
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { useAuthStore } from '@/stores/auth';
import { switchAccount } from '@/api/auth';
import { hardNavigate } from '@/lib/hard-navigate';
import {
  getRecentAccounts,
  removeRecentAccount,
  type RecentAccount,
} from '@/lib/recent-accounts';

type Variant = 'header' | 'sidebar' | 'sidebar-collapsed';

const props = withDefaults(defineProps<{ variant?: Variant }>(), {
  variant: 'header',
});

const auth = useAuthStore();

const open = ref(false);
const busy = ref(false);
const accounts = ref<RecentAccount[]>([]);
// Teleport 渲染的 dropdown 容器 ref (用于 click-outside 检测).
const dropdownRef = ref<HTMLElement | null>(null);
// trigger (头像按钮) ref — 用于定位 dropdown + click-outside 检测.
const triggerRef = ref<HTMLElement | null>(null);
// hover 关闭定时器: mouseLeave trigger / dropdown 时延迟 150ms 关闭, 让鼠标
// 能从 trigger 移到 dropdown 中间不闪闭. re-enter trigger 或 dropdown 时
// cancelClose 把这个 timer 清掉.
const closeTimer = ref<ReturnType<typeof setTimeout> | null>(null);

// 下拉菜单位置: trigger 下方 + 4px 间距; 视口右侧溢出 → 左移. 视口下溢 → 翻转向上
// (对齐 trigger.bottom). 计算函数镜像 master computeDropdownPosition 的 SPA 简版.
const dropdownStyle = ref<{ top: string; left: string; width: string } | null>(null);

const currentEmail = computed<string | null>(() => auth.user?.email ?? null);

// dropdown 列表: 排除当前 email (master filter 同款).
const otherAccounts = computed<RecentAccount[]>(() => {
  const cur = currentEmail.value?.toLowerCase();
  return accounts.value.filter((a) => a.email !== cur);
});

function recomputePosition(): void {
  const el = triggerRef.value;
  if (!el) return;
  const rect = el.getBoundingClientRect();
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const MENU_WIDTH = 256;
  // 估算菜单高度 (header + body + footer, 实测 N=0 ≈ 226px):
  //   header  ~68 (padding 10+10 + current-row 28 + border 1)
  //   body    ~109 (padding 8+8 + section-label 22 + empty-hint 36 / N*account-row 38 + login-other 36)
  //   footer  ~47 (padding 6+6 + logout 34 + border 1)
  //   合计 ≈ 224, 旧公式 60+N*40+80 估 140 偏低 84px —— trigger 在视口底部时
  //   倒着摆 (top = rect.bottom - menuHeight), dropdown 实际高超出预估, bottom
  //   跌出视口被 overflow:hidden 切掉 footer. 上调到 230 + N*38 兜底.
  const N = otherAccounts.value.length;
  const menuHeight = Math.min(vh * 0.8, 230 + N * 38);
  const distToBottom = vh - rect.bottom;
  const MENU_GAP = 4;
  // 视口下方放得下 → top = bottom + 4; 否则 → 翻转向上, bottom 对齐 trigger.bottom.
  const canDown = distToBottom >= menuHeight + 16;
  let top = canDown
    ? rect.bottom + MENU_GAP
    : Math.max(8, rect.bottom - menuHeight);
  // 兜底 clamp: 即便按 menuHeight 估算的 top + 实际 menuHeight 仍超出 vh-8
  // (理论上 menuHeight 已经 ≥ 实际, 但留 8px 边距), 把 top 拉到 vh - menuHeight - 8
  // 兜底. 防止 trigger 紧贴视口底时 dropdown 底部再被切.
  const maxTop = vh - menuHeight - 8;
  if (top > maxTop) top = Math.max(8, maxTop);
  // left 默认相对 trigger.right, 视口右溢出 → 左移留 8px 边距.
  const desiredLeft = rect.right;
  const overflow = desiredLeft + MENU_WIDTH + 8 - vw;
  const left = overflow > 0 ? desiredLeft - overflow : desiredLeft;
  dropdownStyle.value = {
    top: `${top}px`,
    left: `${left}px`,
    width: `${MENU_WIDTH}px`,
  };
}

watch(open, async (isOpen) => {
  if (isOpen) {
    accounts.value = getRecentAccounts();
    // nextTick 等 template 渲染 dropdownStyle 应用到 DOM 再算位置 (虽然 trigger 早就
    // 在 DOM 里, 但 reset 时 dropdownStyle 可能是 null — 重新算一次).
    recomputePosition();
    // Post-mount 重定位: 用 dropdown 真实高度替代 estimate menuHeight. estimate
    // 偏差 (230+N*38 vs 实测 206+N*38 for N=0 差 24) 让 top 算高, dropdown.bottom
    // 离 trigger.bottom 留 24px 空隙. 实测后:
    //   - canDown: top = rect.bottom (flush 下边对齐, 无 gap)
    //   - 翻转:  top = rect.bottom - actual (bottom-aligned, 无 gap)
    // 兜底 clamp (top > vh - actual - 8) 防极小视口 footer 被切.
    await nextTick();
    const dd = dropdownRef.value;
    const trigger = triggerRef.value;
    if (dd && trigger) {
      const actual = dd.getBoundingClientRect().height;
      const rect = trigger.getBoundingClientRect();
      const distToBottom = window.innerHeight - rect.bottom;
      const cur = dropdownStyle.value;
      if (cur) {
        let newTop = distToBottom >= actual + 16
          ? rect.bottom                     // flush below trigger
          : Math.max(8, rect.bottom - actual); // bottom-aligned above
        const maxTop = window.innerHeight - actual - 8;
        if (newTop > maxTop) newTop = Math.max(8, maxTop);
        dropdownStyle.value = { ...cur, top: `${newTop}px` };
      }
    }
  } else {
    dropdownStyle.value = null;
  }
});

async function onPick(target: RecentAccount): Promise<void> {
  if (!currentEmail.value || busy.value) return;
  if (target.email === currentEmail.value.toLowerCase()) return;
  busy.value = true;
  try {
    const user = await switchAccount(target.email, target.token);
    // 切换成功: 更新 pinia 里的 user, 然后整页跳让 middleware 看到新 cookie.
    auth.user = user;
    auth.sessionState = 'yes';
    /* hash 模式必须带 /#/ 前缀; 且 hash 路由下仅 hash 变化的 href 赋值不会
       重载页面 (pinia / keep-alive 残留旧账号数据), hardNavigate 显式 reload
       保证全新会话. 直接指 /#/ 一步到位. */
    hardNavigate('/#/');
  } catch {
    // 401 / 400: token 失效或与 email 不匹配, 删 stale 条目 + 跳 /login 让用户重登.
    removeRecentAccount(target.email);
    accounts.value = getRecentAccounts();
    busy.value = false;
    // 静默跳 login (用户主动切换失败不应被弹窗打扰, master 同款 no-toast).
    hardNavigate('/#/login');
  }
}

async function onRemove(target: RecentAccount, e: Event): Promise<void> {
  e.stopPropagation();
  if (busy.value) return;
  removeRecentAccount(target.email);
  accounts.value = getRecentAccounts();
}

async function onLogout(): Promise<void> {
  if (busy.value) return;
  busy.value = true;
  // 主动登出: 仅移除当前账号, 保留其他 (与 master logout 同款 — 用户可继续切回).
  const cur = currentEmail.value;
  await auth.logout();
  if (cur) removeRecentAccount(cur);
  hardNavigate('/#/login');
}

// 「登录其他账号」只软跳 login 页 (LoginView 登录成功后会 hardNavigate 兜底
// 清状态); 若用户没登录又切回来, 本账号会话与 store 本来就该保留.
function onLoginOther(): void {
  window.location.href = '/#/login';
}

function openDropdown(): void {
  if (busy.value) return;
  cancelClose();
  open.value = true;
}

/** hover 关闭延迟: 让鼠标从 trigger 移到 dropdown 中途不闪闭.
   镜像 master AccountSwitcher.tsx 的 scheduleClose (150ms). */
function scheduleClose(): void {
  if (closeTimer.value) clearTimeout(closeTimer.value);
  closeTimer.value = setTimeout(() => {
    open.value = false;
    closeTimer.value = null;
  }, 150);
}

function cancelClose(): void {
  if (closeTimer.value) {
    clearTimeout(closeTimer.value);
    closeTimer.value = null;
  }
}

function toggle(e: MouseEvent): void {
  // 点击 trigger → 切换开关.
  e.stopPropagation();
  cancelClose();
  open.value = !open.value;
}

function onDocClick(e: MouseEvent): void {
  if (!open.value) return;
  const t = e.target as Node;
  // 点 trigger 或 dropdown 内部都不算 outside.
  if (triggerRef.value?.contains(t)) return;
  if (dropdownRef.value?.contains(t)) return;
  open.value = false;
}

function onKeydown(e: KeyboardEvent): void {
  if (!open.value) return;
  if (e.key === 'Escape') open.value = false;
}

onMounted(() => {
  document.addEventListener('mousedown', onDocClick);
  document.addEventListener('keydown', onKeydown);
  window.addEventListener('resize', recomputePosition);
});

onBeforeUnmount(() => {
  document.removeEventListener('mousedown', onDocClick);
  document.removeEventListener('keydown', onKeydown);
  window.removeEventListener('resize', recomputePosition);
  // 组件卸载兜底清掉残留关闭定时器, 防止 setTimeout 在卸载后引用 open.value 触发警告.
  if (closeTimer.value) {
    clearTimeout(closeTimer.value);
    closeTimer.value = null;
  }
});

function initial(email: string | null | undefined): string {
  return ((email ?? '?')[0] ?? '?').toUpperCase();
}

function relTime(ms: number): string {
  const diff = Date.now() - ms;
  const min = Math.floor(diff / 60000);
  if (min < 1) return '刚刚';
  if (min < 60) return `${min} 分钟前`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr} 小时前`;
  const day = Math.floor(hr / 24);
  if (day < 30) return `${day} 天前`;
  return new Date(ms).toLocaleDateString('zh-CN');
}
</script>

<template>
  <div class="account-switcher" :class="`variant-${props.variant}`">
    <!-- header variant: 小圆形头像按钮 (AppHeader 右上角) -->
    <button
      v-if="props.variant === 'header'"
      ref="triggerRef"
      type="button"
      class="avatar-btn"
      :title="currentEmail ?? ''"
      :aria-expanded="open"
      aria-haspopup="menu"
      :disabled="busy"
      @click="toggle"
    >
      <span class="avatar">{{ initial(currentEmail) }}</span>
    </button>

    <!-- sidebar variant: 整行可点 trigger — avatar + email + ▾
         (master AccountSwitcher.tsx:272-305 sidebar 变体样式).
         hover 整行变浅灰 + 直接弹 dropdown (镜像 master 鼠标 hover 行为);
         单击同样开 dropdown (触屏 / 键盘可达性); 离开 trigger 走 150ms
         scheduleClose, 让鼠标移到 dropdown 中途不闪闭. -->
    <button
      v-else-if="props.variant === 'sidebar'"
      ref="triggerRef"
      type="button"
      class="sidebar-trigger"
      :title="currentEmail ?? ''"
      :aria-expanded="open"
      aria-haspopup="menu"
      :disabled="busy"
      @click="toggle"
      @mouseenter="openDropdown"
      @mouseleave="scheduleClose"
    >
      <span class="avatar avatar-current">{{ initial(currentEmail) }}</span>
      <span class="sidebar-email" :title="currentEmail ?? ''">{{ currentEmail }}</span>
      <span class="sidebar-chevron" aria-hidden="true">{{ open ? '▴' : '▾' }}</span>
    </button>

    <!-- sidebar-collapsed variant: 折叠态用的小圆形头像 trigger (master
         AccountSwitcher.tsx sidebar-collapsed 变体槽位). 32x32 圆, 跟侧栏
         项目蓝圆头像对齐 (master 那边没明说但同款视觉密度). -->
    <button
      v-else-if="props.variant === 'sidebar-collapsed'"
      ref="triggerRef"
      type="button"
      class="collapsed-trigger"
      :title="currentEmail ?? ''"
      :aria-expanded="open"
      aria-haspopup="menu"
      :disabled="busy"
      @click="toggle"
      @mouseenter="openDropdown"
      @mouseleave="scheduleClose"
    >
      <span class="avatar avatar-current">{{ initial(currentEmail) }}</span>
    </button>

    <Teleport to="body" :disabled="!open">
      <div
        v-if="open && dropdownStyle"
        ref="dropdownRef"
        class="dropdown"
        :style="dropdownStyle"
        role="menu"
        @mouseenter="cancelClose"
        @mouseleave="scheduleClose"
      >
        <!-- 当前账号区 -->
        <div class="dropdown-header">
          <div class="dropdown-section-label">当前账号</div>
          <div class="current-row">
            <span class="avatar avatar-current">{{ initial(currentEmail) }}</span>
            <span class="current-email" :title="currentEmail ?? ''">{{ currentEmail }}</span>
          </div>
        </div>

        <!-- 切换账号列表 -->
        <div class="dropdown-body">
          <div class="dropdown-section-label">切换账号</div>
          <div v-if="otherAccounts.length === 0" class="empty-hint">
            暂无其他已登录账号
          </div>
          <button
            v-for="acc in otherAccounts"
            :key="acc.email"
            type="button"
            class="account-row"
            :disabled="busy"
            @click="onPick(acc)"
          >
            <span class="avatar avatar-other">{{ initial(acc.email) }}</span>
            <div class="account-info">
              <span class="account-email" :title="acc.email">{{ acc.email }}</span>
              <span class="account-time">{{ relTime(acc.addedAt) }}</span>
            </div>
            <span
              class="remove-btn"
              role="button"
              tabindex="0"
              :aria-label="`移除 ${acc.email}`"
              @click="(e) => onRemove(acc, e)"
              @keydown.enter="(e) => onRemove(acc, e as unknown as Event)"
              @keydown.space.prevent="(e) => onRemove(acc, e as unknown as Event)"
              >×</span
            >
          </button>

          <button
            type="button"
            class="login-other"
            :disabled="busy"
            @click="onLoginOther"
          >
            ＋ 登录其他账号
          </button>
        </div>

        <!-- 退出登录 -->
        <div class="dropdown-footer">
          <button
            type="button"
            class="logout-btn"
            :disabled="busy"
            @click="onLogout"
          >
            退出登录
          </button>
        </div>
      </div>
    </Teleport>
  </div>
</template>

<style scoped>
.account-switcher {
  position: relative;
  display: inline-flex;
  align-items: center;
}
/* sidebar variant 占满父容器宽度 (侧栏底部账号区), 让整行都是 trigger. */
.account-switcher.variant-sidebar {
  display: flex;
  width: 100%;
}

/* --- Trigger: header variant (圆形头像按钮) --------------------------- */
.avatar-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 30px;
  height: 30px;
  border: 1px solid var(--color-border);
  background: var(--color-bg);
  border-radius: 50%;
  padding: 0;
  cursor: pointer;
  transition: background 0.15s;
}
.avatar-btn:hover:not(:disabled) {
  background: var(--tw-gray-200);
}
.avatar-btn:disabled {
  cursor: wait;
  opacity: 0.6;
}

/* --- Trigger: sidebar variant (整行 trigger, master AccountSwitcher.tsx:272-305) */
.sidebar-trigger {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 6px 8px;
  background: transparent;
  border: 0;
  border-radius: 4px;
  cursor: pointer;
  font: inherit;
  color: inherit;
  text-align: left;
  transition: background 0.15s;
}
.sidebar-trigger:hover:not(:disabled) {
  background: var(--tw-gray-100);
}
.sidebar-trigger:disabled {
  cursor: wait;
  opacity: 0.6;
}
.sidebar-email {
  flex: 1;
  font-size: 13px;
  color: var(--color-text);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  min-width: 0;
}
.sidebar-chevron {
  font-size: 11px;
  color: var(--color-text-muted);
  flex-shrink: 0;
}
/* --- Trigger: sidebar-collapsed variant (R56-B14) ----------------------- */
/* 折叠态下的小圆头像 — 32x32 跟侧栏项目蓝圆头像对齐, 但用主色 (slate/gray)
   区分「账号」和「项目」. hover 浅灰同 sidebar variant. */
.collapsed-trigger {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 32px;
  height: 32px;
  border-radius: 50%;
  border: 1px solid var(--color-border);
  background: var(--color-bg);
  padding: 0;
  cursor: pointer;
  transition: background-color 0.15s ease;
}
.collapsed-trigger:hover:not(:disabled) {
  background: var(--tw-gray-200);
}
.collapsed-trigger:disabled {
  cursor: wait;
  opacity: 0.6;
}
.avatar {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 30px;
  height: 30px;
  border-radius: 50%;
  font-size: 12px;
  font-weight: 600;
  background: var(--tw-gray-200);
  color: var(--tw-gray-700);
  flex-shrink: 0;
}
.avatar-current {
  /* sidebar 变体 trigger 也用 current 头像样式, 灰底灰字 (master AccountSwitcher.tsx: 294
     sidebar 头像 bg-gray-200 / text-gray-600), 跟 dropdown 内当前账号头像颜色一致. */
  background: var(--tw-gray-200);
  color: var(--tw-gray-600);
}
.avatar-other {
  background: var(--tw-gray-100);
  color: var(--tw-gray-600);
}

/* --- Dropdown (Teleport 到 body) ---------------------------------------- */
.dropdown {
  position: fixed;
  z-index: 9999;
  background: var(--color-bg-elevated);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  box-shadow: var(--shadow-md);
  max-height: 80vh;
  overflow: hidden;
  display: flex;
  flex-direction: column;
}

.dropdown-header {
  padding: 10px 12px;
  border-bottom: 1px solid var(--color-border);
}
.dropdown-section-label {
  font-size: 10px;
  font-weight: 600;
  color: var(--color-text-muted);
  text-transform: uppercase;
  letter-spacing: 0.05em;
  margin-bottom: 6px;
  /* R49: 对齐 master AccountSwitcher.tsx:343/357 px-3 (=12px). 之前无 padding →
     「切换账号」4 个字直接顶到 dropdown 左边, 跟 header 里「当前账号」(12px padding)
     视觉错位; 同时与下方 account-row / login-other (都自带 12px padding) 不对齐.
     加 12px 左右 padding 让三个 section-label 与各子行左边 12px 对齐. */
  padding: 0 12px;
}
.current-row {
  display: flex;
  align-items: center;
  gap: 8px;
}
.current-email {
  font-size: 13px;
  color: var(--color-text);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.dropdown-body {
  padding: 8px 0;
  max-height: 256px;
  overflow-y: auto;
}
.empty-hint {
  padding: 10px 12px;
  font-size: 12px;
  color: var(--color-text-muted);
}

.account-row {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 6px 12px;
  background: transparent;
  border: 0;
  text-align: left;
  cursor: pointer;
  font: inherit;
  color: inherit;
  transition: background 0.1s;
}
.account-row:hover:not(:disabled) {
  background: var(--tw-gray-50);
}
.account-row:disabled {
  cursor: wait;
  opacity: 0.5;
}
.account-info {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.account-email {
  font-size: 13px;
  color: var(--color-text);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.account-time {
  font-size: 11px;
  color: var(--color-text-muted);
}
.remove-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 20px;
  height: 20px;
  border-radius: 50%;
  font-size: 14px;
  color: var(--color-text-muted);
  cursor: pointer;
  user-select: none;
  transition: background 0.1s;
}
.remove-btn:hover {
  background: var(--tw-red-100);
  color: var(--color-danger);
}

.login-other {
  display: block;
  width: 100%;
  padding: 6px 12px;
  margin-top: 4px;
  background: transparent;
  border: 0;
  text-align: left;
  cursor: pointer;
  font-size: 13px;
  color: var(--color-primary);
}
.login-other:hover:not(:disabled) {
  background: var(--tw-gray-50);
}

.dropdown-footer {
  padding: 6px 0;
  border-top: 1px solid var(--color-border);
}
.logout-btn {
  display: block;
  width: 100%;
  padding: 8px 12px;
  background: transparent;
  border: 0;
  text-align: left;
  cursor: pointer;
  font-size: 13px;
  color: var(--color-text);
}
.logout-btn:hover:not(:disabled) {
  background: var(--tw-gray-50);
}
</style>