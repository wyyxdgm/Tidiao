// Wiki 跨项目链接解析 —— 纯函数, 浏览器与 node 都能 import.
//
// 语法: project:{projectId}?path={relpath}[&version={version}]
// 其中:
//   - projectId 必须是 UUID(8-4-4-4-12, 大小写不敏感), 与 projects 表 id 形状对齐.
//   - relpath 是目标项目 cwd 内的相对路径(不含前导 /, 不含 .. 段).
//   - version 可选, 不传则由目标 wiki 默认(current version).
//
// 为什么独立成模块(同 wiki-files.ts 的理由): 这函数同时被 WikiClient 的链接拦截
// 器和测试 import. 任何对语法的改动都必须同时更新两侧, 否则会出现「编辑器能识别但
// 服务端解析失败」或反向的不一致.

/** 跨项目链接前缀. 写在 markdown 里形如: `[其他项目](project:UUID?path=INDEX.md)`. */
export const CROSS_PROJECT_PREFIX = "project:";

/** 解析后的跨项目链接. */
export interface CrossProjectLink {
  projectId: string;
  /** 目标项目 cwd 内的相对路径. 已是 URL 解码后的形态, 不含前导 / 或 .. 段. */
  path: string;
  /** 可选 version 标识(UUID 或名称); null = 用目标项目默认版本. */
  version: string | null;
}

/** projectId 的形状校验: 标准 UUID (8-4-4-4-12 hex). 大小写不敏感. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * 功能: 把 href 解析成跨项目链接, 失败返 null.
 * 关注点:
 *  - 解析失败 = 静默返回 null, 不抛 —— 让调用方继续走原来的外链判定(新窗口打开),
 *    markdown 作者看到链接不工作自然会发现语法错.
 *  - path 校验比 UUID 校验更严: 路径里出现 `..` 或前导 `/` 一律拒. 这是为了把
 *    「目标项目里读不到」的失败尽早暴露在解析阶段, 不让它穿过到后端再 404.
 *    前端无法限制别人写什么(curl 仍能直接打 /api/.../wiki), 后端 safeResolve 那道
 *    防线是兜底, 这里只是减少无用请求.
 *  - 锚点(#fragment)被静默丢弃: 跨项目的锚点语义不明确, 静默处理避免误以为是 bug.
 *  - query 只取 path 与 version 两个已知 key, 其他(如 &foo=)被忽略 —— markdown 链接
 *    里塞别的 query 没意义, 也避免依赖具体 wiki 实现暴露的其他参数.
 */
export function parseCrossProjectHref(href: string): CrossProjectLink | null {
  if (!href || !href.startsWith(CROSS_PROJECT_PREFIX)) return null;
  const rest = href.slice(CROSS_PROJECT_PREFIX.length);
  // 剥 fragment; 不剥 query 因为 query 里要拿 path/version.
  const noFrag = rest.split("#")[0];
  const qIdx = noFrag.indexOf("?");
  const projectId = qIdx >= 0 ? noFrag.slice(0, qIdx) : noFrag;
  // projectId 必须是非空 UUID. 留空(写 `project:?path=...`) 也算非法.
  if (!projectId || !UUID_RE.test(projectId)) return null;

  const query = qIdx >= 0 ? noFrag.slice(qIdx + 1) : "";
  let path: string | null = null;
  let version: string | null = null;
  if (query) {
    const params = new URLSearchParams(query);
    const rawPath = params.get("path");
    if (rawPath) path = rawPath;
    const rawVer = params.get("version");
    if (rawVer) version = rawVer;
  }
  if (!path) return null;
  // 路径里出现 .. 段 或 前导 / —— 一律拒. URL 解码后的形态再做判断, 因为
  // %2F 之类解码后才看得见真实结构.
  if (path.startsWith("/")) return null;
  // 段级 .. 检查: ".." 或 ".\\" 都算. 但允许 ".md" / "..hidden" 这类名字.
  const segments = path.split("/");
  if (segments.some((s) => s === "..")) return null;
  return { projectId, path, version };
}

/**
 * 功能: 构造跨项目 wiki 链接 href. 供代码内生成链接时使用(如「相关项目」section).
 * 关注点: 与 parseCrossProjectHref 必须**对称** —— 改了一边另一边也要改. 测试里
 *         有 round-trip 断言守这条.
 */
export function buildCrossProjectHref(
  projectId: string,
  path: string,
  version?: string | null
): string {
  const params = new URLSearchParams();
  params.set("path", path);
  if (version) params.set("version", version);
  return `${CROSS_PROJECT_PREFIX}${projectId}?${params.toString()}`;
}

/** 绝对路径项目前缀解析所需的最小项目信息. */
export interface ProjectCwdRef {
  id: string;
  cwd: string | null;
}

/** 绝对路径命中解析: 与 parseCrossProjectHref 互斥但形态相似的返回. */
export interface ResolvedAbsolutePath {
  projectId: string;
  /** cwd 内的相对路径(不含前导 /). */
  path: string;
}

/**
 * 功能: 把 href 规范化成与服务端 cwd 同前缀的绝对路径, 便于 cwd 前缀匹配命中.
 * 输入形态 → 输出形态 (homeDir 是必传参数, 来自调用方所在环境的 $HOME):
 *   - /home/user/ws/x/foo.md          → 原样 (已是 WSL 形态)
 *   - /Users/user/ws/x/foo.md         → /home/user/ws/x/foo.md (仅当 homeDir=/home/user)
 *   - ~/ws/x/foo.md                   → ${homeDir}/ws/x/foo.md
 *   - /ws/x/foo.md (shorthand)        → ${homeDir}/ws/x/foo.md
 * 不支持 (原样透传, 由调用方决定后续行为):
 *   - 非 / 开头 (相对路径 / URL)
 *   - // 开头 (UNC)
 *   - Windows 风格 (/C:/... 或含驱动器号)
 *   - 已等于 homeDir 的 (避免双重前缀)
 *
 * 关注点:
 *   - 与本仓 scripts/normalize-path.sh 客户端脚本语义对齐, 但**只看绝对路径前缀**;
 *     <项目别名> 解析是客户端 12-alias 范畴, 服务端不掺和 (后端只看 cwd).
 *   - homeDir 必传, 不读 process.env: 让函数纯, 测试可控. 调用方在 server component 入口
 *     用 process.env.HOME || "/home/user" 兜底传入.
 *   - 仅字符串替换, 不开 fs; 已存在的边界检查 (cwd + "/" 必须跟分隔符) 由调用方保留.
 */
export function normalizeHrefForCwdMatch(
  href: string,
  homeDir: string
): string {
  if (!href || typeof href !== "string") return href;
  // ~/X 是「相对 home」形态, 单独走分支 —— 不要被下面的 startsWith("/") 早退挡掉.
  if (href.startsWith("~/")) {
    if (!homeDir) return href;
    return homeDir + "/" + href.slice(2);
  }
  if (!href.startsWith("/")) return href;
  if (href.startsWith("//")) return href;
  if (/^\/[A-Za-z]:\//.test(href)) return href;
  if (!homeDir) return href;

  // 1) mac 形态: /Users/user/X → /home/user/X (仅当 homeDir 是 WSL /home/user)
  if (
    homeDir === "/home/user" &&
    href.startsWith("/Users/user/")
  ) {
    return "/home/user/" + href.slice("/Users/user/".length);
  }

  // 2) shorthand /workspace/X → homeDir + href (href 已有 /, 直接拼)
  //    兜底: 复制粘贴时漏 /home/user 前缀, 常见于 chat 输出 / wiki 链接.
  //    双重前缀保护: href 已以 homeDir 开头就不动.
  if (
    homeDir === "/home/user" &&
    href.startsWith("/workspace/") &&
    !href.startsWith(homeDir + "/workspace/")
  ) {
    return homeDir + href;
  }

  return href;
}

/**
 * 功能: 若 href 是某个项目 cwd 子树内的绝对文件系统路径, 返回对应 (projectId, 相对路径);
 *       否则返 null. 仅做字符串前缀匹配 —— 不开 fs(realpath/case-fold 留给系统层兜底).
 * 关注点:
 *  - **不进 fs**: 每个 markdown 链接都调, 打一次 fs.realpath 不可接受; 字符串比对对含 symlink
 *    的 cwd 会识别不到, 但失败是 graceful 的(走原外链判定, 与改造前行为一致).
 *  - **最长前缀匹配**: 项目 cwd 可能互相嵌套(如 `/ws/a` 和 `/ws/aa`), 选最长 cwd 命中的
 *    项目, 避免被祖辈截胡. 实现: 按 cwd 长度降序, 找到第一个命中就返回.
 *  - **不在 cwd 下的路径**: 直接 null, 不要静默重写到错误项目.
 *  - **空 cwd / cwd 后没斜杠边界**: 都视为不命中. `/ws/a` 命中 `/ws/a/foo`, 但**不**命中
 *    `/ws/abc`, 防止 `/ws/a` 截胡 `/ws/abc/foo` 这类共用前缀的兄弟项目.
 *  - **当前未读懂 Windows 路径**: `C:\...` 或 `\\server\share\...` 不当绝对路径处理,
 *    统一返 null 走原外链判定. 部署面全是 POSIX, 不为假想场景加复杂度.
 *  - **入口先 normalize** (mac/~ / shorthand → 与 cwd 同前缀), 跨用户设备写入路径时
 *    漏 /home/user 前缀这类常见错误不再让跳转静默挂掉. 详见 normalizeHrefForCwdMatch.
 */
export function resolveAbsoluteProjectPath(
  href: string,
  projects: ProjectCwdRef[],
  homeDir: string = process.env.HOME || "/home/user"
): ResolvedAbsolutePath | null {
  if (!href || !href.startsWith("/")) return null;
  if (!Array.isArray(projects)) return null;
  // 拒绝 Windows 风格 —— href 含 ":" 段(驱动器) 或 以 "//" 开头(UNC) 一律当外链.
  if (href.startsWith("//") || /^\/[A-Za-z]:\//.test(href)) return null;
  // 把 href 规范化成「与服务端 cwd 同前缀」的形态 (mac/~ / shorthand → homeDir 前缀),
  // 这样 cwd 前缀匹配能命中. 不修改 / 透传所有不支持的形态.
  const normalized = normalizeHrefForCwdMatch(href, homeDir);
  // 按 cwd 长度降序, 最具体的项目赢.
  const sorted = projects
    .filter((p): p is { id: string; cwd: string } => !!p.cwd)
    .slice()
    .sort((a, b) => b.cwd.length - a.cwd.length);
  for (const p of sorted) {
    const cwd = p.cwd;
    // 边界检查: 必须 cwd 后面正好跟 '/' 才算子树, 防止 /ws/a 截胡 /ws/abc.
    if (normalized === cwd) return null; // 命中 cwd 本身不算, 没东西可看.
    if (normalized.startsWith(cwd + "/")) {
        return { projectId: p.id, path: normalized.slice(cwd.length + 1) };
    }
  }
  return null;
}

/**
 * 服务端 wiki URL 规范化决策 —— 在 server component 入口处调用, 把绝对路径
 * (?path=/ws/a/foo.md) 解析成"跳到哪个项目的相对路径".
 *
 * 返回两种决策:
 *   - { kind: 'redirect', targetUrl } —— 命中某项目 cwd, 跳转到它的相对路径版 wiki URL
 *     (同项目 / 跨项目都走 redirect, 同项目情况也借这一跳把 URL 规范化成相对路径形态).
 *   - { kind: 'pass' } —— 非绝对路径 / 没匹配任何 cwd, 维持原行为(交给 API 处理, 后端 404).
 *
 * 关注点:
 *  - 决策与 resolveAbsoluteProjectPath 完全一致(最长前缀 cwd 匹配), 仅多一步
 *    「精确命中 cwd 本身 → INDEX.md」边界 + URL 拼接.
 *  - 同项目也走 redirect 而不是直接渲染: Next.js server component 没法中途改
 *    searchParams, 不重定向的话 URL 仍带着 /ws/a/foo.md, 下次刷新 / 分享链接
 *    又会触发同一条规范化路径(虽然结果幂等不会死循环, 但 URL 永远不会规范化).
 *  - 跨用户隔离由 projects 参数的 owner 过滤保证(调用方传 listProjects(userId)
 *    的结果). 函数本身只看 projects 数组, 不碰 DB.
 */
export type AbsolutePathDecision =
  | { kind: "redirect"; targetUrl: string }
  | { kind: "pass" };

export function decideAbsolutePathRedirect(
  rawPath: string | undefined,
  currentProjectId: string,
  projects: ProjectCwdRef[],
  version: string | undefined,
  homeDir: string = process.env.HOME || "/home/user"
): AbsolutePathDecision {
  if (!rawPath || !rawPath.startsWith("/")) return { kind: "pass" };

  // 把 rawPath 规范化成与服务端 cwd 同前缀的形态 (mac/~ / shorthand → homeDir 前缀),
  // 这样 exactHit 和子串匹配都能命中. normalizeHrefForCwdMatch 是纯函数, 不支持的
  // 形态 (Windows/UNC/非绝对) 会原样透传 —— 不破坏现有 pass 边界.
  const normalized = normalizeHrefForCwdMatch(rawPath, homeDir);

  // 精确命中 cwd 本身(例如 /ws/a == project.cwd, 不带文件名)→ 看项目首页 INDEX.md.
  // 这一步必须先做, 因为 resolveAbsoluteProjectPath 对「href === cwd」故意返 null
  // (设计意图: 没有路径可读).
  const exactHit = projects.find(
    (p): p is { id: string; cwd: string } => !!p.cwd && p.cwd === normalized
  );
  if (exactHit) {
    const versionQs = version ? `&version=${encodeURIComponent(version)}` : "";
    return {
      kind: "redirect",
      // 🔴 hash 路由: 跳 SPA (targetUrl 供旧壳 server redirect 用, 落 /#/ 载入 SPA)
      targetUrl: `/#/${exactHit.id}/wiki?path=INDEX.md${versionQs}`,
    };
  }

  const resolved = resolveAbsoluteProjectPath(normalized, projects, homeDir);
  if (!resolved) return { kind: "pass" };

  const versionQs = version ? `&version=${encodeURIComponent(version)}` : "";
  const targetUrl =
    `/#/${resolved.projectId}/wiki?path=${encodeURIComponent(resolved.path)}${versionQs}`;
  return { kind: "redirect", targetUrl };
}