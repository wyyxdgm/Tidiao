# Tidiao README 改版说明

> 交付：`README.md`（英文主版）+ `README.zh-CN.md`（中文版）+ `docs/screenshots/*.png`（5 张图，已裁浏览器栏、压到 1600px）
> 对照原版：GitHub `wyyxdgm/Tidiao` main 分支，89 行 / 4.8KB，v0.2.0

---

## 一、原 README 的问题（为什么没人下载）

| # | 问题 | 影响 |
|---|---|---|
| 1 | **零截图、零 GIF、零徽章** | 访客 3 秒内不知道这是什么长什么样，直接划走。GitHub 首页就是产品落地页，没有视觉 = 没有转化 |
| 2 | **第一屏全是抽象词**（orchestrator / SSE / multi-tenancy） | 没有痛点、没有场景，用户不知道“这跟我有什么关系” |
| 3 | **Quick Start 藏在中段，且 npm 优先** | 对小白不友好；Docker 一行命令反而在后面 |
| 4 | **模型支持只写一句 “Anthropic, Ark, and more”** | 你最强的卖点（8 家国内厂商、只填 Key、fallback、视觉路由）完全没展开，国内用户看不到共鸣 |
| 5 | **微信/手机派活、子任务唤醒等杀手功能没提** | 截图里最惊艳的两个场景（手机画图、父子唤醒）README 里一个字没有 |
| 6 | **纯英文，截图全中文** | 国内开发者（你的核心用户）阅读成本高；英文版对 GitHub 搜索友好，但需要中文版承接 |
| 7 | **没有 FAQ、没有对比、没有架构图** | “要不要 Claude 订阅？数据安全吗？多少钱？Windows 能用吗？” — 这些不答，用户不敢装 |
| 8 | **没有 Star 引导、没有状态透明度** | v0.2.0、单人维护、镜像 1.9GB 这些“诚实信息”没写，反而显得可疑 |

---

## 二、新版结构（按转化漏斗排）

```
徽章 + 一句话 Slogan（中英双语）
  ↓ 3 秒让人知道：这是干嘛的
Hero 大图（全局看板）
  ↓ 10 秒让人看到：长这样、规模感
为什么用提调（痛点对照表）
  ↓ 让用户对号入座：这就是我的痛
看它干活（4 张截图讲 1 个故事）
  ① 微信派活画图 → ② 任务详情直播 → ③ 子任务唤醒 → ④ 换模型只填 Key
  ↓ 让用户心动：我也想试
功能清单（9 条，一行一个）
  ↓ 让用户确认：功能够全
快速开始（Docker 优先 + 4 步跑通）
  ↓ 让用户动手：5 分钟能起来
模型支持表（8 家厂商）
  ↓ 让国内用户放心：我的 Key 能用
架构 30 秒 + 文档表 + FAQ
  ↓ 打消顾虑：安全/成本/Windows/镜像大小
状态 + Star 引导 + License
```

**核心改动逻辑：** 原版是“开发者说明书”，新版是“产品落地页”。说明书保留在 `docs/usage/`，README 只负责**吸引 + 上手**。

---

## 三、5 张截图怎么用的（以及为什么这么排）

| 截图 | 新文件名 | 位置 | 讲什么故事 |
|---|---|---|---|
| 看板.png | `01-kanban.png` | Hero 首图 | 规模感：5519 个任务一屏看全，状态颜色一目了然 |
| 叠好的照片.png | `02-wechat-dispatch.png` | 看它干活 ① | 最强钩子：手机微信派活，画作发回聊天。**注意：这张是合成图（手机叠看板），GitHub 上建议只放手机部分或保留现状并加注，文字在小屏会看不清** |
| 手机派发消息画图.png | `03-task-detail-image-gen.png` | 看它干活 ② | 证据链：MCP 工具调用 → 生成文件 → 自动总结，证明“不是 PPT，是真跑” |
| 子任务自动唤醒父任务+调用关系.png | `04-subtask-notify.png` | 看它干活 ③ | 差异化：父子编排 + 关系图，别的工具没有 |
| 模型支持.png | `05-model-providers.png` | 看它干活 ④ + 模型支持 | 国内共鸣：8 家厂商下拉、只填 Key、fallback 链 |

已做的处理：裁掉浏览器地址栏（前 88px）、统一压到 1600px 宽、PNG optimize。脱敏后 5 张共 1.6MB；若想更小可转 JPG（UI 截图转 JPG 质量 85 约省 60%）。

---

## 四、✅ 脱敏已处理（2026-11-10）

5 张图已脱敏后写入 `docs/screenshots/`，原图备份在工作区 `original-backup-not-for-commit/`（**不要提交到 GitHub**）。脱敏脚本在工作区 `tidiao-readme-redact/redact.py`：

| 敏感项 | 处理方式 |
|---|---|
| 账号邮箱（右上角 + 左下角 + 搜索框内） | 整块遮盖 |
| 内网域名（浏览器地址栏） | 整块遮盖 |
| 内部项目名 / 仓库名（左侧栏 + 顶部标签页） | 左侧栏高斯模糊，标签页整块遮盖 |
| 任务标题与客户名（看板卡片标题、子任务图聊天区） | 看板卡片标题逐卡模糊，子任务图聊天区整块遮盖 |
| 本机路径、任务 ID、项目 / 版本 ID | 子任务图右侧面板模糊 + ID 药丸遮盖 |
| API Key 前缀与 Base URL（模型图顶部表格） | Key 列整块遮盖，URL 列模糊 |
| 任务量数字 | 保留在图片里（真实使用量），README 正文不写成产品指标 |

保留未打码的：看板列头（已暂停/待审核/已完成…）、状态数字、手机微信 demo 对话（画图演示本身）、模型厂商下拉、画作本身 — 这些是产品演示内容。

脱敏是脚本化做的（不是手工涂抹），坐标可复算、不会漏；重截后按同一策略重跑即可，文件名不变。

> 仍建议上线前人工再扫一遍 5 张图（放大看）。如需更干净的版本，可用测试账号 + demo 项目重截替换（文件名不变）。

---

## 五、怎么落到仓库

```bash
# 1. 把本目录的 README.md / README.zh-CN.md / REVIEW.md 拷到仓库根目录（覆盖）
# 2. 把 docs/screenshots/ 拷到仓库 docs/screenshots/（该目录在仓库里原本不存在，新建即可）
cp README.md README.zh-CN.md REVIEW.md /path/to/Tidiao/
cp docs/screenshots/*.png /path/to/Tidiao/docs/screenshots/

# 3. 检查图片链接（GitHub 相对路径，大小写敏感）
#    README 里写的是 docs/screenshots/01-kanban.png 等

# 4. 提交
cd /path/to/Tidiao
git add README.md README.zh-CN.md REVIEW.md docs/screenshots/
git commit -m "docs: README 改版 — 截图演示 + 痛点转化 + Docker 优先 + 中文版"
git push
```

> 仓库原有 `docs/usage/screenshots/dag-p4-*.png` 保持不动，新图放 `docs/screenshots/` 不冲突。
> `screenshots-minimal/` 那套没进仓：它是「最少遮挡」的早期版本，内部信息反而露得更多，留着当参考即可。

---

## 六、还可以继续加的（按优先级）

1. **30 秒 GIF**（最高优先级）：录屏 “微信发消息 → 手机收到画 → 看板变绿”，放 Hero 位置。截图是静态的，GIF 转化率通常高 2-3 倍。
2. **在线 Demo**：`demo.tidiao.xxx` 只读账号，README 加 “Live Demo” 徽章。
3. **Star History 图**：`star-history.com` 生成，放在底部。
4. **一键部署按钮**：Zeabur / Railway / Fly.io 的 Deploy 按钮（需先验证 Docker 镜像在这些平台能跑）。
5. **视频教程**：B站/YouTube 5 分钟上手，链接放 Quick Start 上方。

---

## 七、没改的东西（故意保留）

- License Apache-2.0、单人维护暂不收 PR、v0.2.0 状态 — 诚实写比吹牛更能建立信任
- Docker 镜像 1.9GB 的已知限制 — 写进 FAQ，用户装之前就知道，不会觉得被骗
- 英文主版 + 中文版双 README — 英文版吃 GitHub 搜索流量，中文版承接国内用户，两边互链
