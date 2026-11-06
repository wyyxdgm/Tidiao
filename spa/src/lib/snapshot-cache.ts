// 功能: 会话级快照缓存 (R165) —— 把"最近一次拉到的列表数据"存 sessionStorage,
//   刷新页面 / 重新打开 tab 时先拿快照直接渲染 (没有骨架屏闪烁), 再由后台同步器
//   条件 GET 校准. 落点是"点开就能直接看", 不是"打开就能看到旧的"—— 快照永远
//   只是首屏的临时代, 校准请求在它之后跑, 变了就替换.
//
// 关注点:
//   - sessionStorage 不是 localStorage: 关掉标签页自动清空, 不会留下一堆
//     "昨天的看板数据"在磁盘上. 同标签页内的刷新/路由切换都能命中.
//   - 容量: sessionStorage 一般 5MB, 塞爆会写失败且**不抛**, 所以显式 cap
//     (单条 MAX_ENTRY_BYTES) + 条数上限 (MAX_ENTRIES) + 按最后访问时间淘汰.
//     写入前先算 UTF-8 字节数, 超限直接不存 (宁可这一条没快照, 也别写坏别的条目).
//   - 读侧对脏数据一律降级成 miss: storage 里的东西是上一版本的代码写的, 解析
//     失败 / 结构不对就当没有, 绝不让一个坏快照白屏.
//   - 访问即续命: readSnapshot 顺手刷新 lastUsed, 让常用的看板不被 LRU 淘汰.

const PREFIX = 'snapshot-v1:';
/** 单条上限 512KB UTF-8. 50 行 TaskTrimmed 实测 ~40-80KB, 留足余量. */
const MAX_ENTRY_BYTES = 512 * 1024;
/** 最多留 12 条. 超了按 lastUsed 从小到大淘汰, 直到塞得下. */
const MAX_ENTRIES = 12;

interface Envelope<T> {
  /** 快照内容. */
  data: T;
  /** 与之配套的 ETag — 校准时直接当 If-None-Match 发出去, 省一次全量. */
  etag: string | null;
  /** 写入时刻 (ms). */
  savedAt: number;
  /** 最后一次命中 (ms), LRU 用. */
  lastUsed: number;
}

function storage(): Storage | null {
  try {
    return typeof sessionStorage === 'undefined' ? null : sessionStorage;
  } catch {
    return null; // 隐私模式 / 禁用了 storage
  }
}

function byteLen(s: string): number {
  return new TextEncoder().encode(s).length;
}

/** 安全 getItem: storage 被禁 (Safari 私密模式 / 第三方 iframe 抛 SecurityError)
 *  时返回 null 而不是把异常抛进调用方 —— 快照是优化, 读不到必须退化成"没有快照". */
function safeGet(store: Storage, key: string): string | null {
  try {
    return store.getItem(key);
  } catch {
    return null;
  }
}

/** 安全 removeItem. 同上, 清理失败不值得让业务流程挂掉. */
function safeRemove(store: Storage, key: string): void {
  try {
    store.removeItem(key);
  } catch {
    /* ignore */
  }
}

function fullKey(key: string): string {
  return PREFIX + key;
}

function parse<T>(raw: string): Envelope<T> | null {
  try {
    const env = JSON.parse(raw) as Partial<Envelope<T>>;
    if (!env || typeof env !== 'object' || !('data' in env)) return null;
    return {
      data: env.data as T,
      etag: typeof env.etag === 'string' ? env.etag : null,
      savedAt: typeof env.savedAt === 'number' ? env.savedAt : 0,
      lastUsed: typeof env.lastUsed === 'number' ? env.lastUsed : 0,
    };
  } catch {
    return null; // 脏数据当 miss
  }
}

/** 列出生效中的快照 key (含 lastUsed), 供淘汰用. */
function listEntries(): { key: string; lastUsed: number }[] {
  const store = storage();
  if (!store) return [];
  const out: { key: string; lastUsed: number }[] = [];
  for (let i = 0; i < store.length; i++) {
    let k: string | null;
    try {
      k = store.key(i);
    } catch {
      return out; // storage 中途被禁 — 已枚举到的部分够用了
    }
    if (!k || !k.startsWith(PREFIX)) continue;
    const env = parse<unknown>(safeGet(store, k) ?? '');
    if (!env) {
      out.push({ key: k, lastUsed: 0 }); // 脏条目 lastUsed=0, 优先淘汰
      continue;
    }
    out.push({ key: k, lastUsed: env.lastUsed });
  }
  return out;
}

function evictFor(incomingBytes: number): void {
  const store = storage();
  if (!store) return;
  const entries = listEntries().sort((a, b) => a.lastUsed - b.lastUsed);
  // 先按条数淘汰到 MAX_ENTRIES - 1 (给新条目留位), 再按字节淘汰.
  let i = 0;
  while (entries.length - i > MAX_ENTRIES - 1 && i < entries.length) {
    safeRemove(store, entries[i].key);
    i++;
  }
  let used = 0;
  for (const e of entries.slice(i)) {
    used += byteLen(safeGet(store, e.key) ?? '');
  }
  while (used + incomingBytes > MAX_ENTRIES * MAX_ENTRY_BYTES && i < entries.length) {
    const victim = entries[i];
    used -= byteLen(safeGet(store, victim.key) ?? '');
    safeRemove(store, victim.key);
    i++;
  }
}

/** 存一条快照. 超限 / storage 不可用 / 序列化失败都静默跳过 —— 快照是优化,
 *  失败必须退化成"没有快照", 不能影响正常加载. */
export function saveSnapshot<T>(key: string, data: T, etag: string | null): void {
  const store = storage();
  if (!store) return;
  let raw: string;
  try {
    const now = Date.now();
    raw = JSON.stringify({ data, etag, savedAt: now, lastUsed: now } satisfies Envelope<T>);
  } catch {
    return; // 循环引用等
  }
  if (byteLen(raw) > MAX_ENTRY_BYTES) return;
  try {
    evictFor(byteLen(raw));
    store.setItem(fullKey(key), raw);
  } catch {
    /* quota 超了 — 放弃这一条 */
  }
}

/** 读一条快照. 命中即续命 (刷新 lastUsed). 脏数据 / 读失败 = miss. */
export function readSnapshot<T>(key: string): { data: T; etag: string | null } | null {
  const store = storage();
  if (!store) return null;
  const raw = safeGet(store, fullKey(key));
  if (!raw) return null;
  const env = parse<T>(raw);
  if (!env) {
    safeRemove(store, fullKey(key));
    return null;
  }
  env.lastUsed = Date.now();
  try {
    store.setItem(fullKey(key), JSON.stringify(env));
  } catch {
    /* 续命失败不影响本次读取 */
  }
  return { data: env.data, etag: env.etag };
}

/** 丢一条快照 (筛选条件变了 / 数据结构升级时主动清). */
export function dropSnapshot(key: string): void {
  const store = storage();
  if (!store) return;
  safeRemove(store, fullKey(key));
}

/** 清掉全部快照 (设置项里的"清缓存"用). */
export function clearSnapshots(): void {
  const store = storage();
  if (!store) return;
  for (const e of listEntries()) {
    safeRemove(store, e.key);
  }
}
