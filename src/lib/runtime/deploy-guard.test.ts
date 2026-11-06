import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  detectCurrentEnv,
  parseDeployTargets,
  evaluateDeploy,
  checkBashDeploy,
  checkProcessKill,
} from "./deploy-guard";

describe("deploy-guard: detectCurrentEnv", () => {
  const originalUser = process.env.USER;
  const originalPort = process.env.PORT;
  const originalOrchUser = process.env.ORCHESTRATOR_USER;

  beforeEach(() => {
    delete process.env.USER;
    delete process.env.ORCHESTRATOR_USER;
    delete process.env.PORT;
  });
  afterEach(() => {
    if (originalUser === undefined) delete process.env.USER;
    else process.env.USER = originalUser;
    if (originalOrchUser === undefined) delete process.env.ORCHESTRATOR_USER;
    else process.env.ORCHESTRATOR_USER = originalOrchUser;
    if (originalPort === undefined) delete process.env.PORT;
    else process.env.PORT = originalPort;
  });

  it("USER=orchestrator → ao-pulu (优先级高于 PORT)", () => {
    process.env.USER = "orchestrator";
    process.env.PORT = "13000"; // pulu 也是 13000, 必须先判 user
    expect(detectCurrentEnv()).toBe("ao-pulu");
  });

  it("ORCHESTRATOR_USER=orchestrator → ao-pulu (fallback)", () => {
    delete process.env.USER;
    process.env.ORCHESTRATOR_USER = "orchestrator";
    expect(detectCurrentEnv()).toBe("ao-pulu");
  });

  it("USER=damo + PORT=13000 → ao-prod", () => {
    process.env.USER = "damo";
    process.env.PORT = "13000";
    expect(detectCurrentEnv()).toBe("ao-prod");
  });

  it("USER=damo + PORT=13001 → ao-dev", () => {
    process.env.USER = "damo";
    process.env.PORT = "13001";
    expect(detectCurrentEnv()).toBe("ao-dev");
  });

  it("USER=damo 但 PORT 未设 → null (本地/CI 不挡)", () => {
    process.env.USER = "damo";
    expect(detectCurrentEnv()).toBeNull();
  });

  it("USER 和 PORT 都没设 → null", () => {
    expect(detectCurrentEnv()).toBeNull();
  });

  it("未识别的端口 (如 14000) → null", () => {
    process.env.USER = "damo";
    process.env.PORT = "14000";
    expect(detectCurrentEnv()).toBeNull();
  });
});

describe("deploy-guard: parseDeployTargets", () => {
  it("默认 (无 flag) → [ao-prod] (向后兼容 deploy.sh:120)", () => {
    expect(parseDeployTargets("npm run deploy")).toEqual(["ao-prod"]);
  });

  it("npm run deploy -- --wsl → [ao-prod]", () => {
    expect(parseDeployTargets("npm run deploy -- --wsl")).toEqual(["ao-prod"]);
  });

  it("npm run deploy -- --wsl-dev → [ao-dev]", () => {
    expect(parseDeployTargets("npm run deploy -- --wsl-dev")).toEqual(["ao-dev"]);
  });

  it("npm run deploy -- --pulu → [ao-pulu]", () => {
    expect(parseDeployTargets("npm run deploy -- --pulu")).toEqual(["ao-pulu"]);
  });

  it("npm run deploy -- -p → [ao-pulu] (短选项)", () => {
    expect(parseDeployTargets("npm run deploy -- -p")).toEqual(["ao-pulu"]);
  });

  it("npm run deploy -- -a → 全三个", () => {
    expect(parseDeployTargets("npm run deploy -- -a")).toEqual([
      "ao-prod",
      "ao-dev",
      "ao-pulu",
    ]);
  });

  it("npm run deploy -- --all → 全三个 (长选项)", () => {
    expect(parseDeployTargets("npm run deploy -- --all")).toEqual([
      "ao-prod",
      "ao-dev",
      "ao-pulu",
    ]);
  });

  it("npm run deploy -- --wsl --pulu → [ao-prod, ao-pulu], 去重保序", () => {
    expect(parseDeployTargets("npm run deploy -- --wsl --pulu")).toEqual([
      "ao-prod",
      "ao-pulu",
    ]);
  });

  it("npm run deploy -- --drain → [ao-prod] (忽略 --drain, 不报错)", () => {
    expect(parseDeployTargets("npm run deploy -- --drain")).toEqual(["ao-prod"]);
  });

  it("npm run deploy -- --install --wsl → [ao-prod] (忽略 --install)", () => {
    expect(parseDeployTargets("npm run deploy -- --install --wsl")).toEqual([
      "ao-prod",
    ]);
  });

  it("npm run deploy -- --no-drain --wsl-dev → [ao-dev]", () => {
    expect(parseDeployTargets("npm run deploy -- --no-drain --wsl-dev")).toEqual([
      "ao-dev",
    ]);
  });

  it("bash scripts/deploy.sh --wsl → [ao-prod] (bash 调用形式)", () => {
    expect(parseDeployTargets("bash scripts/deploy.sh --wsl")).toEqual(["ao-prod"]);
  });

  it("./scripts/deploy.sh --wsl-dev → [ao-dev] (相对路径形式)", () => {
    expect(parseDeployTargets("./scripts/deploy.sh --wsl-dev")).toEqual([
      "ao-dev",
    ]);
  });

  it("./scripts/deploy.sh -p → [ao-pulu]", () => {
    expect(parseDeployTargets("./scripts/deploy.sh -p")).toEqual(["ao-pulu"]);
  });

  it("ls -la → [] (非 deploy 命令)", () => {
    expect(parseDeployTargets("ls -la")).toEqual([]);
  });

  it("echo hello → [] (非 deploy 命令)", () => {
    expect(parseDeployTargets("echo hello")).toEqual([]);
  });

  it("npm test → [] (npm 子命令不是 deploy)", () => {
    expect(parseDeployTargets("npm test")).toEqual([]);
  });

  it("npm run deploy-anything → [] (要 \\b 边界, 防止误匹配 deploy-other)", () => {
    expect(parseDeployTargets("npm run deploy-anything")).toEqual([]);
  });

  it("前后空格容忍", () => {
    expect(parseDeployTargets("   npm run deploy -- --wsl-dev   ")).toEqual([
      "ao-dev",
    ]);
  });

  it("-a --drain 顺序无影响", () => {
    expect(parseDeployTargets("npm run deploy -- --drain -a")).toEqual([
      "ao-prod",
      "ao-dev",
      "ao-pulu",
    ]);
  });
});

describe("deploy-guard: evaluateDeploy (决策矩阵)", () => {
  // 旁路测试单独放, 用 beforeEach 清掉
  describe("BYPASS", () => {
    const origBypass = process.env.DEPLOY_GUARD_BYPASS;
    afterEach(() => {
      if (origBypass === undefined) delete process.env.DEPLOY_GUARD_BYPASS;
      else process.env.DEPLOY_GUARD_BYPASS = origBypass;
    });

    it("DEPLOY_GUARD_BYPASS=1 → 任何组合都 allow", () => {
      process.env.DEPLOY_GUARD_BYPASS = "1";
      expect(evaluateDeploy("ao-prod", ["ao-prod"])).toEqual({ allowed: true });
      expect(evaluateDeploy("ao-pulu", ["ao-prod", "ao-dev", "ao-pulu"])).toEqual({
        allowed: true,
      });
    });

    it("DEPLOY_GUARD_BYPASS=0/空 → 正常走决策", () => {
      delete process.env.DEPLOY_GUARD_BYPASS;
      expect(evaluateDeploy("ao-prod", ["ao-prod"]).allowed).toBe(false);
      process.env.DEPLOY_GUARD_BYPASS = "0";
      expect(evaluateDeploy("ao-prod", ["ao-prod"]).allowed).toBe(false);
    });
  });

  describe("current=ao-prod", () => {
    it("target=ao-prod → deny (自部署)", () => {
      const d = evaluateDeploy("ao-prod", ["ao-prod"]);
      expect(d.allowed).toBe(false);
      if (!d.allowed) expect(d.reason).toMatch(/ao-prod/);
      if (!d.allowed) expect(d.reason).toMatch(/ao-dev/); // 提示了替代路径
    });

    it("target=ao-dev → allow", () => {
      expect(evaluateDeploy("ao-prod", ["ao-dev"])).toEqual({ allowed: true });
    });

    it("target=ao-pulu → allow", () => {
      expect(evaluateDeploy("ao-prod", ["ao-pulu"])).toEqual({ allowed: true });
    });

    it("target=ao-dev + ao-pulu → allow", () => {
      expect(evaluateDeploy("ao-prod", ["ao-dev", "ao-pulu"])).toEqual({
        allowed: true,
      });
    });

    it("target=[ao-prod, ao-dev] → deny (列表里有 self)", () => {
      expect(evaluateDeploy("ao-prod", ["ao-prod", "ao-dev"]).allowed).toBe(false);
    });
  });

  describe("current=ao-dev", () => {
    it("target=ao-dev → deny (自部署)", () => {
      const d = evaluateDeploy("ao-dev", ["ao-dev"]);
      expect(d.allowed).toBe(false);
      if (!d.allowed) expect(d.reason).toMatch(/ao-dev/);
      if (!d.allowed) expect(d.reason).toMatch(/ao-prod/); // 提示了替代路径
    });

    it("target=ao-prod → allow", () => {
      expect(evaluateDeploy("ao-dev", ["ao-prod"])).toEqual({ allowed: true });
    });

    it("target=ao-pulu → allow", () => {
      expect(evaluateDeploy("ao-dev", ["ao-pulu"])).toEqual({ allowed: true });
    });

    it("target=[ao-prod, ao-pulu] → allow", () => {
      expect(evaluateDeploy("ao-dev", ["ao-prod", "ao-pulu"])).toEqual({
        allowed: true,
      });
    });
  });

  describe("current=ao-pulu", () => {
    it("target=ao-prod → deny (pulu 不允许任何出向)", () => {
      const d = evaluateDeploy("ao-pulu", ["ao-prod"]);
      expect(d.allowed).toBe(false);
      if (!d.allowed) expect(d.reason).toMatch(/pulu/i);
    });

    it("target=ao-dev → deny", () => {
      expect(evaluateDeploy("ao-pulu", ["ao-dev"]).allowed).toBe(false);
    });

    it("target=ao-pulu → deny (自部署也挡)", () => {
      expect(evaluateDeploy("ao-pulu", ["ao-pulu"]).allowed).toBe(false);
    });

    it("target=全三个 → deny", () => {
      expect(
        evaluateDeploy("ao-pulu", ["ao-prod", "ao-dev", "ao-pulu"]).allowed,
      ).toBe(false);
    });
  });
});

describe("deploy-guard: checkBashDeploy (集成)", () => {
  const originalUser = process.env.USER;
  const originalPort = process.env.PORT;
  const originalBypass = process.env.DEPLOY_GUARD_BYPASS;

  beforeEach(() => {
    delete process.env.USER;
    delete process.env.PORT;
    delete process.env.DEPLOY_GUARD_BYPASS;
  });
  afterEach(() => {
    if (originalUser === undefined) delete process.env.USER;
    else process.env.USER = originalUser;
    if (originalPort === undefined) delete process.env.PORT;
    else process.env.PORT = originalPort;
    if (originalBypass === undefined) delete process.env.DEPLOY_GUARD_BYPASS;
    else process.env.DEPLOY_GUARD_BYPASS = originalBypass;
  });

  it("非 deploy 命令 → null (不挡)", () => {
    process.env.USER = "damo";
    process.env.PORT = "13000";
    expect(checkBashDeploy("ls -la")).toBeNull();
    expect(checkBashDeploy("npm test")).toBeNull();
    expect(checkBashDeploy("echo hello")).toBeNull();
  });

  it("USER=damo PORT=13000 + 'npm run deploy' → deny (默认 = self)", () => {
    process.env.USER = "damo";
    process.env.PORT = "13000";
    const d = checkBashDeploy("npm run deploy");
    expect(d).not.toBeNull();
    expect(d!.allowed).toBe(false);
  });

  it("USER=damo PORT=13000 + 'npm run deploy -- --wsl' → deny (显式 self)", () => {
    process.env.USER = "damo";
    process.env.PORT = "13000";
    expect(checkBashDeploy("npm run deploy -- --wsl")!.allowed).toBe(false);
  });

  it("USER=damo PORT=13000 + 'npm run deploy -- --wsl-dev' → allow", () => {
    process.env.USER = "damo";
    process.env.PORT = "13000";
    expect(checkBashDeploy("npm run deploy -- --wsl-dev")).toEqual({
      allowed: true,
    });
  });

  it("USER=damo PORT=13000 + 'npm run deploy -- -p' → allow (deploy 到 pulu)", () => {
    process.env.USER = "damo";
    process.env.PORT = "13000";
    expect(checkBashDeploy("npm run deploy -- -p")).toEqual({ allowed: true });
  });

  it("USER=damo PORT=13000 + 'npm run deploy -- -a' → deny (-a 含 self)", () => {
    process.env.USER = "damo";
    process.env.PORT = "13000";
    expect(checkBashDeploy("npm run deploy -- -a")!.allowed).toBe(false);
  });

  it("USER=damo PORT=13001 + 'npm run deploy -- --wsl' → allow (交叉部署)", () => {
    process.env.USER = "damo";
    process.env.PORT = "13001";
    expect(checkBashDeploy("npm run deploy -- --wsl")).toEqual({ allowed: true });
  });

  it("USER=damo PORT=13001 + 'npm run deploy -- --wsl-dev' → deny (self)", () => {
    process.env.USER = "damo";
    process.env.PORT = "13001";
    expect(checkBashDeploy("npm run deploy -- --wsl-dev")!.allowed).toBe(false);
  });

  it("USER=orchestrator + 任何 deploy → deny (pulu 全挡)", () => {
    process.env.USER = "orchestrator";
    expect(checkBashDeploy("npm run deploy -- --wsl")!.allowed).toBe(false);
    expect(checkBashDeploy("npm run deploy -- --wsl-dev")!.allowed).toBe(false);
    expect(checkBashDeploy("npm run deploy -- -p")!.allowed).toBe(false);
    expect(checkBashDeploy("npm run deploy -- -a")!.allowed).toBe(false);
  });

  it("USER=orchestrator + 'echo hi' → null (非 deploy 不挡)", () => {
    process.env.USER = "orchestrator";
    expect(checkBashDeploy("echo hi")).toBeNull();
  });

  it("USER=damo PORT 未设 + deploy 命令 → null (认不出环境就不挡)", () => {
    process.env.USER = "damo";
    expect(checkBashDeploy("npm run deploy -- --wsl")).toBeNull();
  });

  it("DEPLOY_GUARD_BYPASS=1 强制放行", () => {
    process.env.USER = "damo";
    process.env.PORT = "13000";
    process.env.DEPLOY_GUARD_BYPASS = "1";
    expect(checkBashDeploy("npm run deploy -- --wsl")).toEqual({ allowed: true });
  });

  it("bash scripts/deploy.sh 在 ao-prod 上被拦 (等价 npm run deploy)", () => {
    process.env.USER = "damo";
    process.env.PORT = "13000";
    expect(checkBashDeploy("bash scripts/deploy.sh --wsl")!.allowed).toBe(false);
  });

  it("./scripts/deploy.sh --wsl-dev 在 ao-prod 上放行", () => {
    process.env.USER = "damo";
    process.env.PORT = "13000";
    expect(checkBashDeploy("./scripts/deploy.sh --wsl-dev")).toEqual({
      allowed: true,
    });
  });
});

// ========== 第二道防线: checkProcessKill ==========

describe("deploy-guard: checkProcessKill (进程级自杀拦截)", () => {
  const originalUser = process.env.USER;
  const originalPort = process.env.PORT;
  const originalBypass = process.env.DEPLOY_GUARD_BYPASS;
  const originalOrchUser = process.env.ORCHESTRATOR_USER;

  beforeEach(() => {
    delete process.env.USER;
    delete process.env.ORCHESTRATOR_USER;
    delete process.env.PORT;
    delete process.env.DEPLOY_GUARD_BYPASS;
  });
  afterEach(() => {
    if (originalUser === undefined) delete process.env.USER;
    else process.env.USER = originalUser;
    if (originalOrchUser === undefined) delete process.env.ORCHESTRATOR_USER;
    else process.env.ORCHESTRATOR_USER = originalOrchUser;
    if (originalPort === undefined) delete process.env.PORT;
    else process.env.PORT = originalPort;
    if (originalBypass === undefined) delete process.env.DEPLOY_GUARD_BYPASS;
    else process.env.DEPLOY_GUARD_BYPASS = originalBypass;
  });

  // ----- 环境识别 / bypass -----

  it("USER=damo + PORT 未设 → null (本地/CI 认不出环境不挡, 即使命令危险)", () => {
    process.env.USER = "damo";
    expect(checkProcessKill("pm2 kill")).toBeNull();
    expect(checkProcessKill("pkill -9 node")).toBeNull();
  });

  it("USER 和 PORT 都没设 → null", () => {
    expect(checkProcessKill("pm2 kill")).toBeNull();
  });

  it("DEPLOY_GUARD_BYPASS=1 在 ao-prod 上对所有危险命令放行", () => {
    process.env.USER = "damo";
    process.env.PORT = "13000";
    process.env.DEPLOY_GUARD_BYPASS = "1";
    expect(checkProcessKill("pm2 kill")).toEqual({ allowed: true });
    expect(checkProcessKill("pm2 delete all")).toEqual({ allowed: true });
    expect(checkProcessKill("pkill -9 node")).toEqual({ allowed: true });
    expect(checkProcessKill("killall node")).toEqual({ allowed: true });
    expect(checkProcessKill("pm2 restart ao-prod")).toEqual({ allowed: true });
  });

  it("DEPLOY_GUARD_BYPASS=1 非危险命令仍返回 null (不污染调用方)", () => {
    process.env.USER = "damo";
    process.env.PORT = "13000";
    process.env.DEPLOY_GUARD_BYPASS = "1";
    expect(checkProcessKill("ls -la")).toBeNull();
    expect(checkProcessKill("pm2 restart weishu-backend-api")).toBeNull();
  });

  // ----- 事故原句回归 (2026-08-21 weishu 后端排障) -----

  it("🚨 事故原句原样: ao-pulu 上 → deny", () => {
    process.env.USER = "orchestrator"; // ao-pulu
    const cmd =
      'pm2 delete all 2>&1 | tail -3 && sleep 2 && pkill -9 -f "ts-node.*main.ts" 2>&1; pkill -9 -f "vite --host" 2>&1; sleep 2 && lsof -i :13010';
    const d = checkProcessKill(cmd);
    expect(d).not.toBeNull();
    expect(d!.allowed).toBe(false);
    // 拒绝消息要可操作
    if (!d!.allowed) {
      expect(d!.reason).toMatch(/pm2/);
      expect(d!.reason).toMatch(/all/);
      expect(d!.reason).toMatch(/DEPLOY_GUARD_BYPASS/);
    }
  });

  // ----- 规则 1: pm2 kill -----

  it("pm2 kill 在 ao-pulu 上 → deny", () => {
    process.env.USER = "orchestrator";
    const d = checkProcessKill("pm2 kill");
    expect(d).not.toBeNull();
    expect(d!.allowed).toBe(false);
  });

  it("pm2 kill 在 ao-prod 上 → deny", () => {
    process.env.USER = "damo";
    process.env.PORT = "13000";
    expect(checkProcessKill("pm2 kill")!.allowed).toBe(false);
  });

  // ----- 规则 2: pm2 <verb> all -----

  it("pm2 delete all 在 ao-pulu 上 → deny", () => {
    process.env.USER = "orchestrator";
    expect(checkProcessKill("pm2 delete all")!.allowed).toBe(false);
  });

  it("pm2 restart all 在 ao-prod 上 → deny", () => {
    process.env.USER = "damo";
    process.env.PORT = "13000";
    expect(checkProcessKill("pm2 restart all")!.allowed).toBe(false);
  });

  it("pm2 reload all 在 ao-dev 上 → deny", () => {
    process.env.USER = "damo";
    process.env.PORT = "13001";
    expect(checkProcessKill("pm2 reload all")!.allowed).toBe(false);
  });

  // ----- 规则 3: pm2 <verb> <本机实例名> -----

  it("pm2 restart ao-dev 在 ao-dev 上 → deny (操作自身)", () => {
    process.env.USER = "damo";
    process.env.PORT = "13001";
    expect(checkProcessKill("pm2 restart ao-dev")!.allowed).toBe(false);
  });

  it("pm2 restart ao-dev 在 ao-prod 上 → allow (操作别的实例, 不是自身)", () => {
    process.env.USER = "damo";
    process.env.PORT = "13000";
    expect(checkProcessKill("pm2 restart ao-dev")).toBeNull();
  });

  it("pm2 restart ao-pulu 在 ao-pulu 上 → deny (操作自身)", () => {
    process.env.USER = "orchestrator";
    expect(checkProcessKill("pm2 restart ao-pulu")!.allowed).toBe(false);
  });

  it("pm2 restart ao-prod 在 ao-pulu 上 → allow (操作别的实例)", () => {
    process.env.USER = "orchestrator";
    expect(checkProcessKill("pm2 restart ao-prod")).toBeNull();
  });

  it("pm2 delete ao-prod 在 ao-prod 上 → deny (自删)", () => {
    process.env.USER = "damo";
    process.env.PORT = "13000";
    expect(checkProcessKill("pm2 delete ao-prod")!.allowed).toBe(false);
  });

  it("pm2 restart weishu-backend-api (非平台实例名) → allow", () => {
    process.env.USER = "damo";
    process.env.PORT = "13000";
    expect(checkProcessKill("pm2 restart weishu-backend-api")).toBeNull();
  });

  // ----- 规则 4: pkill / killall bare 平台进程名 -----

  it("pkill -9 node 在 ao-pulu 上 → deny (bare node)", () => {
    process.env.USER = "orchestrator";
    expect(checkProcessKill("pkill -9 node")!.allowed).toBe(false);
  });

  it("killall node 在 ao-prod 上 → deny (bare node)", () => {
    process.env.USER = "damo";
    process.env.PORT = "13000";
    expect(checkProcessKill("killall node")!.allowed).toBe(false);
  });

  it("pkill -f \"next\" 在 ao-prod 上 → deny (bare next)", () => {
    process.env.USER = "damo";
    process.env.PORT = "13000";
    expect(checkProcessKill('pkill -f "next"')!.allowed).toBe(false);
  });

  it("pkill -9 pm2 在 ao-dev 上 → deny (bare pm2)", () => {
    process.env.USER = "damo";
    process.env.PORT = "13001";
    expect(checkProcessKill("pkill -9 pm2")!.allowed).toBe(false);
  });

  // ----- 规则 4 放行: 精确模式 -----

  it("pkill -f \"ts-node.*main.ts\" → allow (精确进程签名)", () => {
    process.env.USER = "orchestrator";
    expect(
      checkProcessKill('pkill -f "ts-node.*main.ts"'),
    ).toBeNull();
  });

  it("pkill -f \"vite --host\" → allow (精确进程签名)", () => {
    process.env.USER = "orchestrator";
    expect(checkProcessKill('pkill -f "vite --host"')).toBeNull();
  });

  it("pkill -f next-server → allow (含 next 但不是 bare)", () => {
    process.env.USER = "damo";
    process.env.PORT = "13000";
    expect(checkProcessKill("pkill -f next-server")).toBeNull();
  });

  it("pkill -f \"/path/to/weishu/backend/main.ts\" → allow (含具体路径)", () => {
    process.env.USER = "damo";
    process.env.PORT = "13000";
    expect(
      checkProcessKill('pkill -f "/path/to/weishu/backend/main.ts"'),
    ).toBeNull();
  });

  // ----- 边界: 不误伤 / 不漏匹配 -----

  it("pm2 kill 在 'echo pm2 kill' 里仍然命中 (子串搜索)", () => {
    process.env.USER = "orchestrator";
    // 注意: 这里我们故意当作真实命令拦截, 因为 agent 的命令串就是传给 bash 的,
    // 'echo pm2 kill' 实际执行了 echo 但意图和误伤无差异, 保守拒绝.
    // (如果想放行 echo, 加 'type' 边界即可, 见下条)
    // 当前实现: 子串搜索, 会命中. 这是有意的保守.
    const d = checkProcessKill("echo pm2 kill");
    expect(d).not.toBeNull();
    expect(d!.allowed).toBe(false);
  });

  it("npm run pm2-killer → allow (要 \\b 边界, 不误匹配含 'pm2' 的子串工具)", () => {
    process.env.USER = "orchestrator";
    expect(checkProcessKill("npm run pm2-killer")).toBeNull();
  });

  it("npkill / pkiller 这种工具名不误匹配 (\\b 边界)", () => {
    process.env.USER = "orchestrator";
    expect(checkProcessKill("npkill something")).toBeNull();
    expect(checkProcessKill("pkiller node")).toBeNull();
  });

  it("一个命令里多个 pkill, 任一 bare 就 deny", () => {
    process.env.USER = "orchestrator";
    const cmd =
      'pkill -f "ts-node.*main.ts" || pkill -9 node && echo done';
    expect(checkProcessKill(cmd)!.allowed).toBe(false);
  });

  it("pm2 后跟非 verb 关键字 (pm2 ls, pm2 logs, pm2 status) → allow", () => {
    process.env.USER = "orchestrator";
    expect(checkProcessKill("pm2 ls")).toBeNull();
    expect(checkProcessKill("pm2 logs")).toBeNull();
    expect(checkProcessKill("pm2 status")).toBeNull();
    expect(checkProcessKill("pm2 jlist")).toBeNull();
  });

  it("非 pm2/pkill/killall 的普通命令 → null", () => {
    process.env.USER = "damo";
    process.env.PORT = "13000";
    expect(checkProcessKill("ls -la")).toBeNull();
    expect(checkProcessKill("cat /var/log/syslog")).toBeNull();
    expect(checkProcessKill("systemctl restart nginx")).toBeNull();
  });
});

// 矩阵速查表 (注释用, 给后续维护者一眼看清意图)
// ┌──────────┬──────────┬──────────┬──────────┐
// │ from\\to │ ao-prod  │ ao-dev   │ ao-pulu  │
// ├──────────┼──────────┼──────────┼──────────┤
// │ ao-prod  │ ❌ deny   │ ✅ allow  │ ✅ allow  │
// │ ao-dev   │ ✅ allow  │ ❌ deny   │ ✅ allow  │
// │ ao-pulu  │ ❌ deny   │ ❌ deny   │ ❌ deny   │
// └──────────┴──────────┴──────────┴──────────┴──
// 旁路: DEPLOY_GUARD_BYPASS=1 → 全 ✅
//
// 第二道防线 (checkProcessKill, 2026-08-21 事故): 拦截会自杀的裸命令
// - pm2 kill                              → 全 env deny
// - pm2 <delete|stop|restart|reload> all   → 全 env deny
// - pm2 <verb> <本机实例名>                 → 仅本 env deny
// - pkill / killall <bare node|next|pm2>    → 全 env deny
// - pkill -f "ts-node.*main.ts" 等精确模式  → 放行
