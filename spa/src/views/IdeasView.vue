<script setup lang="ts">
/* 功能: 构思画布 (idea-canvas P2, docs/plans/idea-canvas.md §5) — 跨项目构思层.
   playcanvas 3D 球体 (一 idea 一球, 大小=关联数, 颜色=状态) + 两视图
   (关联度=力导向 / 时间线=x轴时间 y=状态泳道) + DOM 投影交互层 (标签/点击/
   关联边 SVG) + 左栏人工分拣列表 (P1) + 右侧详情抽屉 (节点 DAG + 收益面板 +
   信号 + 挂的任务 + 从节点派任务).

   关注点:
   - 混合渲染架构: 3D 球体走 playcanvas (视觉), 命中/标签/边走 DOM 投影
     (camera.worldToScreen 每帧同步). 纯 3D picking + 3D 文本渲染脆且贵,
     DOM 层拿到原生 hover/click/编辑能力, 3D 只做「球的质感」.
   - 力导向在 rAF 里跑 (斥力 + 关联弹簧 + 向心力), 收敛后停 (速度阈值);
     切时间线视图时布局切换为时间轴排布, 不跑力学.
   - playcanvas 引擎只在 ideas 页加载 (ConsoleCanvas 的取舍注释不适用本页,
     damo 1011 点名 playcanvas); 球体材质 MeshStandardMaterial + 环境光.
   - 列表积木 P3: 本版实现 列表排序持久化 (updatePinList.sort_key) +
     条目排序 (reorder API); 12 列网格自由拖摆留 dashboard_blocks UI 后续.
   - 派任务从节点发起: createTask({idea_id, node_id, autoApprove:true}) +
     startTask (与 console 同款, L1 派发 body 约定). */

import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue';
import { useRouter } from 'vue-router';
import { useI18n } from 'vue-i18n';
import * as pc from 'playcanvas';
import {
  listIdeas,
  getIdea,
  createIdea,
  updateIdea,
  createIdeaNode,
  updateIdeaNode,
  addIdeaSignal,
  IDEA_STATUS_LABELS,
  NODE_STATUS_LABELS,
  ideaStatusLabel,
  nodeStatusLabel,
  ideaStatusColor,
  type IdeaWithCounts,
  type IdeaLink,
  type Idea,
  type IdeaNode,
  type IdeaSignal,
  type IdeaROI,
  type IdeaTaskLite,
  type IdeaStatus,
} from '@/api/ideas';
import {
  listPinLists,
  createPinList,
  updatePinList,
  deletePinList,
  addPinListItem,
  removePinListItem,
  reorderPinListItems,
  type PinListWithItems,
} from '@/api/pin-lists';
import { createTask, startTask } from '@/api/tasks';
import { useToast } from '@/composables/useToast';

const router = useRouter();
const toast = useToast();
const { t } = useI18n();

// ---- 数据 ----
const ideas = ref<IdeaWithCounts[]>([]);
const links = ref<IdeaLink[]>([]);
const loading = ref(true);
const viewMode = ref<'force' | 'timeline'>('force');

const lists = ref<PinListWithItems[]>([]);

// idea-canvas P3 (docs/plans/idea-canvas.md): 列表积木自由摆 — 浮动卡片拖拽定位,
//   位置持久化 dashboard_blocks (block_type='list', ref_id=list_id, x/y=px).
//   freeMode=off 时走默认左栏 rail (紧凑), on 时浮在画布上按保存的位置摆.
const freeMode = ref(false);
const listPos = reactive<Map<string, { x: number; y: number }>>(new Map());
const draggingList = ref<{ id: string; lastX: number; lastY: number } | null>(null);

function applyBlockPositions() {
  // 由 refresh() 在拉到 blocks 后调用
}
async function loadBlocks() {
  try {
    const { get: httpGet } = await import('@/api/http');
    const d = await httpGet<{ blocks: Array<{ block_type: string; ref_id: string | null; x: number | null; y: number | null }> }>('/api/dashboard-blocks');
    for (const b of d.blocks) {
      if (b.block_type === 'list' && b.ref_id && b.x !== null && b.y !== null) {
        listPos.set(b.ref_id, { x: b.x, y: b.y });
      }
    }
  } catch { /* 布局拉不到就用默认层叠 */ }
}
function defaultPos(idx: number): { x: number; y: number } {
  // 默认层叠在画布右上区, 没保存过的按序排
  return { x: 940 + (idx % 2) * 260, y: 24 + idx * 40 };
}
async function saveBlocks() {
  const { put } = await import('@/api/http');
  const others = [] as any[];
  try {
    const { get: httpGet } = await import('@/api/http');
    const d = await httpGet<{ blocks: any[] }>('/api/dashboard-blocks');
    others.push(...d.blocks.filter((b) => b.block_type !== 'list'));
  } catch { /* ignore */ }
  const blocks = lists.value.map((l, idx) => {
    const p = listPos.get(l.id) ?? defaultPos(idx);
    return { block_type: 'list', ref_id: l.id, x: Math.round(p.x), y: Math.round(p.y), w: 240, h: 0 };
  });
  await put('/api/dashboard-blocks', { blocks: [...others, ...blocks] });
}
function startDragList(l: PinListWithItems, e: MouseEvent) {
  if (!freeMode.value) return;
  // 增量拖拽: 记最近鼠标位, move 时按位移累加 (避免 viewport/wrap 坐标系混用首拖跳变)
  draggingList.value = { id: l.id, lastX: e.clientX, lastY: e.clientY };
  e.preventDefault();
}
function onDragMove(e: MouseEvent) {
  const d = draggingList.value;
  if (!d) return;
  const p = listPos.get(d.id);
  if (!p) return;
  const nx = Math.max(0, p.x + (e.clientX - d.lastX));
  const ny = Math.max(0, p.y + (e.clientY - d.lastY));
  d.lastX = e.clientX; d.lastY = e.clientY;
  listPos.set(d.id, { x: nx, y: ny });
}
function onDragUp() {
  if (!draggingList.value) return;
  draggingList.value = null;
  saveBlocks().catch(() => toast.error(t('misc.ideas.layoutSaveFailed')));
}
function toggleFreeMode() {
  freeMode.value = !freeMode.value;
  if (freeMode.value && lists.value.length > 0) {
    // 首次进自由模式: 没保存过的列表给默认位
    lists.value.forEach((l, idx) => {
      if (!listPos.has(l.id)) {
        const p = defaultPos(idx);
        listPos.set(l.id, p);
      }
    });
  }
}

// 选中的 idea 详情
const selectedId = ref<string | null>(null);
const detail = ref<{
  idea: Idea;
  nodes: IdeaNode[];
  signals: IdeaSignal[];
  roi: IdeaROI | null;
  tasks: IdeaTaskLite[];
} | null>(null);
const detailLoading = ref(false);

const showCreate = ref(false);
const createForm = reactive({ title: '', hypothesis: '', success_criteria: '', deadline: '' });
const newNodeTitle = ref('');
const newSignal = reactive({ kind: 'inquiry', value: '' as string | number, note: '', ref: '' });
const signalKinds = ['inquiry', 'signup', 'payment', 'review', 'usage', 'other'];
/** 信号类型文案 — i18n 走 t() (函数; 模块级常量非响应式, 语言切换不会更新). */
function signalLabel(kind: string): string {
  const labels: Record<string, string> = {
    inquiry: t('misc.ideas.signalInquiry'),
    signup: t('misc.ideas.signalSignup'),
    payment: t('misc.ideas.signalPayment'),
    review: t('misc.ideas.signalReview'),
    usage: t('misc.ideas.signalUsage'),
    other: t('misc.ideas.signalOther'),
  };
  return labels[kind] ?? kind;
}

async function refresh() {
  loading.value = true;
  try {
    const d = await listIdeas();
    ideas.value = d.ideas;
    links.value = d.links;
    layoutDirty.value = true;
    const l = await listPinLists();
    lists.value = l.lists;
    await loadBlocks();
  } finally {
    loading.value = false;
  }
}

async function openDetail(id: string) {
  selectedId.value = id;
  detailLoading.value = true;
  try {
    detail.value = await getIdea(id);
  } finally {
    detailLoading.value = false;
  }
}

async function refreshDetail() {
  if (selectedId.value) await openDetail(selectedId.value);
}

// ---- 力导向布局 (2D, rAF; 收敛后停) ----
interface Node2D { id: string; x: number; y: number; vx: number; vy: number; r: number }
const layoutNodes = reactive<Map<string, Node2D>>(new Map());
const layoutDirty = ref(true);

function radiusOf(i: IdeaWithCounts): number {
  return Math.min(1.6, 0.55 + Math.sqrt(i.task_count + i.node_count) * 0.22);
}

function initLayout() {
  const n = ideas.value.length;
  ideas.value.forEach((idea, idx) => {
    if (!layoutNodes.has(idea.id)) {
      const ang = (idx / Math.max(n, 1)) * Math.PI * 2;
      layoutNodes.set(idea.id, {
        id: idea.id, x: Math.cos(ang) * 1.5, y: Math.sin(ang) * 1.5, vx: 0, vy: 0, r: radiusOf(idea),
      });
    } else {
      layoutNodes.get(idea.id)!.r = radiusOf(idea);
    }
  });
}

function stepForce() {
  const arr = [...layoutNodes.values()];
  const k = 3.2; // 斥力强度
  for (let i = 0; i < arr.length; i++) {
    for (let j = i + 1; j < arr.length; j++) {
      const a = arr[i], b = arr[j];
      let dx = b.x - a.x, dy = b.y - a.y;
      let d2 = dx * dx + dy * dy;
      if (d2 < 1e-4) { dx = Math.random() - 0.5; dy = Math.random() - 0.5; d2 = 1e-4; }
      const d = Math.sqrt(d2);
      const f = (k * (a.r + b.r)) / d2;
      a.vx -= (dx / d) * f * 0.01; a.vy -= (dy / d) * f * 0.01;
      b.vx += (dx / d) * f * 0.01; b.vy += (dy / d) * f * 0.01;
    }
  }
  // 关联弹簧
  for (const l of links.value) {
    const a = layoutNodes.get(l.idea_id), b = layoutNodes.get(l.linked_idea_id);
    if (!a || !b) continue;
    const dx = b.x - a.x, dy = b.y - a.y;
    const d = Math.sqrt(dx * dx + dy * dy) || 1e-4;
    const want = a.r + b.r + 0.9;
    const f = ((d - want) / d) * 0.02 * l.weight;
    a.vx += dx * f; a.vy += dy * f;
    b.vx -= dx * f; b.vy -= dy * f;
  }
  // 向心力 + 阻尼 + 积分
  let energy = 0;
  const MAXV = 0.035; // 单步位移限幅 —— 防初始重叠时斥力爆炸 (坐标飞出画布)
  for (const n2 of arr) {
    n2.vx -= n2.x * 0.002; n2.vy -= n2.y * 0.002;
    n2.vx *= 0.85; n2.vy *= 0.85;
    const mv = Math.sqrt(n2.vx * n2.vx + n2.vy * n2.vy);
    if (mv > MAXV) { n2.vx = (n2.vx / mv) * MAXV; n2.vy = (n2.vy / mv) * MAXV; }
    n2.x += n2.vx; n2.y += n2.vy;
    // 软边界: 出界拉回 (力导向布局的活动范围)
    const B = 3.2;
    if (n2.x > B) n2.x = B; if (n2.x < -B) n2.x = -B;
    if (n2.y > B) n2.y = B; if (n2.y < -B) n2.y = -B;
    energy += Math.abs(n2.vx) + Math.abs(n2.vy);
  }
  return energy;
}

// 时间线布局: x = 时间归一, y = 状态泳道
function applyTimelineLayout() {
  const times = ideas.value.map((i) => new Date(i.created_at).getTime());
  const tMin = Math.min(...times), tMax = Math.max(...times, tMin + 1);
  const lanes = ['germinating', 'exploring', 'decided', 'landed', 'shelved', 'rejected'];
  ideas.value.forEach((i) => {
    const n2 = layoutNodes.get(i.id);
    if (!n2) return;
    const t = (new Date(i.created_at).getTime() - tMin) / (tMax - tMin);
    n2.x = -2.6 + t * 5.2;
    n2.y = (lanes.indexOf(i.status) - (lanes.length - 1) / 2) * -0.95;
    n2.vx = 0; n2.vy = 0;
  });
}

// ---- playcanvas 场景 ----
const canvasRef = ref<HTMLCanvasElement | null>(null);
const overlayRef = ref<HTMLDivElement | null>(null);
let app: pc.AppBase | null = null;
let camEntity: pc.Entity | null = null;
let camComp: pc.CameraComponent | null = null;
// 编辑器手感相机 (damo 1012: playcanvas 官方编辑器式) — 球坐标 orbit:
//   左键拖 = 旋转视角(theta/phi), 右键或 Shift+左键拖 = 平移, 滚轮 = 缩放,
//   方向键/WASD = 平移. target 为注视点, updateCamera 从球坐标算机位.
let camTheta = 0.35;         // 水平方位角
let camPhi = 1.15;           // 俯仰角 (0=顶视, PI=底视)
const camTarget = { x: 0, y: 0, z: 0 };
function updateCamera() {
  if (!camEntity) return;
  const x = camTarget.x + camDist * Math.sin(camPhi) * Math.sin(camTheta);
  const y = camTarget.y + camDist * Math.cos(camPhi);
  const z = camTarget.z + camDist * Math.sin(camPhi) * Math.cos(camTheta);
  camEntity.setPosition(x, y, z);
  camEntity.lookAt(camTarget.x, camTarget.y, camTarget.z);
}
const sphereEntities = new Map<string, pc.Entity>();
let rafId = 0;
let camDist = 8.5;
const projected = reactive<Map<string, { sx: number; sy: number; visible: boolean }>>(new Map());
const edgeSegments = ref<Array<{ x1: number; y1: number; x2: number; y2: number; dashed: boolean }>>([]);

function makeMaterial(color: [number, number, number], opacity = 1): pc.Material {
  const m = new pc.StandardMaterial();
  m.diffuse = new pc.Color(color[0], color[1], color[2]);
  m.specular = new pc.Color(0.25, 0.25, 0.28);
  m.shininess = 42;
  if (opacity < 1) m.opacity = opacity;
  m.update();
  return m;
}

async function init3d() {
  if (!canvasRef.value || app) return;
  app = new pc.AppBase(canvasRef.value!);
  const device = await pc.createGraphicsDevice(canvasRef.value!);
  const options = new pc.AppOptions();
  options.graphicsDevice = device;
  // v2 硬要求: 组件系统/资源处理器显式注册 (不列 = addComponent 返 null, 什么都挂不上)
  options.componentSystems = [
    pc.RenderComponentSystem,
    pc.CameraComponentSystem,
    pc.LightComponentSystem,
  ] as any;
  options.resourceHandlers = [
    pc.MaterialHandler,
    pc.ModelHandler,
    pc.TextureHandler,
  ] as any;
  await app.init(options);
  app.setCanvasFillMode(pc.FILLMODE_FILL_WINDOW);
  app.setCanvasResolution(pc.RESOLUTION_AUTO);
  app.start();

  camEntity = new pc.Entity('camera', app);
  // v2 注意: entity.camera getter 对手工实体不可靠 (运行时 undefined), 建时存组件引用
  camComp = camEntity.addComponent('camera', {
    clearColor: new pc.Color(0.043, 0.066, 0.11),
    farClip: 100,
  }) as unknown as pc.CameraComponent;
  updateCamera();
  app.root.addChild(camEntity);

  const light = new pc.Entity('light', app);
  light.addComponent('light', { type: 'directional', intensity: 1.1 });
  light.setEulerAngles(50, 30, 0);
  app.root.addChild(light);
  const ambient = new pc.Entity('ambient', app);
  ambient.addComponent('light', { type: 'ambient', intensity: 0.55, color: new pc.Color(0.6, 0.65, 0.8) });
  app.root.addChild(ambient);

  // 每帧: 力学步进 (force 模式) + 同步球体位置 + DOM 投影
  let frame = 0;
  app.on('update', () => {
    frame++;
    if (viewMode.value === 'force' && layoutDirty.value && frame % 2 === 0) {
      const e = stepForce();
      if (e < 0.05) layoutDirty.value = false;
    }
    syncSpheres();
    if (frame % 2 === 0) projectOverlay();
  });
}

function syncSpheres() {
  if (!app) return;
  for (const idea of ideas.value) {
    let e = sphereEntities.get(idea.id);
    const n2 = layoutNodes.get(idea.id);
    if (!n2) continue;
    if (!e) {
      e = new pc.Entity(idea.id, app);
      e.addComponent('render', { type: 'sphere', material: makeMaterial(ideaStatusColor(idea.status)) });
      app!.root.addChild(e);
      sphereEntities.set(idea.id, e);
    }
    e.setPosition(n2.x, n2.y, 0);
    const s = n2.r;
    e.setLocalScale(s, s, s);
    e.rotate(0, 0.08, 0);
  }
  // 移除已删 idea 的球
  for (const [id, e] of sphereEntities) {
    if (!ideas.value.find((i) => i.id === id)) {
      e.destroy();
      sphereEntities.delete(id);
    }
  }
}

/** 3D → 屏幕投影, DOM 标签/SVG 边跟随. */
function projectOverlay() {
  const cam = camComp; // 局部 const: TS 收窄 + 回调里不追模块变量
  if (!cam || !canvasRef.value || !overlayRef.value) return;
  const w = canvasRef.value.clientWidth, h = canvasRef.value.clientHeight;
  const cw = canvasRef.value.width, ch = canvasRef.value.height;
  const next = new Map<string, { sx: number; sy: number; visible: boolean }>();
  const segs: typeof edgeSegments.value = [];
  const proj = (x: number, y: number) => {
    // CameraComponent.worldToScreen(world) → 相机 rect 像素坐标 (y 向下)
    const sp = cam.worldToScreen(new pc.Vec3(x, y, 0));
    const scaleX = w / cw, scaleY = h / ch;
    return { sx: sp.x * scaleX, sy: sp.y * scaleY };
  };
  for (const idea of ideas.value) {
    const n2 = layoutNodes.get(idea.id);
    if (!n2) continue;
    const { sx, sy } = proj(n2.x, n2.y);
    next.set(idea.id, { sx, sy, visible: sx > -50 && sx < w + 50 && sy > -50 && sy < h + 50 });
  }
  for (const [id, p] of next) projected.set(id, p);
  for (const l of links.value) {
    const a = next.get(l.idea_id), b = next.get(l.linked_idea_id);
    if (a?.visible && b?.visible) {
      segs.push({ x1: a.sx, y1: a.sy, x2: b.sx, y2: b.sy, dashed: l.relation !== 'related' });
    }
  }
  edgeSegments.value = segs;
}

function onWheel(e: WheelEvent) {
  camDist = Math.min(30, Math.max(3, camDist + e.deltaY * 0.006));
  updateCamera();
}

// 旋转/平移拖拽态
let orbiting = false;
let panning = false;
let lastMouse = { x: 0, y: 0 };
const heldKeys = new Set<string>();

function panSpeed(): number { return camDist * 0.0016; }

function panBy(dx: number, dy: number) {
  // 沿相机右/上向量平移 target (右拖 = 场景左移, 手感同编辑器)
  if (!camEntity) return;
  const pos = camEntity.getPosition();
  const fx = camTarget.x - pos.x, fy = camTarget.y - pos.y, fz = camTarget.z - pos.z;
  const fl = Math.hypot(fx, fy, fz) || 1;
  // right = normalize(fwd × UP), up = normalize(right × fwd) — 手写叉积避开重载坑
  let rx = fy * 1 - fz * 0, ry = fz * 0 - fx * 1, rz = fx * 0 - fy * 0;
  const rl = Math.hypot(rx, ry, rz) || 1; rx /= rl; ry /= rl; rz /= rl;
  const ux = ry * fz - rz * fy, uy = rz * fx - rx * fz, uz = rx * fy - ry * fx;
  const s = panSpeed();
  camTarget.x += (-rx * dx + ux * dy) * s;
  camTarget.y += (-ry * dx + uy * dy) * s;
  camTarget.z += (-rz * dx + uz * dy) * s;
  updateCamera();
}

function onCanvasMouseDown(e: MouseEvent) {
  lastMouse = { x: e.clientX, y: e.clientY };
  if (e.button === 2 || e.button === 1 || e.shiftKey) panning = true;
  else if (e.button === 0) orbiting = true;
}
function onCanvasMouseMove(e: MouseEvent) {
  if (!orbiting && !panning) return;
  const dx = e.clientX - lastMouse.x, dy = e.clientY - lastMouse.y;
  lastMouse = { x: e.clientX, y: e.clientY };
  if (orbiting) {
    camTheta -= dx * 0.005;
    camPhi = Math.min(Math.PI - 0.15, Math.max(0.15, camPhi - dy * 0.005));
    updateCamera();
  } else if (panning) {
    panBy(dx, dy);
  }
}
function onCanvasMouseUp() { orbiting = false; panning = false; }
let keyInterval = 0;
function onKeydown(e: KeyboardEvent) {
  const tag = (e.target as HTMLElement)?.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
  if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'w', 'a', 's', 'd'].includes(e.key)) {
    heldKeys.add(e.key);
  }
}
function onKeyup(e: KeyboardEvent) { heldKeys.delete(e.key); }
function onKeyMove() {
  let dx = 0, dy = 0;
  if (heldKeys.has('ArrowLeft') || heldKeys.has('a')) dx -= 1;
  if (heldKeys.has('ArrowRight') || heldKeys.has('d')) dx += 1;
  if (heldKeys.has('ArrowUp') || heldKeys.has('w')) dy += 1;
  if (heldKeys.has('ArrowDown') || heldKeys.has('s')) dy -= 1;
  if (dx || dy) panBy(dx * 12, dy * 12);
}

// ---- 列表操作 (P1) ----
const newListTitle = ref('');
async function addList() {
  if (!newListTitle.value.trim()) return;
  const l = await createPinList(newListTitle.value.trim());
  lists.value.push(l);
  newListTitle.value = '';
}
const editingListId = ref<string | null>(null);
const editingListTitle = ref('');
function startRenameList(l: PinListWithItems) {
  editingListId.value = l.id;
  editingListTitle.value = l.title;
}
async function commitRenameList(l: PinListWithItems) {
  editingListId.value = null;
  const t = editingListTitle.value.trim();
  if (!t || t === l.title) return;
  const u = await updatePinList(l.id, { title: t });
  l.title = u.title;
}
const removingListId = ref<string | null>(null);
async function confirmRemoveList(l: PinListWithItems) {
  if (removingListId.value !== l.id) { removingListId.value = l.id; return; } // 点两次 = 确认
  removingListId.value = null;
  await deletePinList(l.id);
  lists.value = lists.value.filter((x) => x.id !== l.id);
}
async function moveList(l: PinListWithItems, dir: -1 | 1) {
  const idx = lists.value.findIndex((x) => x.id === l.id);
  const swap = idx + dir;
  if (swap < 0 || swap >= lists.value.length) return;
  const arr = [...lists.value];
  [arr[idx], arr[swap]] = [arr[swap], arr[idx]];
  lists.value = arr;
  await Promise.all(arr.map((x, i) => updatePinList(x.id, { sort_key: i + 1 })));
}
async function putIdeaIntoList(listId: string) {
  if (!selectedId.value) return;
  try {
    await addPinListItem(listId, { ref_type: 'idea', ref_id: selectedId.value, added_by: 'damo' });
    toast.success(t('misc.ideas.putInList'));
    const l = await listPinLists();
    lists.value = l.lists;
  } catch (err: any) {
    toast.error(err?.message ?? t('misc.ideas.putFailed'));
  }
}
async function removeItem(list: PinListWithItems, itemId: string) {
  await removePinListItem(itemId);
  list.items = list.items.filter((i) => i.id !== itemId);
}
function openRef(refType: string, refId: string) {
  if (refType === 'task') router.push(`/tasks/${refId}`);
  else if (refType === 'idea') { selectedId.value = refId; openDetail(refId); }
}
async function reorderItem(list: PinListWithItems, idx: number, dir: -1 | 1) {
  const swap = idx + dir;
  if (swap < 0 || swap >= list.items.length) return;
  const arr = [...list.items];
  [arr[idx], arr[swap]] = [arr[swap], arr[idx]];
  list.items = arr;
  await reorderPinListItems(list.id, arr.map((i) => i.id));
}

// ---- 详情抽屉操作 ----
async function setStatus(idea: Idea, status: IdeaStatus) {
  const u = await updateIdea(idea.id, { status });
  idea.status = u.status;
  const src = ideas.value.find((i) => i.id === idea.id);
  if (src) src.status = u.status;
}
const conclusionText = ref('');
/** 结论 placeholder — i18n 走 t() (函数; 模块级常量非响应式). */
function concludeHintFor(status: string): string {
  const hints: Record<string, string> = {
    rejected: t('misc.ideas.hintRejected'),
    decided: t('misc.ideas.hintDecided'),
    shelved: t('misc.ideas.hintShelved'),
    landed: t('misc.ideas.hintLanded'),
  };
  return hints[status] ?? t('misc.ideas.hintDefault');
}
async function conclude(idea: Idea, status: 'decided' | 'rejected' | 'shelved' | 'landed') {
  const c = conclusionText.value.trim();
  if (!c) { toast.error(t('misc.ideas.errConcludeEmpty')); return; }
  await updateIdea(idea.id, { conclusion: c, status });
  conclusionText.value = '';
  await refreshDetail(); await refresh();
}
async function addNode() {
  if (!selectedId.value || !newNodeTitle.value.trim() || !detail.value) return;
  await createIdeaNode(selectedId.value, { title: newNodeTitle.value.trim() });
  newNodeTitle.value = '';
  await refreshDetail(); await refresh();
}
async function setNodeStatus(node: IdeaNode, status: string) {
  await updateIdeaNode(node.id, { status });
  await refreshDetail(); await refresh();
}
const dispatchNodeId = ref<string | null>(null);
const dispatchTitle = ref('');
async function dispatchFromNode(node: IdeaNode) {
  if (dispatchNodeId.value !== node.id) {
    dispatchNodeId.value = node.id;
    dispatchTitle.value = node.title;
    return;
  }
  const title = dispatchTitle.value.trim();
  dispatchNodeId.value = null;
  if (!title || !detail.value) return;
  // 改名 task: 原 const t 会遮蔽 i18n 的 t(), 调 t('...') 会炸 (i18n W3c B2 迁移时修)
  const task = await createTask({
    title,
    prompt: `【构思节点任务】构思「${detail.value.idea.title}」/ 节点「${node.title}」。\n${node.detail ?? ''}\n\n完成后把结果与该节点的验证判据关联起来汇报。`,
    project_id: detail.value.idea.project_id ?? '',
    idea_id: detail.value.idea.id,
    node_id: node.id,
    work_class: 'plan',
    autoApprove: true,
  });
  await startTask(task.id);
  toast.success(t('misc.ideas.taskDispatched'));
  await refreshDetail(); await refresh();
  router.push(`/tasks/${task.id}`);
}
// ---- 节点 DAG 画布 (docs/plans/idea-node-dag.md ①→Dify 式重构 1014) ----
// 画布接管中间主区 (3D v-show 隐藏保实例); Dify 式: 节点卡(状态色条+摘要+桩) /
// 滚轮缩放+拖空白平移+适配视图 / 节点拖拽 pos 落库 / 拖输出桩→目标卡=建依赖(环 400 toast).
// 颜色只给状态; running 节点 = 游标(琥珀虚线流动环); hover 聚焦直接上下游.
const NODE_W = 224, NODE_H = 78, HGAP = 56, VGAP = 60, DAG_PAD = 24;
const NODE_STATUS_COLOR: Record<string, string> = {
  planned: '#94a3b8', dispatched: '#818cf8', running: '#fbbf24', reviewing: '#38bdf8',
  awaiting_decision: '#a78bfa', blocked: '#f87171', done: '#4ade80', dropped: '#475569',
};
const hoveredNodeId = ref<string | null>(null);
const selectedNodeId = ref<string | null>(null);
const dagStageRef = ref<HTMLElement | null>(null);
// 画布视图: k=缩放, x/y=平移 (canvas 坐标 = (screen - rect.topleft - x) / k)
const view = reactive({ x: 0, y: 0, k: 1 });

interface DagBox { node: IdeaNode; x: number; y: number }
interface DagEdge { id: string; from: string; to: string; run: boolean }

// topo 自动布局作基线, pos_x/pos_y 手摆覆盖 (有 pos 用 pos, 无 pos 用 topo 位).
const dagLayout = computed<{ boxes: DagBox[]; edges: DagEdge[]; minX: number; minY: number; w: number; h: number } | null>(() => {
  const nodes = detail.value?.nodes ?? [];
  if (!nodes.length) return null;
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const depth = new Map<string, number>();
  const depthOf = (id: string, path: Set<string>): number => {
    const memo = depth.get(id);
    if (memo !== undefined) return memo;
    if (path.has(id)) return 0; // 服务端已拒环, 纯防御兜底
    path.add(id);
    const n = byId.get(id);
    const d = (n?.depends_on ?? [])
      .filter((dep) => byId.has(dep))
      .reduce((m, dep) => Math.max(m, depthOf(dep, path) + 1), 0);
    depth.set(id, d);
    return d;
  };
  nodes.forEach((n) => depthOf(n.id, new Set()));

  const layers = new Map<number, string[]>();
  nodes.forEach((n) => {
    const arr = layers.get(depth.get(n.id)!) ?? [];
    arr.push(n.id);
    layers.set(depth.get(n.id)!, arr);
  });
  const auto = new Map<string, { x: number; y: number }>();
  let maxCols = 0, maxDepth = 0;
  [...layers.keys()].sort((a, b) => a - b).forEach((d) => {
    maxDepth = Math.max(maxDepth, d);
    layers.get(d)!.forEach((id, i) => {
      auto.set(id, { x: DAG_PAD + i * (NODE_W + HGAP), y: DAG_PAD + d * (NODE_H + VGAP) });
      maxCols = Math.max(maxCols, i + 1);
    });
  });
  const boxes: DagBox[] = nodes.map((n) => ({
    node: n,
    x: n.pos_x ?? auto.get(n.id)!.x,
    y: n.pos_y ?? auto.get(n.id)!.y,
  }));
  const edges: DagEdge[] = [];
  nodes.forEach((n) => n.depends_on.forEach((dep) => {
    if (!byId.has(dep)) return;
    edges.push({ id: `${dep}>${n.id}`, from: dep, to: n.id, run: n.status === 'running' });
  }));
  const xs = boxes.map((b) => b.x), ys = boxes.map((b) => b.y);
  const minX = Math.min(...xs), minY = Math.min(...ys);
  return {
    boxes, edges, minX, minY,
    w: Math.max(...xs) + NODE_W - minX,
    h: Math.max(...ys) + NODE_H - minY,
  };
});

// 拖动中的实时位覆盖 (computed 内普通对象不触发渲染, 拖动位走这个 ref)
const dragPos = ref<{ id: string; x: number; y: number } | null>(null);
function boxPos(id: string): { x: number; y: number } | null {
  const dp = dragPos.value;
  if (dp && dp.id === id) return { x: dp.x, y: dp.y };
  return dagLayout.value?.boxes.find((b) => b.node.id === id) ?? null;
}
function handleOut(id: string): { x: number; y: number } | null {
  const b = boxPos(id);
  return b ? { x: b.x + NODE_W, y: b.y + NODE_H / 2 } : null;
}
function bezier(x1: number, y1: number, x2: number, y2: number): string {
  const mx = (x1 + x2) / 2;
  return `M ${x1} ${y1} C ${mx} ${y1}, ${mx} ${y2}, ${x2} ${y2}`;
}
function edgePath(e: DagEdge): string {
  const a = handleOut(e.from), b = boxPos(e.to);
  if (!a || !b) return '';
  return bezier(a.x, a.y, b.x, b.y + NODE_H / 2);
}
// 拖线中: 输出桩 → 当前鼠标点 (canvas 坐标) 的临时贝塞尔
const connectingPath = computed(() => {
  if (!connecting.value) return '';
  const a = handleOut(connecting.value.from);
  if (!a) return '';
  return bezier(a.x, a.y, connecting.value.x, connecting.value.y);
});
function dagNodeDim(id: string): boolean {
  const h = hoveredNodeId.value;
  if (!h || h === id) return false;
  const nodes = detail.value?.nodes ?? [];
  const hn = nodes.find((n) => n.id === h), n = nodes.find((x) => x.id === id);
  return !!hn && !!n && !hn.depends_on.includes(id) && !n.depends_on.includes(h);
}
function dagEdgeDim(e: DagEdge): boolean {
  const h = hoveredNodeId.value;
  return !!h && e.from !== h && e.to !== h;
}
const selectedNode = computed(() => detail.value?.nodes.find((n) => n.id === selectedNodeId.value) ?? null);
function selectNode(n: IdeaNode) {
  selectedNodeId.value = selectedNodeId.value === n.id ? null : n.id;
  if (!selectedNodeId.value) dispatchNodeId.value = null;
}
function nodeColor(n: IdeaNode): string {
  return NODE_STATUS_COLOR[n.status] ?? '#94a3b8';
}
function shortTitle(t: string): string {
  return t.length > 26 ? t.slice(0, 26) + '…' : t;
}
function depTitles(n: IdeaNode): Array<{ id: string; title: string }> {
  const byId = new Map((detail.value?.nodes ?? []).map((x) => [x.id, x]));
  return n.depends_on.map((d) => ({ id: d, title: byId.get(d)?.title ?? d }));
}
function shortDetail(t: string | null): string {
  const s = (t ?? '').trim();
  return s.length > 64 ? s.slice(0, 64) + '…' : s;
}

// ---- 画布视图操作: 缩放 / 平移 / 适配 ----
function stageSize(): { w: number; h: number } {
  const el = dagStageRef.value;
  return { w: el?.clientWidth ?? 800, h: el?.clientHeight ?? 480 };
}
function toCanvas(clientX: number, clientY: number): { x: number; y: number } {
  const r = dagStageRef.value?.getBoundingClientRect();
  return { x: ((clientX - (r?.left ?? 0)) - view.x) / view.k, y: ((clientY - (r?.top ?? 0)) - view.y) / view.k };
}
function fitView() {
  const dag = dagLayout.value;
  const { w: sw, h: sh } = stageSize();
  if (!dag || !sw) return;
  const pad = 32;
  view.k = Math.min(1.25, Math.max(0.3, Math.min((sw - pad * 2) / dag.w, (sh - pad * 2) / dag.h)));
  view.x = (sw - dag.w * view.k) / 2 - dag.minX * view.k;
  view.y = (sh - dag.h * view.k) / 2 - dag.minY * view.k;
}
function onStageWheel(e: WheelEvent) {
  e.preventDefault();
  const r = dagStageRef.value?.getBoundingClientRect();
  const cx = e.clientX - (r?.left ?? 0), cy = e.clientY - (r?.top ?? 0);
  const f = e.deltaY < 0 ? 1.12 : 1 / 1.12;
  const k2 = Math.min(2.5, Math.max(0.25, view.k * f));
  const rr = k2 / view.k;
  view.x = cx - (cx - view.x) * rr;
  view.y = cy - (cy - view.y) * rr;
  view.k = k2;
}

// ---- 画布指针交互: 平移 / 拖节点 / 拖线建依赖 ----
// 三态互斥: stagePan(空白拖) / nodeDrag(卡拖, 超 4px 才算, 否则 click 选中) / connecting(桩拖线).
// stagePan 与 3D orbit 的 panning 是两套 (作用域不同物), 前缀区分免重名.
let stagePan: { sx: number; sy: number; vx: number; vy: number } | null = null;
let nodeDrag: { id: string; dx: number; dy: number; moved: boolean } | null = null;
const connecting = ref<{ from: string; x: number; y: number } | null>(null);
const dropTargetId = ref<string | null>(null);

function onStageDown(e: PointerEvent) {
  if ((e.target as HTMLElement).closest('.dag-card')) return;
  stagePan = { sx: e.clientX, sy: e.clientY, vx: view.x, vy: view.y };
}
function onCardDown(n: IdeaNode, e: PointerEvent) {
  if ((e.target as HTMLElement).closest('.dag-handle')) return;
  e.stopPropagation();
  const c = toCanvas(e.clientX, e.clientY);
  const box = dagLayout.value?.boxes.find((b) => b.node.id === n.id);
  if (!box) return;
  nodeDrag = { id: n.id, dx: c.x - box.x, dy: c.y - box.y, moved: false };
}
function onHandleDown(n: IdeaNode, e: PointerEvent) {
  e.stopPropagation();
  e.preventDefault();
  const c = toCanvas(e.clientX, e.clientY);
  connecting.value = { from: n.id, x: c.x, y: c.y };
}
function onStageMove(e: PointerEvent) {
  if (stagePan) {
    view.x = stagePan.vx + (e.clientX - stagePan.sx);
    view.y = stagePan.vy + (e.clientY - stagePan.sy);
    return;
  }
  const c = toCanvas(e.clientX, e.clientY);
  if (connecting.value) {
    connecting.value = { ...connecting.value, x: c.x, y: c.y };
    const hit = dagLayout.value?.boxes.find((b) => c.x >= b.x && c.x <= b.x + NODE_W && c.y >= b.y && c.y <= b.y + NODE_H);
    dropTargetId.value = hit && hit.node.id !== connecting.value.from ? hit.node.id : null;
    return;
  }
  const nd = nodeDrag;
  if (nd) {
    const box = dagLayout.value?.boxes.find((b) => b.node.id === nd.id);
    if (!box) return;
    if (!nd.moved && Math.hypot(c.x - box.x - nd.dx, c.y - box.y - nd.dy) * view.k < 4) return;
    nd.moved = true;
    box.x = Math.max(0, c.x - nd.dx);
    box.y = Math.max(0, c.y - nd.dy);
    dragPos.value = { id: nd.id, x: box.x, y: box.y };
  }
}
async function onStageUp() {
  if (connecting.value) {
    const from = connecting.value.from, to = dropTargetId.value;
    connecting.value = null; dropTargetId.value = null;
    if (to) await addDep(from, to);
  }
  const nd = nodeDrag;
  if (nd) {
    const box = dagLayout.value?.boxes.find((b) => b.node.id === nd.id);
    const moved = nd.moved;
    const id = nd.id;
    nodeDrag = null;
    dragPos.value = null;
    if (box && moved) {
      try {
        await updateIdeaNode(id, { pos_x: Math.round(box.x), pos_y: Math.round(box.y) });
        await refreshDetail();
      } catch (err: any) { toast.error(err?.message ?? t('misc.ideas.posSaveFailed')); }
    } else if (!moved) {
      const n = detail.value?.nodes.find((x) => x.id === id);
      if (n) selectNode(n);
    }
  }
  stagePan = null;
}
async function addDep(fromId: string, toId: string) {
  const n = detail.value?.nodes.find((x) => x.id === toId);
  if (!n) return;
  if (n.depends_on.includes(fromId)) { toast.error(t('misc.ideas.depExists')); return; }
  try {
    await updateIdeaNode(toId, { deps: [...n.depends_on, fromId] });
    toast.success(t('misc.ideas.depAdded'));
    await refreshDetail(); await refresh();
  } catch (err: any) {
    toast.error(err?.message?.includes('cycle') ? t('misc.ideas.depCycle') : (err?.message ?? t('misc.ideas.depFailed')));
  }
}
async function removeDep(toId: string, depId: string) {
  const n = detail.value?.nodes.find((x) => x.id === toId);
  if (!n) return;
  await updateIdeaNode(toId, { deps: n.depends_on.filter((d) => d !== depId) });
  await refreshDetail(); await refresh();
}
async function autoLayout() {
  const nodes = detail.value?.nodes ?? [];
  await Promise.all(nodes.filter((n) => n.pos_x !== null || n.pos_y !== null)
    .map((n) => updateIdeaNode(n.id, { pos_x: null, pos_y: null })));
  await refreshDetail();
  fitView();
}
watch(selectedId, () => { selectedNodeId.value = null; hoveredNodeId.value = null; nextTick(() => fitView()); });
watch(() => detail.value?.nodes.length, () => nextTick(() => fitView()));

async function addSignal() {
  if (!selectedId.value) return;
  await addIdeaSignal(selectedId.value, {
    kind: newSignal.kind,
    value: newSignal.value === '' ? null : Number(newSignal.value),
    note: newSignal.note || null,
    ref: newSignal.ref || null,
  });
  newSignal.value = ''; newSignal.note = ''; newSignal.ref = '';
  await refreshDetail(); await refresh();
}
async function removeSignal(id: string) {
  const { del } = await import('@/api/http');
  await del(`/api/idea-signals/${id}`);
  await refreshDetail();
}
async function createNewIdea() {
  if (!createForm.title.trim()) return;
  const idea = await createIdea({
    title: createForm.title.trim(),
    hypothesis: createForm.hypothesis || null,
    success_criteria: createForm.success_criteria || null,
    deadline: createForm.deadline || null,
  });
  showCreate.value = false;
  createForm.title = ''; createForm.hypothesis = ''; createForm.success_criteria = ''; createForm.deadline = '';
  await refresh();
  openDetail(idea.id);
}

// ---- 生命周期 ----
function onResize() { projectOverlay(); }

function onGlobalMouseMove(e: MouseEvent) { onDragMove(e); }
function onGlobalMouseUp() { onDragUp(); }

onMounted(async () => {
  await refresh();
  initLayout();
  applyTimelineLayout();
  await init3d();
  window.addEventListener('resize', onResize);
  window.addEventListener('mousemove', onGlobalMouseMove);
  window.addEventListener('mouseup', onGlobalMouseUp);
  window.addEventListener('keydown', onKeydown);
  window.addEventListener('keyup', onKeyup);
  window.addEventListener('mousemove', onCanvasMouseMove);
  window.addEventListener('mouseup', onCanvasMouseUp);
  window.addEventListener('pointermove', onStageMove);
  window.addEventListener('pointerup', onStageUp);
  keyInterval = window.setInterval(onKeyMove, 30);
  (window as any).__ideaDebug = {
    get app() { return app; },
    get cam() { return camEntity; },
    get camComp() { return camComp; },
    get spheres() { return sphereEntities.size; },
  };
});
onBeforeUnmount(() => {
  window.removeEventListener('resize', onResize);
  window.removeEventListener('mousemove', onGlobalMouseMove);
  window.removeEventListener('mouseup', onGlobalMouseUp);
  window.removeEventListener('keydown', onKeydown);
  window.removeEventListener('keyup', onKeyup);
  window.removeEventListener('mousemove', onCanvasMouseMove);
  window.removeEventListener('mouseup', onCanvasMouseUp);
  window.removeEventListener('pointermove', onStageMove);
  window.removeEventListener('pointerup', onStageUp);
  if (keyInterval) window.clearInterval(keyInterval);
  cancelAnimationFrame(rafId);
  if (app) { app.destroy(); app = null; }
});

watch(viewMode, (m) => {
  if (m === 'timeline') applyTimelineLayout();
  else layoutDirty.value = true;
});
watch(ideas, () => { initLayout(); if (viewMode.value === 'timeline') applyTimelineLayout(); }, { deep: false });

const concludeHint = computed(() => concludeHintFor(detail.value?.idea.status ?? ''));
function openExport(id: string) {
  window.open(`/api/ideas/${id}/export`, '_blank');
}
const selectedIdea = computed(() => ideas.value.find((i) => i.id === selectedId.value) ?? null);
</script>

<template>
  <div class="ideas-page">
    <div class="ideas-toolbar">
      <div class="mode-switch">
        <button :class="{ on: viewMode === 'force' }" @click="viewMode = 'force'" :title="t('misc.ideas.modeForceTitle')">🕸 {{ t('misc.ideas.modeForce') }}</button>
        <button :class="{ on: viewMode === 'timeline' }" @click="viewMode = 'timeline'" :title="t('misc.ideas.modeTimelineTitle')">📅 {{ t('misc.ideas.modeTimeline') }}</button>
      </div>
      <div class="toolbar-right">
        <button class="primary" @click="showCreate = true">{{ t('misc.ideas.newIdea') }}</button>
      </div>
    </div>

    <div class="ideas-body">
      <!-- 左栏: 人工分拣列表 (P1); P3 自由摆模式下收起, 列表浮到画布上 -->
      <aside v-if="!freeMode" class="lists-rail">
        <div class="rail-head">{{ t('misc.ideas.listsTitle') }}
          <button class="rail-toggle" :title="t('misc.ideas.freeModeTitle')" @click="toggleFreeMode">⇄ {{ t('misc.ideas.freeMode') }}</button>
        </div>
        <div class="rail-scroll">
          <div v-for="l in lists" :key="l.id" class="pin-list">
            <div class="pl-head">
              <input
                v-if="editingListId === l.id" v-model="editingListTitle" class="pl-rename"
                @keydown.enter="commitRenameList(l)" @blur="commitRenameList(l)"
              />
              <span v-else class="pl-title">{{ l.title }}</span>
              <span class="pl-ops">
                <button :title="t('misc.ideas.moveUp')" @click="moveList(l, -1)">↑</button>
                <button :title="t('misc.ideas.moveDown')" @click="moveList(l, 1)">↓</button>
                <button :title="t('misc.ideas.rename')" @click="startRenameList(l)">✏</button>
                <button :title="removingListId === l.id ? t('misc.ideas.confirmDeleteAgain') : t('misc.ideas.deleteList')" :class="{ confirm: removingListId === l.id }" @click="confirmRemoveList(l)">🗑</button>
              </span>
            </div>
            <div v-for="(item, idx) in l.items" :key="item.id" class="pl-item" :class="{ missing: item.missing }">
              <span class="pl-ref" :class="'rt-' + item.ref_type" @click="!item.missing && openRef(item.ref_type, item.ref_id)">{{ item.title }}</span>
              <span class="pl-item-ops">
                <button :title="t('misc.ideas.moveUp')" @click="reorderItem(l, idx, -1)">↑</button>
                <button :title="t('misc.ideas.moveDown')" @click="reorderItem(l, idx, 1)">↓</button>
                <button :title="t('misc.ideas.removeItem')" @click="removeItem(l, item.id)">✕</button>
              </span>
            </div>
            <button v-if="selectedId" class="pl-put" @click="putIdeaIntoList(l.id)">{{ t('misc.ideas.putCurrent') }}</button>
          </div>
        </div>
        <div class="rail-new">
          <input v-model="newListTitle" :placeholder="t('misc.ideas.phNewList')" @keydown.enter="addList" />
          <button @click="addList">{{ t('misc.ideas.createListBtn') }}</button>
        </div>
      </aside>
      <div v-else class="lists-mini">
        <button class="rail-toggle" @click="toggleFreeMode">⇅ {{ t('misc.ideas.collapseLists') }}</button>
      </div>

      <!-- 中: 3D 画布 (点球下钻后隐藏, workbench 接管; v-show 保 playcanvas 实例) -->
      <div v-show="!selectedIdea" class="canvas-wrap">
        <!-- 相机: mousedown 起 orbit/pan, move/up 挂 window (拖出画布不断手) -->
        <canvas
          ref="canvasRef" class="idea-canvas"
          @wheel.prevent="onWheel"
          @mousedown="onCanvasMouseDown"
          @contextmenu.prevent
        ></canvas>
        <svg class="edge-svg">
          <line
            v-for="(s, i) in edgeSegments" :key="i"
            :x1="s.x1" :y1="s.y1" :x2="s.x2" :y2="s.y2"
            :stroke="s.dashed ? 'rgba(129,140,248,.35)' : 'rgba(129,140,248,.6)'"
            :stroke-dasharray="s.dashed ? '4 4' : undefined"
            stroke-width="1.2"
          />
        </svg>
        <div ref="overlayRef" class="sphere-overlay">
          <div
            v-for="idea in ideas" :key="idea.id"
            class="sphere-label"
            :class="{ selected: idea.id === selectedId }"
            :style="{
              left: (projected.get(idea.id)?.sx ?? -999) + 'px',
              top: (projected.get(idea.id)?.sy ?? -999) + 'px',
              opacity: projected.get(idea.id)?.visible ? 1 : 0,
            }"
            @click="openDetail(idea.id)"
          >
            <span class="sl-title">{{ idea.title }}</span>
            <span class="sl-meta">{{ ideaStatusLabel(idea.status) }} · {{ t('misc.ideas.sphereTasks', { n: idea.task_count }) }}</span>
          </div>
        </div>
        <!-- P3 自由摆: 列表浮卡 (拖头部移动, 位置持久化 dashboard_blocks) -->
        <div
          v-for="l in lists" :key="l.id"
          class="list-card"
          :class="{ dragging: draggingList?.id === l.id }"
          :style="{
            left: (listPos.get(l.id) ?? defaultPos(lists.indexOf(l))).x + 'px',
            top: (listPos.get(l.id) ?? defaultPos(lists.indexOf(l))).y + 'px',
            display: freeMode ? 'block' : 'none',
          }"
        >
          <div class="pl-head card-head" @mousedown="startDragList(l, $event)">
            <span class="pl-title">{{ l.title }}</span>
            <span class="pl-ops">
              <button :title="t('misc.ideas.rename')" @click.stop="startRenameList(l)">✏</button>
              <button :title="t('misc.ideas.deleteList')" @click.stop="confirmRemoveList(l)">🗑</button>
            </span>
          </div>
          <div v-for="(item, idx) in l.items" :key="item.id" class="pl-item" :class="{ missing: item.missing }">
            <span class="pl-ref" :class="'rt-' + item.ref_type" @click="!item.missing && openRef(item.ref_type, item.ref_id)">{{ item.title }}</span>
            <button class="pl-item-ops" @click="removeItem(l, item.id)">✕</button>
          </div>
          <button v-if="selectedId" class="pl-put" @click="putIdeaIntoList(l.id)">{{ t('misc.ideas.putCurrent') }}</button>
        </div>
        <div v-if="loading" class="canvas-loading">{{ t('misc.ideas.loading') }}</div>
        <div v-if="!loading && ideas.length === 0" class="canvas-empty">
          <p>{{ t('misc.ideas.emptyTitle') }}</p>
          <p class="hint">{{ t('misc.ideas.emptyHint') }}</p>
        </div>
      </div>

      <!-- 中下钻: 节点 DAG 画布主区 (idea-node-dag ① Dify 式, ≥1/4 页面; 3D 隐藏保实例) -->
      <section v-if="selectedIdea" class="idea-workbench">
        <header class="wb-bar">
          <button class="wb-back" :title="t('misc.ideas.backTitle')" @click="selectedId = null; detail = null">←</button>
          <h2 class="wb-title">{{ detail?.idea.title }}</h2>
          <select
            v-if="detail" :value="detail.idea.status"
            @change="setStatus(detail.idea, ($event.target as HTMLSelectElement).value as IdeaStatus)"
          >
            <option v-for="(label, key) in IDEA_STATUS_LABELS" :key="key" :value="key">{{ t(label) }}</option>
          </select>
          <span v-if="detail?.roi" class="wb-roi">
            {{ t('misc.ideas.wbRoi', { cost: detail.roi.cost_usd.toFixed(2), n: detail.roi.task_count, pay: detail.roi.payment_total }) }}
            <b v-if="detail.roi.overdue" class="wb-overdue">{{ t('misc.ideas.overdue') }}</b>
          </span>
          <button class="sm wb-export" @click="openExport(detail!.idea.id)">{{ t('misc.ideas.exportMd') }}</button>
        </header>
        <div
          ref="dagStageRef" class="dag-stage"
          :style="{ backgroundPosition: view.x + 'px ' + view.y + 'px', backgroundSize: (26 * view.k) + 'px ' + (26 * view.k) + 'px' }"
          @wheel="onStageWheel"
          @pointerdown="onStageDown"
          @dblclick="fitView"
        >
          <svg class="dag-svg" :width="'100%'" :height="'100%'">
            <g :transform="`translate(${view.x} ${view.y}) scale(${view.k})`">
              <path
                v-for="e in dagLayout?.edges ?? []" :key="e.id" class="dag-edge"
                :class="{ dim: dagEdgeDim(e), run: e.run }"
                :d="edgePath(e)" :marker-end="e.run ? 'url(#dag-arrow-run)' : 'url(#dag-arrow)'"
              />
              <path v-if="connecting" class="dag-edge connecting" :d="connectingPath" />
              <foreignObject
                v-for="b in dagLayout?.boxes ?? []" :key="b.node.id"
                :x="boxPos(b.node.id)?.x ?? b.x" :y="boxPos(b.node.id)?.y ?? b.y" :width="NODE_W" :height="NODE_H"
              >
                <div
                  xmlns="http://www.w3.org/1999/xhtml"
                  class="dag-card" :class="{ dim: dagNodeDim(b.node.id), sel: b.node.id === selectedNodeId, drop: b.node.id === dropTargetId }"
                  :style="{ '--st': nodeColor(b.node) }"
                  @pointerdown="onCardDown(b.node, $event)"
                  @mouseenter="hoveredNodeId = b.node.id"
                  @mouseleave="hoveredNodeId = null"
                >
                  <div v-if="b.node.status === 'running'" class="dag-cursor"></div>
                  <div class="dag-card-head">
                    <span class="dag-card-title" :title="b.node.title">{{ shortTitle(b.node.title) }}</span>
                    <span v-if="b.node.task_count" class="dag-badge">{{ t('misc.ideas.dagBadge', { n: b.node.task_count }) }}</span>
                  </div>
                  <div v-if="b.node.detail" class="dag-card-detail">{{ shortDetail(b.node.detail) }}</div>
                  <div class="dag-card-foot">
                    <span class="dag-chip">{{ nodeStatusLabel(b.node.status) }}</span>
                    <span class="dag-deps">{{ b.node.depends_on.length ? t('misc.ideas.depsUp', { n: b.node.depends_on.length }) : t('misc.ideas.depsStart') }}</span>
                  </div>
                  <span
                    class="dag-handle dag-handle-in" :class="{ hit: b.node.id === dropTargetId }"
                    @pointerdown.stop.prevent="onHandleDown(b.node, $event)"
                  ></span>
                  <span
                    class="dag-handle dag-handle-out"
                    :title="t('misc.ideas.handleTitle')"
                    @pointerdown.stop.prevent="onHandleDown(b.node, $event)"
                  ></span>
                </div>
              </foreignObject>
            </g>
          </svg>
          <div v-if="!detailLoading && (detail?.nodes.length ?? 0) === 0" class="dag-empty">
            {{ t('misc.ideas.dagEmpty') }}
          </div>
          <div class="dag-add">
            <input v-model="newNodeTitle" :placeholder="t('misc.ideas.phNewNode')" @keydown.enter="addNode" />
            <button class="sm" @click="addNode">{{ t('misc.ideas.addNode') }}</button>
          </div>
          <div class="dag-toolbar">
            <button :title="t('misc.ideas.zoomOut')" @click="view.k = Math.max(0.25, view.k / 1.2)">−</button>
            <span class="dag-zoom">{{ Math.round(view.k * 100) }}%</span>
            <button :title="t('misc.ideas.zoomIn')" @click="view.k = Math.min(2.5, view.k * 1.2)">＋</button>
            <button :title="t('misc.ideas.fitView')" @click="fitView">⤢</button>
            <button :title="t('misc.ideas.autoLayoutTitle')" @click="autoLayout">{{ t('misc.ideas.autoLayout') }}</button>
          </div>
          <div class="dag-hint">{{ t('misc.ideas.dagHint') }}</div>
        </div>
      </section>

      <!-- 右: 详情抽屉 -->
      <aside v-if="selectedIdea" class="detail-drawer">
        <button class="drawer-close" @click="selectedId = null; detail = null">✕</button>
        <div v-if="detailLoading" class="drawer-loading">…</div>
        <template v-else-if="detail">
          <h2 class="d-title">{{ detail.idea.title }}</h2>

          <!-- 选中节点面板 (Dify 式: 点卡右栏出配置; 派任务/状态/上游增删都在这) -->
          <div v-if="selectedNode" class="d-block node-panel">
            <div class="np-head">
              <span class="np-title">{{ selectedNode.title }}</span>
              <button class="sm" @click="selectNode(selectedNode!)">✕</button>
            </div>
            <select :value="selectedNode.status" @change="setNodeStatus(selectedNode!, ($event.target as HTMLSelectElement).value)">
              <option v-for="(label, key) in NODE_STATUS_LABELS" :key="key" :value="key">{{ t(label) }}</option>
            </select>
            <div class="np-meta">{{ t('misc.ideas.upstreamLabel') }}</div>
            <div v-if="depTitles(selectedNode).length" class="np-deps">
              <span v-for="d in depTitles(selectedNode)" :key="d.id" class="np-dep">
                {{ d.title }}<button :title="t('misc.ideas.removeDep')" @click="removeDep(selectedNode!.id, d.id)">×</button>
              </span>
            </div>
            <div v-else class="np-meta">{{ t('misc.ideas.noDeps') }}</div>
            <div v-if="selectedNode.detail" class="np-detail">{{ selectedNode.detail }}</div>
            <div class="np-ops">
              <button class="sm" @click="dispatchFromNode(selectedNode!)">{{ dispatchNodeId === selectedNode.id ? t('misc.ideas.confirmDispatch') : t('misc.ideas.dispatchTask') }}</button>
            </div>
            <input
              v-if="dispatchNodeId === selectedNode.id" v-model="dispatchTitle" class="node-dispatch-title"
              :placeholder="t('misc.ideas.phDispatchTitle')" @keydown.enter="dispatchFromNode(selectedNode!)"
            />
          </div>

          <div v-if="detail.idea.hypothesis" class="d-block">
            <div class="d-label">{{ t('misc.ideas.hypothesisLabel') }}</div>
            <div class="d-text">{{ detail.idea.hypothesis }}</div>
          </div>
          <div v-if="detail.idea.success_criteria" class="d-block">
            <div class="d-label">{{ t('misc.ideas.criteriaLabel') }}</div>
            <div class="d-text">{{ detail.idea.success_criteria }}</div>
          </div>

          <div v-if="detail.roi" class="d-block roi" :class="{ overdue: detail.roi.overdue }">
            <div class="d-label">{{ t('misc.ideas.roiLabel') }}</div>
            <div class="roi-grid">
              <span>{{ t('misc.ideas.roiCost', { cost: detail.roi.cost_usd.toFixed(2) }) }}</span>
              <span>{{ t('misc.ideas.roiTasks', { n: detail.roi.task_count }) }}</span>
              <span>{{ t('misc.ideas.roiInquiry', { n: detail.roi.inquiry_count }) }}</span>
              <span>{{ t('misc.ideas.roiSignup', { n: detail.roi.signup_count }) }}</span>
              <span class="roi-pay">{{ t('misc.ideas.roiPay', { pay: detail.roi.payment_total }) }}</span>
              <span v-if="detail.roi.window_left_days !== null">{{ t('misc.ideas.roiWindow', { n: detail.roi.window_left_days, flag: detail.roi.overdue ? ' 🔴' : '' }) }}</span>
            </div>
          </div>

          <div class="d-block">
            <div class="d-label">{{ t('misc.ideas.signalsLabel', { n: detail.signals.length }) }}</div>
            <div v-for="s in detail.signals" :key="s.id" class="sig-row">
              <span class="sig-kind">{{ signalLabel(s.kind) }}</span>
              <span v-if="s.value !== null" class="sig-val">{{ s.value }}</span>
              <span class="sig-note">{{ s.note }}</span>
              <button class="sm" @click="removeSignal(s.id)">✕</button>
            </div>
            <div class="sig-add">
              <select v-model="newSignal.kind">
                <option v-for="kind in signalKinds" :key="kind" :value="kind">{{ signalLabel(kind) }}</option>
              </select>
              <input v-model="newSignal.value" :placeholder="t('misc.ideas.phValue')" class="w60" />
              <input v-model="newSignal.note" :placeholder="t('misc.ideas.phNote')" />
              <button @click="addSignal">＋</button>
            </div>
          </div>

          <div class="d-block">
            <div class="d-label">{{ t('misc.ideas.tasksLabel', { n: detail.tasks.length }) }}</div>
            <div v-for="t in detail.tasks" :key="t.id" class="task-row" @click="router.push(`/tasks/${t.id}`)">
              <span class="t-status">{{ t.status }}</span>
              <span class="t-title">{{ t.title }}</span>
              <span class="t-cost">${{ (t.cost_usd ?? 0).toFixed(2) }}</span>
            </div>
          </div>

          <div class="d-block">
            <div class="d-label">{{ t('misc.ideas.conclusionLabel') }}</div>
            <div v-if="detail.idea.conclusion" class="d-text">{{ detail.idea.conclusion }}</div>
            <textarea v-model="conclusionText" class="conclude-input" rows="2" :placeholder="concludeHint" />
            <div class="conclude-btns">
              <button @click="conclude(detail.idea, 'decided')">{{ t('misc.ideas.concludeDecided') }}</button>
              <button class="danger" @click="conclude(detail.idea, 'rejected')">{{ t('misc.ideas.concludeRejected') }}</button>
              <button @click="conclude(detail.idea, 'shelved')">{{ t('misc.ideas.concludeShelved') }}</button>
              <button @click="conclude(detail.idea, 'landed')">{{ t('misc.ideas.concludeLanded') }}</button>
            </div>
          </div>
          <button class="sm export-btn" @click="openExport(detail.idea.id)">{{ t('misc.ideas.exportMdFull') }}</button>
        </template>
      </aside>
    </div>

    <!-- 新建构思弹窗 -->
    <div v-if="showCreate" class="modal-mask" @click.self="showCreate = false">
      <div class="modal-card">
        <h3>{{ t('misc.ideas.createTitle') }}</h3>
        <label>{{ t('misc.ideas.labelTitle') }}<input v-model="createForm.title" :placeholder="t('misc.ideas.phTitle')" /></label>
        <label>{{ t('misc.ideas.labelHypothesis') }}<textarea v-model="createForm.hypothesis" rows="2" /></label>
        <label>{{ t('misc.ideas.labelCriteria') }}<input v-model="createForm.success_criteria" :placeholder="t('misc.ideas.phCriteria')" /></label>
        <label>{{ t('misc.ideas.labelDeadline') }}<input v-model="createForm.deadline" type="date" /></label>
        <div class="modal-ops">
          <button @click="showCreate = false">{{ t('misc.ideas.cancel') }}</button>
          <button class="primary" :disabled="!createForm.title.trim()" @click="createNewIdea">{{ t('misc.ideas.createBtn') }}</button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.ideas-page { display: flex; flex-direction: column; height: 100%; overflow: hidden; }
.ideas-toolbar { display: flex; justify-content: space-between; align-items: center; padding: 10px 16px; border-bottom: 1px solid var(--border, #1f2937); }
.mode-switch button, .toolbar-right button { background: transparent; border: 1px solid var(--border, #1f2937); color: var(--text, #e2e8f0); border-radius: 8px; padding: 6px 14px; cursor: pointer; margin-right: 6px; }
.mode-switch button.on { border-color: #818cf8; color: #a5b4fc; }
.toolbar-right button.primary { background: #4f46e5; border-color: #4f46e5; }
.ideas-body { display: flex; flex: 1; min-height: 0; position: relative; }
.lists-rail { width: 264px; border-right: 1px solid var(--border, #1f2937); display: flex; flex-direction: column; }
.rail-head { padding: 10px 12px; font-size: 12px; color: #94a3b8; letter-spacing: 1px; display: flex; justify-content: space-between; align-items: center; }
.rail-toggle { background: rgba(99, 102, 241, .15); border: 1px solid rgba(129, 140, 248, .4); color: #a5b4fc; border-radius: 6px; padding: 2px 8px; cursor: pointer; font-size: 11px; }
.lists-mini { width: 40px; border-right: 1px solid var(--border, #1f2937); padding: 10px 4px; }
.lists-mini .rail-toggle { width: 100%; writing-mode: vertical-rl; padding: 8px 2px; }
.list-card { position: absolute; width: 240px; background: rgba(13, 20, 38, .92); border: 1px solid rgba(129, 140, 248, .4); border-radius: 10px; padding: 8px; z-index: 5; box-shadow: 0 6px 24px rgba(0, 0, 0, .5); backdrop-filter: blur(4px); }
.list-card.dragging { opacity: .85; border-color: #818cf8; }
.card-head { cursor: grab; user-select: none; }
.card-head:active { cursor: grabbing; }
.rail-scroll { flex: 1; overflow-y: auto; padding: 0 10px; }
.pin-list { border: 1px solid var(--border, #1f2937); border-radius: 10px; padding: 8px; margin-bottom: 10px; background: rgba(30, 41, 59, .35); }
.pl-head { display: flex; justify-content: space-between; align-items: center; }
.pl-title { font-weight: 600; font-size: 13px; }
.pl-ops button, .pl-item-ops button { background: none; border: 0; color: #64748b; cursor: pointer; font-size: 11px; padding: 0 2px; }
.pl-item { display: flex; justify-content: space-between; align-items: center; padding: 3px 0; font-size: 12px; }
.pl-item.missing { opacity: .45; }
.pl-ref { cursor: pointer; }
.pl-ref:hover { color: #a5b4fc; }
.pl-put { width: 100%; margin-top: 6px; background: rgba(79, 70, 229, .18); border: 1px dashed #6366f1; color: #a5b4fc; border-radius: 6px; padding: 3px; cursor: pointer; font-size: 11px; }
.rail-new { display: flex; gap: 6px; padding: 10px; }
.rail-new input { flex: 1; background: #0f172a; border: 1px solid var(--border, #1f2937); color: inherit; border-radius: 6px; padding: 5px 8px; font-size: 12px; }
.canvas-wrap { flex: 1; position: relative; min-width: 0; }
.idea-canvas { width: 100%; height: 100%; display: block; touch-action: none; }
.edge-svg { position: absolute; inset: 0; width: 100%; height: 100%; pointer-events: none; }
.sphere-overlay { position: absolute; inset: 0; pointer-events: none; }
.sphere-label { position: absolute; transform: translate(-50%, 50%); pointer-events: auto; cursor: pointer; text-align: center; transition: opacity .2s; user-select: none; }
.sphere-label.selected .sl-title { color: #c7d2fe; }
.sl-title { display: block; font-size: 13px; color: #e2e8f0; text-shadow: 0 1px 4px rgba(0,0,0,.9); }
.sl-meta { display: block; font-size: 11px; color: #94a3b8; }
.canvas-loading, .canvas-empty { position: absolute; inset: 0; display: flex; flex-direction: column; align-items: center; justify-content: center; color: #94a3b8; }
.canvas-empty .hint { font-size: 12px; color: #64748b; }
.detail-drawer { width: 400px; border-left: 1px solid var(--border, #1f2937); overflow-y: auto; padding: 14px; position: relative; background: rgba(15, 23, 42, .6); }
.drawer-close { position: absolute; right: 10px; top: 10px; background: none; border: 0; color: #94a3b8; cursor: pointer; font-size: 15px; }
.d-title { margin: 0 24px 10px 0; font-size: 17px; }
.d-block { border-top: 1px solid var(--border, #1f2937); padding: 10px 0; }
.d-label { font-size: 11px; color: #94a3b8; letter-spacing: 1px; margin-bottom: 6px; }
.d-text { font-size: 13px; white-space: pre-wrap; }
.roi.overdue { border-left: 2px solid #f87171; padding-left: 8px; }
.roi-grid { display: flex; flex-wrap: wrap; gap: 8px; font-size: 13px; }
.roi-pay { color: #fbbf24; }
/* ---- 节点 DAG 画布 (idea-node-dag ① Dify 式) ---- */
.idea-workbench { flex: 1; min-width: 0; display: flex; flex-direction: column; border-right: 1px solid var(--border, #1f2937); }
.wb-bar { display: flex; align-items: center; gap: 10px; padding: 8px 14px; border-bottom: 1px solid var(--border, #1f2937); }
.wb-back { background: none; border: 1px solid var(--border, #1f2937); color: inherit; border-radius: 8px; padding: 3px 10px; cursor: pointer; font-size: 14px; }
.wb-back:hover { border-color: #818cf8; }
.wb-title { margin: 0; font-size: 16px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.wb-bar select { background: #0f172a; color: inherit; border: 1px solid var(--border, #1f2937); border-radius: 6px; padding: 4px 8px; font-size: 12px; }
.wb-roi { font-size: 12px; color: #94a3b8; margin-left: auto; white-space: nowrap; }
.wb-overdue { color: #f87171; margin-left: 6px; }
.wb-export { flex: none; }
.dag-stage { position: relative; flex: 1; min-height: 0; overflow: hidden; cursor: grab;
  background-color: #0a1122;
  background-image: radial-gradient(rgba(148, 163, 184, .16) 1.1px, transparent 1.1px); }
.dag-stage:active { cursor: grabbing; }
.dag-svg { position: absolute; inset: 0; display: block; }
.dag-edge { fill: none; stroke: rgba(148, 163, 184, .42); stroke-width: 1.4; transition: opacity .18s, stroke .18s; }
.dag-edge.run { stroke: #fbbf24; stroke-dasharray: 7 6; animation: dag-flow-line 1.1s linear infinite; }
.dag-edge.dim { opacity: .16; }
.dag-edge.connecting { stroke: #a5b4fc; stroke-dasharray: 6 5; }
@keyframes dag-flow-line { to { stroke-dashoffset: -26; } }
.dag-card { width: 100%; height: 100%; box-sizing: border-box; position: relative; cursor: grab; user-select: none;
  background: #101b31; border: 1px solid var(--st); border-left-width: 3px; border-radius: 10px;
  padding: 8px 10px 7px; display: flex; flex-direction: column; gap: 3px;
  box-shadow: 0 2px 10px rgba(0, 0, 0, .35); transition: opacity .18s, border-color .15s, box-shadow .15s; }
.dag-card:hover { box-shadow: 0 4px 16px rgba(0, 0, 0, .5); }
.dag-card.sel { border-width: 2px; border-left-width: 3px; box-shadow: 0 0 0 2px rgba(129, 140, 248, .35); }
.dag-card.dim { opacity: .22; }
.dag-card.drop { border-style: dashed; box-shadow: 0 0 0 3px rgba(74, 222, 128, .4); }
.dag-cursor { position: absolute; inset: -4.5px; border: 1.6px dashed #fbbf24; border-radius: 13px; pointer-events: none;
  animation: dag-pulse 1.4s ease-in-out infinite; }
@keyframes dag-pulse { 0%, 100% { opacity: .95; box-shadow: 0 0 0 0 rgba(251, 191, 36, .22); } 50% { opacity: .5; box-shadow: 0 0 12px 2px rgba(251, 191, 36, .16); } }
.dag-card-head { display: flex; align-items: center; gap: 6px; }
.dag-card-title { flex: 1; font-size: 13px; font-weight: 600; color: #e2e8f0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.dag-badge { flex: none; font-size: 10px; color: #94a3b8; border: 1px solid #334155; border-radius: 8px; padding: 0 6px; }
.dag-card-detail { font-size: 11px; color: #7c8aa0; line-height: 1.45; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
.dag-card-foot { margin-top: auto; display: flex; align-items: center; gap: 6px; }
.dag-chip { font-size: 10.5px; color: var(--st); border: 1px solid var(--st); border-radius: 8px; padding: 0 7px; opacity: .9; }
.dag-deps { font-size: 10.5px; color: #64748b; }
.dag-handle { position: absolute; top: 50%; width: 11px; height: 11px; border-radius: 50%; transform: translateY(-50%);
  background: #0f172a; border: 1.6px solid var(--st); cursor: crosshair; transition: transform .12s, box-shadow .12s; }
.dag-handle:hover { transform: translateY(-50%) scale(1.45); box-shadow: 0 0 6px var(--st); }
.dag-handle-in { left: -6px; }
.dag-handle-out { right: -6px; }
.dag-handle.hit { background: #4ade80; border-color: #4ade80; box-shadow: 0 0 8px rgba(74, 222, 128, .8); }
.dag-empty { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; color: #64748b; font-size: 13px; pointer-events: none; }
.dag-add { position: absolute; left: 14px; bottom: 14px; display: flex; gap: 6px; }
.dag-add input { width: 170px; background: rgba(15, 23, 42, .92); border: 1px solid var(--border, #1f2937); color: inherit; border-radius: 8px; padding: 5px 9px; font-size: 12px; }
.dag-toolbar { position: absolute; right: 14px; bottom: 14px; display: flex; align-items: center; gap: 4px;
  background: rgba(15, 23, 42, .92); border: 1px solid var(--border, #1f2937); border-radius: 10px; padding: 4px 6px; }
.dag-toolbar button { background: none; border: 0; color: #94a3b8; cursor: pointer; font-size: 13px; padding: 2px 7px; border-radius: 6px; }
.dag-toolbar button:hover { color: #e2e8f0; background: rgba(148, 163, 184, .12); }
.dag-zoom { font-size: 11px; color: #64748b; min-width: 38px; text-align: center; }
.dag-hint { position: absolute; left: 14px; top: 10px; font-size: 11px; color: #475569; pointer-events: none; }
.node-panel { border: 1px solid rgba(129, 140, 248, .35); background: rgba(30, 41, 59, .4); border-radius: 10px; padding: 8px 10px; margin-bottom: 10px; font-size: 12px; }
.np-head { display: flex; justify-content: space-between; align-items: center; gap: 6px; margin-bottom: 5px; }
.np-title { font-weight: 600; font-size: 13px; }
.node-panel select { width: 100%; background: #0f172a; color: inherit; border: 1px solid var(--border, #1f2937); border-radius: 4px; font-size: 11px; }
.np-meta { color: #64748b; margin-top: 5px; font-size: 11px; }
.np-deps { display: flex; flex-wrap: wrap; gap: 4px; margin-top: 4px; }
.np-dep { display: inline-flex; align-items: center; gap: 3px; font-size: 11px; color: #a5b4fc; border: 1px solid rgba(129, 140, 248, .35); border-radius: 8px; padding: 1px 6px; }
.np-dep button { background: none; border: 0; color: #64748b; cursor: pointer; font-size: 12px; padding: 0; }
.np-dep button:hover { color: #f87171; }
.np-detail { color: #94a3b8; margin-top: 5px; font-size: 11.5px; white-space: pre-wrap; }
.np-ops { margin-top: 6px; display: flex; gap: 6px; }
.sig-row { display: flex; gap: 6px; align-items: center; font-size: 12px; padding: 2px 0; }
.sig-kind { color: #a5b4fc; }
.sig-val { color: #fbbf24; }
.sig-add { display: flex; gap: 6px; margin-top: 6px; }
.sig-add input, .sig-add select { background: #0f172a; border: 1px solid var(--border, #1f2937); color: inherit; border-radius: 6px; padding: 4px 6px; font-size: 12px; }
.sig-add input.w60 { width: 60px; }
.task-row { display: flex; gap: 8px; font-size: 12px; padding: 3px 0; cursor: pointer; }
.task-row:hover .t-title { color: #a5b4fc; }
.t-status { color: #64748b; min-width: 70px; }
.t-cost { color: #94a3b8; margin-left: auto; }
.conclude-input { width: 100%; box-sizing: border-box; background: #0f172a; border: 1px solid var(--border, #1f2937); color: inherit; border-radius: 6px; padding: 6px 8px; font-size: 12px; margin-bottom: 6px; }
.pl-rename { width: 110px; background: #0f172a; border: 1px solid #334155; color: inherit; border-radius: 4px; font-size: 12px; padding: 1px 4px; }
.pl-ops button.confirm { color: #f87171; }
.node-dispatch-title { width: 100%; box-sizing: border-box; margin-top: 4px; background: #0f172a; border: 1px solid #334155; color: inherit; border-radius: 6px; padding: 4px 8px; font-size: 12px; }
.conclude-btns { display: flex; gap: 6px; }
.conclude-btns button { background: #0f172a; border: 1px solid var(--border, #1f2937); color: inherit; border-radius: 6px; padding: 4px 10px; cursor: pointer; font-size: 12px; }
.conclude-btns button.danger { border-color: #7f1d1d; color: #fca5a5; }
button.sm { background: rgba(79, 70, 229, .2); border: 0; color: #c7d2fe; border-radius: 6px; padding: 2px 8px; cursor: pointer; font-size: 11px; }
.export-btn { margin-top: 12px; }
.primary { background: #4f46e5; border: 0; color: #fff; border-radius: 8px; padding: 6px 14px; cursor: pointer; }
.modal-mask { position: fixed; inset: 0; background: rgba(0,0,0,.55); display: flex; align-items: center; justify-content: center; z-index: 50; }
.modal-card { width: 460px; background: #0f172a; border: 1px solid #1f2937; border-radius: 14px; padding: 20px; }
.modal-card h3 { margin: 0 0 12px; }
.modal-card label { display: block; font-size: 12px; color: #94a3b8; margin-bottom: 10px; }
.modal-card input, .modal-card textarea { width: 100%; margin-top: 4px; background: #1e293b; border: 1px solid #334155; color: inherit; border-radius: 8px; padding: 7px 10px; font-size: 13px; box-sizing: border-box; }
.modal-ops { display: flex; justify-content: flex-end; gap: 8px; margin-top: 8px; }
.modal-ops button { background: transparent; border: 1px solid var(--border, #1f2937); color: inherit; border-radius: 8px; padding: 6px 14px; cursor: pointer; }
.modal-ops button.primary { background: #4f46e5; border-color: #4f46e5; }
</style>
