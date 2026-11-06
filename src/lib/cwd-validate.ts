// 功能: 项目/版本 cwd 写入前的本机校验 —— 路径必须是本机真实存在的目录;
//       不存在时默认拒绝并返回结构化核查提示(前缀核对/家目录同名/新建指引),
//       仅当显式带 git_remote(clone) 或 create_if_missing(新建) 时才放行.
// 关注点:
//  - 只在写路径调用 (projects/versions 的 POST+PATCH); 读路径不校验 —— 历史
//    脏数据(跨机快照抄来的 /Users|/home 互串)读取不受影响, 但再写入就必须过这道门.
//  - git clone 走 spawnSync 同步阻塞该请求, timeout 120s; 大仓超时会报
//    CWD_PROVISION_FAILED, 调用方改手动 clone 后只传路径重试.
//  - 默认两个放行参数都不传 = 严格拒绝 (damo 2026-10-31 拍板: 脚本默认参数不给加标志位).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

export interface CwdCheckOptions {
  /** 显式新建标志位: 路径不存在时 mkdir -p. 默认 false —— 不传就不建. */
  create_if_missing?: boolean;
  /** git remote 地址: 路径不存在时 git clone 到该路径. 默认不传不拉. */
  git_remote?: string;
  /** 测试注入: 覆盖 home (默认 os.homedir()) */
  _home?: string;
  /** 测试注入: 覆盖 hostname (默认 os.hostname()) */
  _host?: string;
}

export interface CwdCheckHint {
  host: string;
  home: string;
  /** cwd 是否在本机家目录下 */
  under_home: boolean;
  basename: string;
  /** 前缀形态换算到本机家目录后的对应路径 (仅当 cwd 是 /home|/Users|/root/<u>/ 形态) */
  home_prefixed: string | null;
  home_prefixed_exists: boolean;
  /** 本机真实存在、可直接改用的路径 (前缀映射 + 家目录常见根下同名目录) */
  candidates: string[];
  actions: string[];
}

export interface CwdCheckFailure {
  code: "CWD_INVALID" | "CWD_NOT_FOUND" | "CWD_PROVISION_FAILED";
  error: string;
  hint: CwdCheckHint;
}

export type CwdCheckResult = { ok: true } | { ok: false; failure: CwdCheckFailure };

// 他机家目录前缀形态: /Users/<u>/... (Mac) / /home/<u>/... (WSL/Linux) / /root/...
const MACHINE_HOME_PREFIX = /^\/(?:home|Users|root)\/[^/]+(\/.*)$/;

// 家目录下常见项目根 —— 候选同名目录扫描范围 (与三台机器实际布局一致, 够用即可)
function candidateRoots(home: string): string[] {
  return [home, path.join(home, "workspace"), path.join(home, "workspaces"), path.join(home, "github")];
}

function buildHint(cwd: string, home: string, host: string): CwdCheckHint {
  const basename = path.basename(cwd);
  const underHome = cwd === home || cwd.startsWith(home + path.sep);
  const candidates: string[] = [];
  let homePrefixed: string | null = null;
  let homePrefixedExists = false;

  // ① 前缀形态核对: /Users/user/workspace/X 在 WSL 上 → /home/user/workspace/X
  const m = cwd.match(MACHINE_HOME_PREFIX);
  if (m && m[1]) {
    const mapped = path.join(home, m[1]);
    if (mapped !== cwd) {
      homePrefixed = mapped;
      homePrefixedExists = fs.existsSync(mapped);
      if (homePrefixedExists) candidates.push(mapped);
    }
  }
  // ② 家目录常见根下同名目录 (项目已 clone 但换了位置)
  for (const root of candidateRoots(home)) {
    const cand = path.join(root, basename);
    if (cand !== cwd && !candidates.includes(cand) && fs.existsSync(cand)) {
      candidates.push(cand);
    }
  }

  const actions = [
    `先核对路径前缀: 本机 ${host} 的家目录是 ${home} (/Users/... 是 Mac 形态, /home/... 是 WSL/Linux 形态)`,
    candidates.length
      ? `家目录下已有对应目录, 优先改用: ${candidates.join(" , ")}`
      : "家目录下没扫到同名目录, 确认项目是不是还没 clone 到本机",
    "确属新建项目 → 重试时带 create_if_missing: true (平台 mkdir -p)",
    "项目在远端 git 仓库 → 重试时带 git_remote: <url> (平台 clone 后放行)",
  ];
  return { host, home, under_home: underHome, basename, home_prefixed: homePrefixed, home_prefixed_exists: homePrefixedExists, candidates, actions };
}

function notFound(cwd: string, home: string, host: string): CwdCheckResult {
  const hint = buildHint(cwd, home, host);
  const main = hint.home_prefixed_exists
    ? `本机对应路径 ${hint.home_prefixed} 已存在, 请改用它`
    : "请核对家目录前缀/家目录下同名项目, 或显式带 create_if_missing=true / git_remote";
  return {
    ok: false,
    failure: {
      code: "CWD_NOT_FOUND",
      error: `本地路径不存在: ${cwd}（本机 ${host}，home=${home}）。${main}`,
      hint,
    },
  };
}

// 功能: 校验 cwd 并按需 provision (clone/mkdir). 返回 ok 或结构化失败 (路由直接 400 透传).
export function checkCwdPath(rawCwd: string, opts: CwdCheckOptions = {}): CwdCheckResult {
  const cwd = String(rawCwd ?? "").trim();
  const home = opts._home ?? os.homedir();
  const host = opts._host ?? os.hostname();

  if (!cwd) {
    return {
      ok: false,
      failure: { code: "CWD_INVALID", error: "cwd 不能为空字符串（要清空请传 null）", hint: buildHint("/", home, host) },
    };
  }
  if (!path.isAbsolute(cwd)) {
    return {
      ok: false,
      failure: { code: "CWD_INVALID", error: `cwd 必须是绝对路径: ${cwd}（本机 home=${home}）`, hint: buildHint(cwd, home, host) },
    };
  }

  let st: fs.Stats | null = null;
  try {
    st = fs.statSync(cwd);
  } catch {
    st = null;
  }
  if (st) {
    if (!st.isDirectory()) {
      return {
        ok: false,
        failure: { code: "CWD_INVALID", error: `cwd 已存在但是文件不是目录: ${cwd}`, hint: buildHint(cwd, home, host) },
      };
    }
    return { ok: true };
  }

  // ---- 路径不存在 → 两条显式放行通道 ----
  const remote = typeof opts.git_remote === "string" ? opts.git_remote.trim() : "";
  if (remote) {
    const r = spawnSync("git", ["clone", remote, cwd], { timeout: 120_000, encoding: "utf8" });
    if (r.error || r.status !== 0) {
      const tail = String(r.stderr || r.error || "unknown").split("\n").slice(-5).join("\n").trim();
      return {
        ok: false,
        failure: {
          code: "CWD_PROVISION_FAILED",
          error: `git clone 失败: ${remote} → ${cwd}\n${tail}`,
          hint: buildHint(cwd, home, host),
        },
      };
    }
    return { ok: true };
  }
  if (opts.create_if_missing === true) {
    try {
      fs.mkdirSync(cwd, { recursive: true });
      return { ok: true };
    } catch (err) {
      return {
        ok: false,
        failure: {
          code: "CWD_PROVISION_FAILED",
          error: `mkdir -p 失败: ${cwd}: ${(err as Error).message}`,
          hint: buildHint(cwd, home, host),
        },
      };
    }
  }

  return notFound(cwd, home, host);
}

// 功能: 路由用 —— 从请求体取出 cwd + 两个放行参数做校验; cwd 未传/null/空串直接放行.
// 返回 null = 通过 (body 里两个放行参数会被剥掉, 避免透传进 DB 层); 否则返回 400 的 JSON body.
export function validateCwdFromBody(body: Record<string, unknown>): CwdCheckFailure | null {
  const cwd = body.cwd;
  if (cwd === undefined || cwd === null || cwd === "") return null;
  if (typeof cwd !== "string") {
    return { code: "CWD_INVALID", error: `cwd 必须是字符串或 null, got ${typeof cwd}`, hint: buildHint("/", os.homedir(), os.hostname()) };
  }
  const check = checkCwdPath(cwd, {
    create_if_missing: body.create_if_missing === true,
    git_remote: typeof body.git_remote === "string" ? body.git_remote : undefined,
  });
  if (check.ok) {
    delete body.create_if_missing;
    delete body.git_remote;
    return null;
  }
  return check.failure;
}
