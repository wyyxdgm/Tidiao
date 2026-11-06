# 已验证模型（火山方舟 Ark Anthropic 兼容 API）

## 国内厂商供应商目录（R240，2026-10-12 建）

**数据源 = `src/lib/provider-catalog/catalog.json`**（8 家厂商：官网 / Anthropic 兼容端点 / Key 获取页 / 模型列表，全部 curl 实测可达）。前端「快捷选择供应商」下拉 + `GET /api/provider-catalog` 从这份数据出。

| 厂商 | Anthropic 兼容 Base URL | 验证 |
|------|------------------------|------|
| 火山方舟 (Ark) | `https://ark.cn-beijing.volces.com/api/plan` | 2026-10-12 ✅ |
| DeepSeek | `https://api.deepseek.com/anthropic` | 2026-10-12 ✅ |
| 智谱 GLM | `https://open.bigmodel.cn/api/anthropic` | 2026-10-12 ✅ |
| Kimi (Moonshot) | `https://api.moonshot.cn/anthropic` | 2026-10-12 ✅ |
| MiniMax | `https://api.minimaxi.com/anthropic` | 2026-10-12 ✅ |
| 阿里百炼 (Qwen) | `https://dashscope.aliyuncs.com/api/v2/apps/claude-code-proxy` | 2026-10-12 ✅ |
| 硅基流动 (SiliconFlow) | `https://api.siliconflow.cn` | 2026-10-12 ✅ |
| 腾讯混元 | `https://api.hunyuan.cloud.tencent.com/anthropic` | 2026-10-12 ✅ |

**模型列表日更**：`jiti scripts/update-provider-catalog.ts`（`--check` 只 diff）。对每家配的 OpenAI 兼容 `/models` 端点拉列表（key 从 env `PROVIDER_<ID大写>_API_KEY`），过滤 embedding/tts 等非 LLM 条目后 merge 回 catalog.json。没配 key 的厂商跳过保留原列表，单家失败不阻断。读取层 `src/lib/provider-catalog/index.ts`（zod 校验 + 5s TTL 缓存 + 按 base_url 反查厂商）。

**实测样例**（2026-10-12，用平台已有 key 拉的）：智谱返回 11 个模型（glm-4.5 ~ glm-5.3-flashx），比 seed 手写列表新——正是日更的价值。百度千帆未收录（未发现 Anthropic 兼容端点，`qianfan.baidubce.com/v2/messages` 404）；阶跃 StepFun 待官方文档确认后收。



## API Key 配置

```bash
# Anthropic 官方
export ANTHROPIC_API_KEY=sk-ant-...

# 第三方兼容 API（火山方舟 Ark）
export ANTHROPIC_API_KEY=ark-...
export ANTHROPIC_BASE_URL=https://ark.cn-beijing.volces.com/api/plan
# task 不填 model 时走 ANTHROPIC_MODEL 环境变量
```

## 模型列表

| 显示名 | 实际路由 | 备注 |
|--------|---------|------|
| glm-5.2 | `glm-5-2-260617` | 当前默认 |
| glm-latest | 同上 | — |
| MiniMax-M3 | `minimax-m3` | — |
| MiniMax-M2.7 | `minimax-m2.7` | — |
| doubao-seed-2.1-turbo | `doubao-seed-2-1-turbo-260628` | — |
| doubao-seed-2.0-pro | `doubao-seed-2-0-pro-260215` | — |
| doubao-seed-2.0-lite | `doubao-seed-2-0-lite-260215` | — |

> doubao-1.5-pro/lite 不支持 agent plan，会报 UnsupportedModel。

## fallback 链（v514，飞书 R175）

设置页每份 LLM 配置可配**有序 fallback 链**（点选同 owner 其它配置，上限 5 个）+ **支持视觉**标记（三态：未设置=按模型名推断 / 支持 / 不支持）：

- **同凭证成员**（同 API Key + 同 Base URL，如同一 Ark 代理下的多个模型）→ 模型名传给 SDK `fallbackModel`，主模型挂了自动按序切，每 turn 回试主模型。
- **跨凭证成员** → 起跑阶段（模型还没开口）失败时按链换配置重跑（`tasks.events` 里 `llm_fallback` 有 trace）。
- **带图任务** + 主模型明确不支持视觉 + 链上有支持的 → 起跑前自动换主（保守：主模型视觉「未知」不换）。

设计与实现：`docs/plans/llm-fallback-chain.md`；测试 `src/lib/db/llm-configs.test.ts`。
