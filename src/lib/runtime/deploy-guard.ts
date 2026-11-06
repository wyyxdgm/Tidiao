// 功能: 在 canUseTool 入口拦截出向部署, 防止 agent 在某实例上 deploy 到自己
//   (13000 部署 13000 = 自杀, 部署脚本会关停当前实例 → agent SDK 子进程跟着死).
//   同时拦截 pulu 上任何部署: pulu 3.6G 内存, 在它身上跑 next build 会把
//   整机抖死(详见 scripts/deploy.sh:70-76 的实测教训).
//
//   第二道防线 (checkProcessKill, 2026-08-21 weishu 后端排障事故): 现有自部署
//   拦截只认 deploy.sh 路径, 裸 `pm2 delete all` / `pkill -9 node` 这类进程级
//   操作完全不过决策矩阵. 加上对「会杀掉/重启平台自身进程」的裸命令拦截.
//
// 关注点:
//   - 这是纯函数模块, 决策矩阵和命令解析都在这里. canUseTool 只负责调它.
//   - "当前环境"识别: whoami=orchestrator → pulu(端口也是 13000, 必须先判);
//     否则看 process.env.PORT (pm2 启动时设的, 13000=ao-prod, 13001=ao-dev).
//     canUseTool 跑在平台进程里, PORT 还在; 平台发给 agent 子进程的 env
//     会被 buildEnv() 删 PORT (见 active-session.ts:794) —— 我们在父进程判就
//     不需要把 ORCHESTRATOR_ENV 透传给子进程.
//   - 旁路: DEPLOY_GUARD_BYPASS=1 强制放行 (pulu 紧急就地 build / 进程清理的逃生口).
//   - 命令识别:
//       checkBashDeploy 仅匹配 `npm run deploy` 和 `scripts/deploy.sh` 的直接调用,
//         不拦 `pm2 restart ao-prod` 这种裸命令 (那算人工运维, 不算 deploy 流水线).
//       checkProcessKill 匹配会「杀掉/重启平台自身进程」的裸 pm2 / pkill 命令,
//         但只对 detectCurrentEnv() 识别出的环境生效 (本地/CI 不挡).

export type DeployEnv = "ao-prod" | "ao-dev" | "ao-pulu";

export type DeployDecision =
  | { allowed: true }
  | { allowed: false; reason: string };

// 匹配 deploy.sh 的目标标志. 与 scripts/deploy.sh:101-113 的 case 块一一对应.
//   --wsl/--wsl-dev/-p/--pulu 是单目标; -a/--all 展开为下面 ALL_TARGETS 三项.
const ALL_TARGETS: DeployEnv[] = ["ao-prod", "ao-dev", "ao-pulu"];

// 功能: 识别当前进程跑在哪个 agent-orchestrator 实例. 认不出返回 null (调用方不拦截).
// 关注点: whoami 必须先判, 因为 pulu 和 13000 都是端口 13000.
//   - pulu 上 USER=orchestrator (有时 HOME 不同, 但 USER 永远是 orchestrator)
//   - 13000/13001 上 USER=damo, 用 PORT 区分
//   - 任何一种认不出 (本地开发/CI/测试) → null, 跳过 guard
export function detectCurrentEnv(): DeployEnv | null {
  const user = process.env.USER || process.env.ORCHESTRATOR_USER;
  if (user === "orchestrator") return "ao-pulu";
  const port = process.env.PORT;
  if (port === "13000") return "ao-prod";
  if (port === "13001") return "ao-dev";
  return null;
}

// 功能: 从 deploy 命令里抽出目标环境列表. 不是 deploy 命令返回空数组.
// 关注点:
//   - `npm run deploy -- <flags>` 的 `--` 是 npm 的 flag 分隔符, 必须吃掉
//   - 默认 (无 flag) = --wsl = ao-prod (向后兼容, 见 deploy.sh:120)
//   - `-a/--all` 展开为三个目标
//   - 未识别的 flag (--drain/--install/--no-drain 等) 静默跳过, 不报错
//   - 边界用 (?![\w-]) 而不是 \b: \b 在 'deploy-anything' 的 'y|-' 边界会匹配,
//     误把 npm run deploy-other 认成 deploy. 改成「不能跟字母数字或连字符」
export function parseDeployTargets(command: string): DeployEnv[] {
  const trimmed = command.trim();
  const isDeploy =
    /^npm\s+run\s+deploy(?![\w-])/.test(trimmed) ||
    /^(?:bash\s+)?(?:\.\/)?scripts\/deploy\.sh(?![-\w])/.test(trimmed);
  if (!isDeploy) return [];

  // 去掉 "npm run deploy -- " 或 "bash scripts/deploy.sh " 前缀, 留 flag 段
  const flagsPart = trimmed
    .replace(/^npm\s+run\s+deploy\b\s*--?\s*/, "")
    .replace(/^(?:bash\s+)?(?:\.\/)?scripts\/deploy\.sh\b\s*/, "");

  const tokens = flagsPart.split(/\s+/).filter(Boolean);
  const targets: DeployEnv[] = [];
  const seen = new Set<DeployEnv>();

  const add = (t: DeployEnv) => {
    if (!seen.has(t)) {
      seen.add(t);
      targets.push(t);
    }
  };

  for (const t of tokens) {
    if (t === "-a" || t === "--all") {
      for (const x of ALL_TARGETS) add(x);
    } else if (t === "--wsl") {
      add("ao-prod");
    } else if (t === "--wsl-dev") {
      add("ao-dev");
    } else if (t === "-p" || t === "--pulu") {
      add("ao-pulu");
    }
    // 其他 flag (--install/--drain/--no-drain/--pulu-build-remote) 忽略
  }

  // 默认 = ao-prod (deploy.sh 的 backward-compat 行为)
  if (targets.length === 0) targets.push("ao-prod");

  return targets;
}

// 功能: 给定当前环境 + 目标列表, 判定是否允许. 返回结构化结果, 拒绝时给出可操作的 reason.
// 关注点:
//   - 决策矩阵:
//       current=ao-prod → ao-dev ✅ | ao-pulu ✅ | ao-prod ❌
//       current=ao-dev  → ao-prod ✅ | ao-pulu ✅ | ao-dev ❌
//       current=ao-pulu → 任何 ❌ (pulu 内存受限)
//   - 拒绝消息要告诉 agent 该走哪条路 (避免它再发一次同样的命令)
//   - Bypass 优先级最高, 但 log-style (在 reason 里保留痕迹) 还是完全静默? 选静默,
//     因为 bypass 是运维显式行为, 不需要污染消息
export function evaluateDeploy(
  current: DeployEnv,
  targets: DeployEnv[],
): DeployDecision {
  if (process.env.DEPLOY_GUARD_BYPASS === "1") return { allowed: true };

  if (current === "ao-pulu") {
    return {
      allowed: false,
      reason:
        "当前环境 ao-pulu 禁止发起部署（pulu 仅 3.6G 内存，在它上面跑 next build 会把整机抖死）。" +
        "请换 ao-prod 或 ao-dev 执行部署，或设 DEPLOY_GUARD_BYPASS=1 显式旁路。",
    };
  }

  for (const target of targets) {
    if (target !== current) continue;
    const alt = current === "ao-prod" ? "ao-dev" : "ao-prod";
    return {
      allowed: false,
      reason:
        `禁止从 ${current} 部署到自身（自部署会先关停本实例，agent SDK 子进程会被一并杀掉）。` +
        `请改用 ${alt} 部署到 ${current}，或显式加 --pulu 部署到 ao-pulu。`,
    };
  }
  return { allowed: true };
}

// 功能: 给 canUseTool 的总入口. 收到命令后:
//   1. 不是 deploy 命令 → null (调用方不拦截)
//   2. 当前环境认不出 → null (本地/CI 不挡)
//   3. 通过 evaluateDeploy 拿到决策
export function checkBashDeploy(command: string): DeployDecision | null {
  const targets = parseDeployTargets(command);
  if (targets.length === 0) return null;
  const current = detectCurrentEnv();
  if (!current) return null;
  return evaluateDeploy(current, targets);
}

// ========== 第二道防线: 进程级自杀拦截 (checkProcessKill) ==========

// Bare 平台进程名: 作为整个 pkill/killall target 出现时拦截. 精确模式 (含具体
//   项目路径或进程签名, 如 `ts-node.*main.ts` / `vite --host`) 放行, 否则
//   会误伤合法排障命令.
const PLATFORM_BARE_PROCESSES: readonly string[] = ["node", "next", "pm2"];

// 环境 → 平台 pm2 应用名 (实测核实: ao-prod/ao-dev/ao-pulu 与 deploy.sh 部署后的
//   pm2 进程名一一对应). 实例名映射写成一张表而非 if/else, 维护时一眼看清.
const ENV_TO_PM2_NAME: Record<DeployEnv, string> = {
  "ao-prod": "ao-prod",
  "ao-dev": "ao-dev",
  "ao-pulu": "ao-pulu",
};

// pm2 操作实例的 verb (delete/stop/restart/reload <name> 都会影响进程).
// kill 单独处理 (pm2 kill 是杀守护进程, 模式不一样, 见下方).
const PM2_INSTANCE_VERBS: readonly string[] = ["delete", "stop", "restart", "reload"];

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// 功能: 从命令串里找出所有 pkill/killall 调用的「第一个非-flag 参数」.
//   用于判断是不是 bare 平台进程名 (node/next/pm2).
// 关注点:
//   - pkill/killall 后面跟的 -9/-f/--signal/--ns 等都跳过 (以 '-' 开头的视为 flag)
//   - 第一个非-flag 参数就是 target; 可能是带引号的 ("next"), 去引号后比对
//   - 一个命令里可能调多次 pkill (用 ; / && / || 串起来), 所以返回数组, 全部要看
//   - 边界用 \b: 防止误匹配 npkill / pkiller / skillall 等
//   - `[^\n;|&()]+` 限制参数范围到 shell 控制字符前, 避免跨命令吞 args
function findPkillTargets(command: string): string[] {
  const targets: string[] = [];
  const re = /\b(?:pkill|killall)\b\s+([^\n;|&()]+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(command)) !== null) {
    const args = m[1].trim().split(/\s+/);
    for (const arg of args) {
      if (!arg) continue;
      if (arg.startsWith("-")) continue;
      targets.push(arg.replace(/^["']|["']$/g, ""));
      break;
    }
  }
  return targets;
}

// 功能: 第二道防线的入口, 与 checkBashDeploy 并列. 拦截「会杀掉/重启平台自身进程」
//   的裸 pm2 / pkill 命令. 返回 null = 不拦截 (调用方继续走其它检查).
// 关注点:
//   - 规则四条, 顺序无所谓, 都早返回:
//       a. pm2 kill (杀守护进程 = 全杀)
//       b. pm2 <delete|stop|restart|reload> all (无差别作用于本机所有 pm2 应用)
//       c. pm2 <delete|stop|restart|reload> <本机实例名> (操作当前环境平台进程)
//          实例名映射: ao-prod→ao-prod / ao-dev→ao-dev / ao-pulu→ao-pulu
//       d. pkill / killall 命中 bare 平台进程名 (node / next / pm2)
//          精确模式 (含具体路径/进程签名) 放行, 不误伤合法排障
//   - 匹配是对整个命令串做子串搜索 (事故原句里 pm2 delete all 前后都是管道/分号
//     拼接, 不能锚定 ^). 边界用 \b 防误匹配 (npkill / pkiller / 其它含 pkill 子串的工具名).
//   - bypass: DEPLOY_GUARD_BYPASS=1. 检测到危险命令也放行, 非危险命令仍返回 null
//     (调用方不知道我们看过, 也不污染日志).
//   - 拒绝 reason 必须告诉 agent 用「精确手段」(重启自己的 app 名 / 带具体路径的
//     pkill), 否则 agent 会反复发同样的命令
export function checkProcessKill(command: string): DeployDecision | null {
  const current = detectCurrentEnv();
  if (!current) return null;

  const bypass = process.env.DEPLOY_GUARD_BYPASS === "1";

  // 1. pm2 kill (杀 pm2 守护进程, 等于全杀)
  if (/\bpm2\s+kill\b/.test(command)) {
    if (bypass) return { allowed: true };
    const name = ENV_TO_PM2_NAME[current];
    return {
      allowed: false,
      reason:
        "检测到 'pm2 kill'：会杀掉 orchestrator 用户下所有 pm2 守护进程，" +
        `包含平台自身 (${name})。` +
        "请用 'pm2 restart <具体应用名>' 精确重启自己的 app，" +
        "或显式设 DEPLOY_GUARD_BYPASS=1 旁路。",
    };
  }

  // 2. pm2 <verb> all (无差别作用于本机所有 pm2 应用)
  if (/\bpm2\s+(?:delete|stop|restart|reload)\s+all\b/.test(command)) {
    if (bypass) return { allowed: true };
    const name = ENV_TO_PM2_NAME[current];
    return {
      allowed: false,
      reason:
        "检测到 'pm2 <verb> all'：会无差别作用于本机所有 pm2 应用，" +
        `包含平台自身 (${name})。` +
        "请用 'pm2 <verb> <具体应用名>' 精确操作，" +
        "或显式设 DEPLOY_GUARD_BYPASS=1 旁路。",
    };
  }

  // 3. pm2 <verb> <本机实例名> (操作当前环境的平台进程)
  {
    const name = ENV_TO_PM2_NAME[current];
    const verbAlt = PM2_INSTANCE_VERBS.join("|");
    const re = new RegExp(
      `\\bpm2\\s+(?:${verbAlt})\\s+${escapeRegExp(name)}\\b`,
    );
    if (re.test(command)) {
      if (bypass) return { allowed: true };
      return {
        allowed: false,
        reason:
          `检测到 'pm2 <verb> ${name}'：当前环境是 ${current}，` +
          "重启/停止/删除自身 pm2 应用会导致平台被关停，" +
          "agent SDK 子进程会被一并杀掉。" +
          // 推荐走 maintenance.sh restart：它先 pm2 delete 再 pm2 start，
          // 新进程 env 干净（不带调用 shell 的 session vars）。普通
          // `pm2 restart --update-env` 只合并不删除（pm2 已知行为），
          // 仍会透传 ORCHESTRATOR_TASK_ID 到 server 进程（2026-08-26
          // 38 条任务误归因事故的根因）。
          // 保留任务的正确姿势: maintenance.sh enter → restart → exit.
          `推荐用 'scripts/maintenance.sh restart ${name}'（清 env + verify），` +
          "或显式设 DEPLOY_GUARD_BYPASS=1 旁路。",
      };
    }
  }

  // 4. pkill / killall 命中 bare 平台进程名
  for (const target of findPkillTargets(command)) {
    if (PLATFORM_BARE_PROCESSES.includes(target)) {
      if (bypass) return { allowed: true };
      return {
        allowed: false,
        reason:
          `检测到 pkill/killall 命中平台进程 '${target}'：` +
          "会杀掉 next/node/pm2 进程中的平台自身。" +
          "请用 'pkill -f \"<具体项目路径或进程签名>\"' 精确杀掉目标进程，" +
          "或显式设 DEPLOY_GUARD_BYPASS=1 旁路。",
      };
    }
  }

  return null;
}
