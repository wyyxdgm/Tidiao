<script setup lang="ts">
/* 渠道角色管理 UI (docs/plans/channel-role-ui.md D2): Settings「渠道」tab 面板.
   Channel config = 多渠道消息接入配置 (如一个 Telegram bot), 绑定 project +
   可选默认 role (intake 首 task 挂载). secret 只写不读 (has_secret 显示). */
import { computed, onMounted, onUnmounted, reactive, ref, watch } from 'vue';
import Button from '@/components/Button.vue';
import Input from '@/components/Input.vue';
import Select from '@/components/Select.vue';
import Checkbox from '@/components/Checkbox.vue';
import Modal from '@/components/Modal.vue';
import Loading from '@/components/Loading.vue';
import Empty from '@/components/Empty.vue';
import ErrorView from '@/components/ErrorView.vue';
import { useToast } from '@/composables/useToast';
import { useConfirm } from '@/components/ConfirmDialog.vue';
import {
  listChannels,
  createChannel,
  updateChannel,
  deleteChannel,
  getBindQr,
  weixinQrLogin,
  weixinQrLoginStatus,
  type BindQr,
  type ChannelConfig,
} from '@/api/channels';
import { listRoles, type Role } from '@/api/roles';
import { listProjects, listVersions, type Project, type Version } from '@/api/projects';

const toast = useToast();
const { confirm } = useConfirm();

/* 渠道类型五值 (damo 2026-10-13 拍板三值解禁; 扫码绑定 D2 增 lark; D3 增 weixin):
   telegram / wecom / feishu / lark / weixin 五条 intake 线路均已落地消费
   channel_configs. openclaw 是外部智能体借道 intake_threads 的内部通道, 不是消息渠道,
   不出现. 编辑已有行类型不可改 (渠道类型决定消费方协议, 改了线路断).
   weixin 渠道行凭据来自扫码登录 (顶部按钮), 手动新建需填 iLink JSON 凭据. */
const CHANNEL_TYPES = [
  { value: 'telegram', label: 'telegram' },
  { value: 'wecom', label: 'wecom' },
  { value: 'feishu', label: 'feishu' },
  { value: 'lark', label: 'lark' },
  { value: 'weixin', label: 'weixin' },
];

const channels = ref<ChannelConfig[]>([]);
const projects = ref<Project[]>([]);
const roles = ref<Role[]>([]);
/* 绑定版本下拉数据 (v529): 随表单选中项目懒加载, key = project id */
const versionsByProject = ref<Record<string, Version[]>>({});
const loading = ref<boolean>(true);
const error = ref<string>('');

const projectOptions = computed<{ value: string; label: string }[]>(() =>
  projects.value.map((p) => ({ value: p.id, label: p.name })),
);

/* 绑定版本选项 (v529): 空值 = 跟随项目 current_version; 项目切换后异步刷新 */
const versionOptions = computed<{ value: string; label: string }[]>(() => {
  const list = versionsByProject.value[draft.bound_project_id] ?? [];
  return list.map((v) => ({ value: v.id, label: v.name }));
});

async function loadVersions(projectId: string): Promise<void> {
  if (!projectId || versionsByProject.value[projectId]) return;
  try {
    const resp = await listVersions(projectId);
    versionsByProject.value = { ...versionsByProject.value, [projectId]: resp.versions ?? [] };
  } catch {
    // 版本列表拉取失败不阻塞表单 —— 下拉留空, 保存走跟随 current_version
  }
}

function projectName(id: string): string {
  return projects.value.find((p) => p.id === id)?.name ?? id.slice(0, 8);
}

/* 默认角色可用集 = 全局 role + 绑定项目专属 role (getRolesForProject 语义,
   前端按 listRoles 全量过滤); 编辑时若已配 role 不在可用集 (如换了绑定项目), 保留一项标注 */
const roleOptions = computed<{ value: string; label: string }[]>(() => {
  const boundId = draft.bound_project_id;
  const usable = roles.value.filter(
    (r) => r.project_id === null || r.project_id === boundId,
  );
  const opts = usable.map((r) => ({ value: r.id, label: r.name }));
  if (draft.role_id && !opts.some((o) => o.value === draft.role_id)) {
    const cur = roles.value.find((r) => r.id === draft.role_id);
    opts.unshift({ value: draft.role_id, label: `${cur?.name ?? draft.role_id.slice(0, 8)}（不在当前项目可用集）` });
  }
  return opts;
});

async function load(): Promise<void> {
  loading.value = true;
  error.value = '';
  try {
    const [cs, ps, rs] = await Promise.all([
      listChannels(),
      listProjects().then((r) => r.projects ?? []),
      listRoles(),
    ]);
    channels.value = cs;
    projects.value = ps;
    roles.value = rs;
  } catch (e) {
    error.value = e instanceof Error ? e.message : '加载渠道失败';
  } finally {
    loading.value = false;
  }
}

onMounted(() => {
  void load();
});

onUnmounted(() => {
  stopWxPoll();
});

async function copyBindCode(code: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(code);
    toast.success(`绑定码 ${code} 已复制`);
  } catch {
    toast.error('复制失败，请手动选择复制');
  }
}

/* ------------------------------------------------------------------ */
/*  扫码绑定弹窗 (docs/plans/channel-qr-bind.md D1)                     */
/* ------------------------------------------------------------------ */

const qrOpen = ref<boolean>(false);
const qrLoading = ref<boolean>(false);
const qrChannel = ref<ChannelConfig | null>(null);
const qr = ref<BindQr | null>(null);

/* wecom 凭据即绑定, 无扫码动作: 行内只显示 hint 不给按钮 */
const WECOM_BIND_HINT = '凭据绑定，无需扫码';

async function openQr(c: ChannelConfig): Promise<void> {
  qrChannel.value = c;
  qr.value = null;
  qrOpen.value = true;
  qrLoading.value = true;
  try {
    qr.value = await getBindQr(c.id);
  } catch (e) {
    toast.error(e instanceof Error ? e.message : '获取二维码失败');
    qrOpen.value = false;
  } finally {
    qrLoading.value = false;
  }
}

async function copyCommand(): Promise<void> {
  const text = qr.value?.copy_text;
  if (!text) return;
  try {
    await navigator.clipboard.writeText(text);
    toast.success('已复制');
  } catch {
    toast.error('复制失败，请手动选择复制');
  }
}

/* ------------------------------------------------------------------ */
/*  微信扫码登录弹窗 (D3): 选项目 → 生成二维码 → 3s 轮询 status →       */
/*  success 自动建 weixin 渠道行并刷新列表                              */
/* ------------------------------------------------------------------ */

const wxOpen = ref<boolean>(false);
const wxPhase = ref<'form' | 'qr' | 'done'>('form'); // form 选项目 / qr 展示+轮询 / done 成功
const wxCreating = ref<boolean>(false);
const wxQrSvg = ref<string>('');
const wxStatusText = ref<string>('');
const wxExpired = ref<boolean>(false);
const wxLoginId = ref<string>('');
const wxProjectId = ref<string>('');
const wxRoleId = ref<string>('');
/* 登录成功后大字展示新渠道行绑定码 (damo 2026-10-14: 码要流程给出, 不让用户去列表里找) */
const wxBindCode = ref<string>('');
let wxPollTimer: ReturnType<typeof setTimeout> | null = null;

function stopWxPoll(): void {
  if (wxPollTimer) {
    clearTimeout(wxPollTimer);
    wxPollTimer = null;
  }
}

function openWxLogin(): void {
  wxPhase.value = 'form';
  wxProjectId.value = projects.value[0]?.id ?? '';
  wxRoleId.value = '';
  wxQrSvg.value = '';
  wxStatusText.value = '';
  wxExpired.value = false;
  wxLoginId.value = '';
  wxBindCode.value = '';
  wxOpen.value = true;
}

async function startWxLogin(): Promise<void> {
  if (!wxProjectId.value) {
    toast.error('请先选择绑定项目');
    return;
  }
  wxCreating.value = true;
  try {
    const res = await weixinQrLogin({
      bound_project_id: wxProjectId.value,
      role_id: wxRoleId.value || null,
    });
    wxLoginId.value = res.login_id;
    wxQrSvg.value = res.qr_svg;
    wxExpired.value = false;
    wxStatusText.value = '请用微信扫码并确认登录';
    wxPhase.value = 'qr';
    scheduleWxPoll();
  } catch (e) {
    toast.error(e instanceof Error ? e.message : '生成二维码失败');
  } finally {
    wxCreating.value = false;
  }
}

function scheduleWxPoll(): void {
  stopWxPoll();
  wxPollTimer = setTimeout(async () => {
    if (!wxLoginId.value || !wxOpen.value) return;
    try {
      const st = await weixinQrLoginStatus(wxLoginId.value);
      if (st.status === 'success') {
        wxPhase.value = 'done';
        wxBindCode.value = st.channel?.bind_code ?? '';
        wxStatusText.value = `登录成功，已创建渠道「${st.channel?.name ?? 'weixin'}」`;
        toast.success('微信登录成功，渠道已创建');
        await load();
        return; // 成功即停轮询
      }
      if (st.status === 'scanned') {
        wxStatusText.value = '手机已扫描，请在微信上确认登录';
      } else if (st.status === 'expired') {
        wxExpired.value = true;
        wxStatusText.value = st.message ?? '二维码已过期，请重新生成';
        return; // 过期停轮询, 等用户点重新生成
      } else if (st.status === 'error') {
        wxStatusText.value = st.message ?? '微信服务返回错误，将继续重试';
      }
      scheduleWxPoll(); // pending / scanned / error 继续轮询
    } catch {
      scheduleWxPoll(); // 网络抖动不断流, 下轮再试
    }
  }, 3000);
}

function closeWxModal(): void {
  stopWxPoll();
  wxOpen.value = false;
}

/* ------------------------------------------------------------------ */
/*  新建 / 编辑表单                                                     */
/* ------------------------------------------------------------------ */

const modalOpen = ref<boolean>(false);
const editing = ref<ChannelConfig | null>(null);
const saving = ref<boolean>(false);

interface ChannelDraft {
  channel: string;
  name: string;
  secret: string; // 编辑时留空 = 不改
  bound_project_id: string;
  bound_version_id: string; // '' = 跟随项目 current_version (v529)
  role_id: string; // '' = 未配
  enabled: boolean;
}

function emptyDraft(): ChannelDraft {
  return {
    channel: 'telegram',
    name: '',
    secret: '',
    bound_project_id: projects.value[0]?.id ?? '',
    bound_version_id: '',
    role_id: '',
    enabled: true,
  };
}

const draft = reactive<ChannelDraft>(emptyDraft());

function openCreate(): void {
  editing.value = null;
  Object.assign(draft, emptyDraft());
  void loadVersions(draft.bound_project_id);
  modalOpen.value = true;
}

function openEdit(c: ChannelConfig): void {
  editing.value = c;
  Object.assign(draft, {
    channel: c.channel,
    name: c.name,
    secret: '',
    bound_project_id: c.bound_project_id,
    bound_version_id: c.bound_version_id ?? '',
    role_id: c.role_id ?? '',
    enabled: c.enabled,
  });
  void loadVersions(c.bound_project_id);
  modalOpen.value = true;
}

/* 换绑定项目时重置绑定版本 (版本必须属于项目, 跨项目残留值会被后端 400 拒掉)
   并懒加载新项目版本列表 */
watch(
  () => draft.bound_project_id,
  (pid, old) => {
    if (old === undefined) return;
    const belongs = (versionsByProject.value[pid] ?? []).some((v) => v.id === draft.bound_version_id);
    if (!belongs) draft.bound_version_id = '';
    void loadVersions(pid);
  },
);

function draftToBody(): Record<string, unknown> {
  const body: Record<string, unknown> = {
    channel: draft.channel,
    name: draft.name.trim(),
    bound_project_id: draft.bound_project_id,
    bound_version_id: draft.bound_version_id || null, // 空 = 跟随项目 current_version
    role_id: draft.role_id || null,
  };
  // secret 留空 = 不改 (新建必填校验在后, 编辑时空串不下发)
  if (draft.secret) body.secret = draft.secret;
  if (editing.value) body.enabled = draft.enabled;
  return body;
}

async function save(): Promise<void> {
  if (!draft.name.trim() || !draft.bound_project_id) {
    toast.error('名称和绑定项目必填');
    return;
  }
  if (!editing.value && !draft.secret) {
    toast.error('新建渠道需填写 secret（bot token 等凭据）');
    return;
  }
  saving.value = true;
  try {
    const body = draftToBody();
    if (editing.value) {
      await updateChannel(editing.value.id, body);
      toast.success('渠道已更新');
    } else {
      await createChannel(body as never);
      toast.success('渠道已创建');
    }
    modalOpen.value = false;
    await load();
  } catch (e) {
    toast.error(e instanceof Error ? e.message : '保存失败');
  } finally {
    saving.value = false;
  }
}

async function remove(c: ChannelConfig): Promise<void> {
  const ok = await confirm(
    `确定删除渠道「${c.name}」？绑定码 ${c.bind_code} 随之失效；已有会话历史保留。`,
    { title: '删除渠道', type: 'danger', confirmText: '删除' },
  );
  if (!ok) return;
  try {
    await deleteChannel(c.id);
    toast.success('已删除');
    await load();
  } catch (e) {
    toast.error(e instanceof Error ? e.message : '删除失败');
  }
}
</script>

<template>
  <section class="card section-card">
    <div class="section-head">
      <h2 class="section-title">📡 渠道接入</h2>
      <span class="badge badge-info">IM 渠道 → 绑定项目 → intake 建 task</span>
      <Button variant="secondary" class="head-action" @click="openWxLogin">扫码登录微信</Button>
      <Button variant="primary" @click="openCreate">＋ 新建渠道</Button>
    </div>

    <Loading v-if="loading" />
    <ErrorView v-else-if="error" title="加载渠道失败" :description="error" @retry="load" />
    <template v-else>
      <Empty
        v-if="channels.length === 0"
        title="还没有渠道配置"
        description="渠道 = 一个 IM 机器人实例（如 Telegram bot）。绑定一个项目、可选配默认角色，外部用户给 bot 发消息即可在该项目下建 task。点右上角「新建渠道」开始。"
      />
      <table v-else class="channels-table">
        <thead>
          <tr>
            <th>类型</th>
            <th>名称</th>
            <th>绑定项目</th>
            <th>绑定版本</th>
            <th>默认角色</th>
            <th>状态</th>
            <th>绑定码</th>
            <th class="col-actions">操作</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="c in channels" :key="c.id">
            <td><span class="badge badge-muted">{{ c.channel }}</span></td>
            <td>
              <div class="ch-name">{{ c.name }}</div>
              <div class="muted small">{{ c.has_secret ? '凭据已配置' : '未配凭据' }}</div>
            </td>
            <td>{{ projectName(c.bound_project_id) }}</td>
            <td>
              <span v-if="c.version_name" class="badge badge-info">{{ c.version_name }}</span>
              <span v-else class="muted small">跟随 current</span>
            </td>
            <td>
              <span v-if="c.role_name" class="badge badge-info">{{ c.role_name }}</span>
              <span v-else class="muted small">未配</span>
            </td>
            <td>
              <span class="badge" :class="c.enabled ? 'badge-ok' : 'badge-warn'">
                {{ c.enabled ? '启用' : '停用' }}
              </span>
            </td>
            <td>
              <code class="bind-code" role="button" tabindex="0" :title="'点击复制'" @click="copyBindCode(c.bind_code)" @keyup.enter="copyBindCode(c.bind_code)">{{ c.bind_code }}</code>
            </td>
            <td class="col-actions">
              <Button v-if="c.channel !== 'wecom'" variant="ghost" size="sm" @click="openQr(c)">扫码绑定</Button>
              <span v-else class="muted small">{{ WECOM_BIND_HINT }}</span>
              <Button variant="ghost" size="sm" @click="openEdit(c)">编辑</Button>
              <Button variant="danger" size="sm" @click="remove(c)">删除</Button>
            </td>
          </tr>
        </tbody>
      </table>
      <p class="muted small form-aside">
        外部用户给 bot 发「bind &lt;绑定码&gt;」完成会话绑定；之后该用户消息直接在绑定项目下建 task
        （首 task 挂默认角色）。停用的渠道不响应绑定与新消息。绑定码点击即复制。
      </p>
    </template>

    <!-- 新建 / 编辑 -->
    <Modal v-model="modalOpen" :title="editing ? `编辑渠道：${editing.name}` : '新建渠道'" size="lg">
      <div class="channel-form">
        <div class="form-grid">
          <div>
            <label class="lbl">渠道类型 <span class="req">*</span></label>
            <Select
              v-model="draft.channel"
              :options="CHANNEL_TYPES"
              :disabled="saving || !!editing"
            />
            <p class="muted small role-hint">
              {{ editing ? '渠道类型决定消费方协议，创建后不可更改。' : 'telegram / wecom / feishu 均已接入；openclaw 是内部线程通道，不在此配置。' }}
            </p>
          </div>
          <div>
            <label class="lbl">名称 <span class="req">*</span></label>
            <Input v-model="draft.name" placeholder="如 派单 bot / 客服号" :disabled="saving" />
          </div>
        </div>
        <div>
          <label class="lbl">Secret（bot token 等凭据）<span v-if="!editing" class="req">*</span></label>
          <Input
            v-model="draft.secret"
            type="password"
            :placeholder="editing ? '留空 = 不修改' : 'bot token / app secret'"
            autocomplete="new-password"
            :disabled="saving"
          />
          <p v-if="draft.channel === 'weixin'" class="muted small role-hint">
            weixin 渠道推荐用顶部「扫码登录微信」自动写入凭据；手动填写格式：
            {"bot_token":"...","ilink_bot_id":"..."} 或纯 bot_token。
          </p>
        </div>
        <div>
          <label class="lbl">绑定项目 <span class="req">*</span></label>
          <Select
            v-model="draft.bound_project_id"
            :options="projectOptions"
            placeholder="选择项目"
            :disabled="saving"
          />
        </div>
        <div v-if="draft.bound_project_id">
          <label class="lbl">绑定版本（可选）</label>
          <Select
            v-model="draft.bound_version_id"
            :options="[{ value: '', label: '跟随项目 current_version' }, ...versionOptions]"
            :disabled="saving"
          />
          <p class="muted small role-hint">指定后该渠道进来的需求固定落在所选版本；不指定 = 项目当前版本。</p>
        </div>
        <div>
          <label class="lbl">默认角色（intake 首 task 挂载，可选）</label>
          <Select
            v-model="draft.role_id"
            :options="[{ value: '', label: '未配（用项目默认）' }, ...roleOptions]"
            :disabled="saving || !draft.bound_project_id"
          />
          <p class="muted small role-hint">可选集 = 全局角色 + 绑定项目专属角色；换绑定项目后原角色不在可用集时会标注提示。</p>
        </div>
        <Checkbox
          v-if="editing"
          :model-value="draft.enabled"
          :disabled="saving"
          label="启用（停用后不响应绑定与新消息）"
          @update:model-value="(v: boolean) => draft.enabled = v"
        />
      </div>
      <template #footer>
        <div class="modal-actions">
          <Button variant="ghost" :disabled="saving" @click="modalOpen = false">取消</Button>
          <Button variant="primary" :loading="saving" @click="save">
            {{ editing ? '保存' : '创建' }}
          </Button>
        </div>
      </template>
    </Modal>
    <!-- 扫码绑定 (D1): 服务端 SVG + hint + 一键复制命令 -->
    <Modal v-model="qrOpen" :title="`扫码绑定：${qrChannel?.name ?? ''}`" size="sm">
      <div class="qr-body">
        <Loading v-if="qrLoading" />
        <template v-else-if="qr">
          <div v-if="qr.qr_svg" class="qr-svg" v-html="qr.qr_svg"></div>
          <p class="hint">{{ qr.hint }}</p>
          <code v-if="qr.copy_text" class="qr-cmd">{{ qr.copy_text }}</code>
          <Button v-if="qr.copy_text" variant="primary" @click="copyCommand">复制命令</Button>
        </template>
      </div>
    </Modal>
    <!-- 微信扫码登录 (D3): 选项目 → iLink QR → 3s 轮询 → 自动建渠道行 -->
    <Modal v-model="wxOpen" title="扫码登录微信" size="sm" @update:model-value="(v: boolean) => { if (!v) closeWxModal(); }">
      <div class="qr-body">
        <template v-if="wxPhase === 'form'">
          <p class="hint">用个人微信扫码登录，平台自动创建 weixin 渠道行（凭据加密落库）。</p>
          <div class="wx-field">
            <label class="lbl">绑定项目 <span class="req">*</span></label>
            <Select v-model="wxProjectId" :options="projectOptions" placeholder="选择项目" />
          </div>
          <div class="wx-field">
            <label class="lbl">默认角色（可选）</label>
            <Select
              v-model="wxRoleId"
              :options="[{ value: '', label: '未配（用项目默认）' }, ...roleOptions]"
              :disabled="!wxProjectId"
            />
          </div>
          <Button variant="primary" :loading="wxCreating" :disabled="!wxProjectId" @click="startWxLogin">
            生成登录二维码
          </Button>
        </template>
        <template v-else-if="wxPhase === 'qr'">
          <div class="qr-svg" v-html="wxQrSvg"></div>
          <p class="hint" :class="{ 'wx-warn': wxExpired }">{{ wxStatusText }}</p>
          <Button v-if="wxExpired" variant="primary" @click="startWxLogin">重新生成二维码</Button>
        </template>
        <template v-else>
          <p class="hint wx-ok">✅ {{ wxStatusText }}</p>
          <div v-if="wxBindCode" class="wx-bindcode-box">
            <p class="hint">用此微信向机器人发以下消息完成绑定：</p>
            <code class="wx-bindcode">{{ wxBindCode }}</code>
            <Button variant="primary" size="sm" @click="copyBindCode(wxBindCode)">复制绑定码</Button>
          </div>
          <Button variant="primary" @click="closeWxModal">完成</Button>
        </template>
      </div>
    </Modal>
  </section>
</template>

<style scoped>
.section-head {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
}
.head-action {
  margin-left: auto;
}
.channels-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 13px;
}
.channels-table th,
.channels-table td {
  text-align: left;
  padding: 8px 10px;
  border-bottom: 1px solid var(--border, #e5e7eb);
  vertical-align: top;
}
.channels-table th {
  color: var(--text-muted, #6b7280);
  font-weight: 500;
  font-size: 12px;
}
.col-actions {
  white-space: nowrap;
  text-align: right;
}
.col-actions > * + * {
  margin-left: 6px;
}
.ch-name {
  font-weight: 600;
}
.badge-muted {
  background: var(--bg-muted, #f3f4f6);
  color: var(--text-muted, #6b7280);
}
.badge-ok {
  background: var(--bg-ok, #ecfdf5);
  color: var(--text-ok, #047857);
}
.badge-warn {
  background: var(--bg-warn, #fffbeb);
  color: var(--text-warn, #b45309);
}
.bind-code {
  cursor: pointer;
  font-size: 12px;
  letter-spacing: 1px;
  background: var(--bg-muted, #f3f4f6);
  padding: 2px 6px;
  border-radius: 4px;
}
.bind-code:hover {
  outline: 1px solid var(--border, #d1d5db);
}
.form-aside {
  margin-top: 10px;
}
.channel-form {
  display: flex;
  flex-direction: column;
  gap: 14px;
}
.form-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 12px;
}
.lbl {
  display: block;
  font-size: 12px;
  color: var(--text-muted, #6b7280);
  margin-bottom: 4px;
}
.req {
  color: var(--text-danger, #dc2626);
}
.role-hint {
  margin-top: 4px;
}
.modal-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}
.qr-body {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 12px;
  padding: 4px 0;
}
.qr-svg {
  width: 220px;
  height: 220px;
}
.qr-svg :deep(svg) {
  width: 100%;
  height: 100%;
  display: block;
}
.qr-body .hint {
  margin: 0;
  font-size: 13px;
  color: var(--text-muted, #6b7280);
  text-align: center;
}
.qr-cmd {
  font-size: 14px;
  letter-spacing: 1px;
  background: var(--bg-muted, #f3f4f6);
  padding: 4px 10px;
  border-radius: 4px;
  word-break: break-all;
  text-align: center;
}
.wx-field {
  width: 100%;
}
.wx-field .lbl {
  display: block;
  font-size: 12px;
  color: var(--text-muted, #6b7280);
  margin-bottom: 4px;
  text-align: left;
}
.wx-warn {
  color: var(--text-warn, #b45309);
}
.wx-ok {
  color: var(--text-ok, #047857);
  font-size: 14px;
}
.wx-bindcode-box {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
  width: 100%;
}
.wx-bindcode {
  font-size: 24px;
  font-weight: 700;
  letter-spacing: 3px;
  color: var(--text-ok, #047857);
  background: var(--bg-muted, #f3f4f6);
  padding: 8px 20px;
  border-radius: 6px;
  cursor: pointer;
}
.wx-bindcode:hover {
  outline: 1px solid var(--border, #d1d5db);
}
</style>
