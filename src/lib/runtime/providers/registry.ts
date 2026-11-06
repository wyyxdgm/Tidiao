// Provider registry — name → Provider 实例的 in-memory 映射.
//
// 关注点:
//   - 注册时机: 模块 load 时 (top-level), 单例. 不要从 buildEnv / request-time
//     注册, 那会让 registry 状态跨调用不一致 (mmx 换 key 重启进程自然刷新).
//   - 默认 provider 只有一个 ("mmx"), 名字统一小写字符串.
//   - 上层 (active-session 工具实现) 走 registry.get('mmx') 拿实例, 不直接 import.
//     这样未来加 sora / runway 时上层一行不改, 改本文件 +1 行 set + 加对应文件就行.
//   - 不做 lazy init / 工厂缓存: Provider 实例短寿, 每次构建时新建. 调用者
//     注册时一次性 new, 后面 get 拿引用.
//
// 加新 vendor 步骤:
//   1) 新建 src/lib/runtime/providers/<vendor>.ts, 实现 Provider 接口
//   2) 本文件 import + registry.set('<vendor>', new XxxProvider(...))
//   3) 完. 上层工具实现 / 前端 / storage 全部不动.

import type { Provider } from "./base";
import { MmxProvider } from "./mmx";

export class ProviderRegistry {
  private providers: Map<string, Provider> = new Map();
  private defaultName: string | null = null;

  set(name: string, provider: Provider): void {
    this.providers.set(name, provider);
  }

  get(name: string): Provider {
    const p = this.providers.get(name);
    if (!p) {
      throw new Error(
        `provider "${name}" not registered (have: ${Array.from(this.providers.keys()).join(", ") || "<none>"})`,
      );
    }
    return p;
  }

  /** 列出已注册 vendor 名, 供上游报错信息 / 调试. */
  list(): string[] {
    return Array.from(this.providers.keys());
  }

  /** 上层说"我来一个 provider"时拿默认. 当前默认 mmx. */
  getDefault(): Provider {
    if (!this.defaultName) {
      throw new Error("no default provider registered");
    }
    return this.get(this.defaultName);
  }

  setDefault(name: string): void {
    if (!this.providers.has(name)) {
      throw new Error(`cannot set default to unregistered provider "${name}"`);
    }
    this.defaultName = name;
  }
}

// 单例 — import 一次, 进程内共享同一份 registry.
export const registry = new ProviderRegistry();

// 默认 mmx 入池. 后续加 sora 时:
//   1) 加 SoraProvider 文件 + import 进来
//   2) registry.set('sora', new SoraProvider(...))
//   3) (可选) registry.setDefault('sora') 切换默认
registry.set("mmx", new MmxProvider());
registry.setDefault("mmx");
