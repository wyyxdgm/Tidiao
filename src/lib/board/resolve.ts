// Board 文件解析 (R91): 项目 cwd 优先, 找不到回落平台内置 boards/.
//
// 功能: 给定项目 cwd + 相对路径, 解析出实际要渲染的 board 文件. 项目 cwd 里有同名文件
//       就用项目自己的; 没有则回落到平台安装目录的 boards/ 下的内置看板.
// 关注点:
//  - 🔴 回落**只开放 `boards/` 一层**. 平台安装目录里有 docs/deploy-secrets.md 这类明文
//    凭据文件, 如果整个平台仓根目录都能被回落读到, 任何登录用户都能通过自己项目的
//    board 页把它读出来 = 越权. 所以回落把根锁死在 <platformRoot>/boards.
//  - 项目 cwd 里的同名文件永远优先 —— 项目可以覆盖平台默认看板, 不会被回落抢走.
//  - 两条路径都做: 拒绝隐藏段 / 空段 + realpath + 锁根目录 (防 symlink 穿越), 与 wiki 一致.
//  - 返回的 `root` 是**仓库根**(项目 cwd 或平台根), 给 git log 当 cwd 用; 而查找时
//    平台侧锁的是 root/boards, 两者不同, 别混.

import fs from "node:fs";
import path from "node:path";

export interface ResolvedBoard {
  /** 仓库根: 项目 cwd 或平台安装目录. git history 用它当 cwd. */
  root: string;
  /** 实际文件的 realpath. */
  fullReal: string;
  content: string;
  /** project = 项目自己的文件; platform = 平台内置回落. */
  origin: "project" | "platform";
}

const BOARDS_DIR = "boards";

// 功能: 平台安装目录 (= Next 应用根). pm2 配置 `cwd: __dirname`, 所以 process.cwd() 就是仓库根.
// 关注点: 允许 env 覆盖, 方便测试与非常规部署; 不做存在性校验 (调用方 try/catch).
export function platformBoardRoot(): string {
  return process.env.ORCHESTRATOR_APP_ROOT || process.cwd();
}

// 功能: 在指定根目录下安全读一个相对路径的文件, 越界/不存在返回 null.
// 关注点: 段级拒绝 `.` 开头 (挡 ../ 与 .env 类) + realpath 后必须仍在 root 内 (挡 symlink).
function readUnder(rootReal: string, relPath: string): { fullReal: string; content: string } | null {
  try {
    if (!relPath) return null;
    if (relPath.split(/[/\\]/).some((seg) => seg.startsWith(".") || seg === "")) return null;
    const fullReal = fs.realpathSync(path.join(rootReal, relPath));
    const rel = path.relative(rootReal, fullReal);
    if (rel.startsWith("..") || path.isAbsolute(rel)) return null;
    if (!fs.statSync(fullReal).isFile()) return null;
    return { fullReal, content: fs.readFileSync(fullReal, "utf8") };
  } catch {
    return null;
  }
}

// 功能: 只在平台内置 boards/ 下找 board 文件 (回落通道).
// 关注点: relPath 必须以 `boards/` 开头, 否则直接拒 —— 回落面仅此一层, 见文件头红线.
export function resolvePlatformBoard(relPath: string, platformRoot?: string): ResolvedBoard | null {
  const segs = relPath.split(/[/\\]/);
  if (segs[0] !== BOARDS_DIR || segs.length < 2) return null;
  const rootRaw = platformRoot || platformBoardRoot();
  let rootReal: string;
  let boardsRoot: string;
  try {
    rootReal = fs.realpathSync(rootRaw);
    boardsRoot = fs.realpathSync(path.join(rootReal, BOARDS_DIR));
  } catch {
    return null;
  }
  const hit = readUnder(boardsRoot, segs.slice(1).join("/"));
  if (!hit) return null;
  return { root: rootReal, fullReal: hit.fullReal, content: hit.content, origin: "platform" };
}

// 功能: 解析 board 文件 —— 项目 cwd 优先, 未命中回落平台内置 boards/.
// 关注点: cwdReal 必须已 realpath (调用方在鉴权时已做); 回落失败返回 null, 由调用方渲染引导页.
export function resolveBoardFile(
  cwdReal: string,
  relPath: string,
  platformRoot?: string
): ResolvedBoard | null {
  const own = readUnder(cwdReal, relPath);
  if (own) return { root: cwdReal, fullReal: own.fullReal, content: own.content, origin: "project" };
  return resolvePlatformBoard(relPath, platformRoot);
}
