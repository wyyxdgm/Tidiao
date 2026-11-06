# 文件/图片上传（Attachments）

> 状态：✅ **已实现**（v21 migration + API + symlink + 前端拖拽均在线；v69 polymorphic 加
> 需求点附件，见 §Polymorphic）。
> 本文档描述的即现状，不是待做清单 —— 不要重复实现一遍。
>
> **已知缺口**（2026-08-20 核实）：
> - 白名单不含音视频；即使加了 agent 也读不了内容（需转录）。Office 文档（xlsx/docx/pptx 等）已在白名单里
>   —— agent 仍读不了二进制内容，但用户/操作员可以查看。
> - 只支持 multipart 上传，**没有通用的「从 URL 拉取」入口**。
>   ✅ 例外：「从飞书表格取图」已有专用链路（`src/lib/feishu/row-images.ts`，
>   飞书 sync 导入时自动落盘 + symlink，`source='reference'`），见
>   `docs/plans/requirement-as-entity.md` §16.9。其他 URL 仍落不到本地。

## 核心原则

**文件存本地，agent 拿路径，自己决定怎么处理。**

所有文件类型统一处理（图片、压缩包、PDF、文本文件等），不直接内嵌到 API 消息上下文中（避免 30MB 压缩包撑爆 token）。

流程：用户上传 → 存文件到服务本地 → symlink 到 agent cwd → 把路径告诉 agent

## 两个场景

1. **任务创建时传文件** — full 模式表单 + quick 模式拖拽
2. **聊天窗口运行中传文件** — 📎 按钮 + 拖拽
3. **新建需求点时传文件**（R71，v69 polymorphic）— 新建表单附件区，两步法上传到需求点

## 数据模型

### v21 — task-only 形态（已废弃，老 attachment 用此 schema 落库）

```sql
CREATE TABLE attachments (
  id TEXT PRIMARY KEY,           -- uuid
  task_id TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  filename TEXT NOT NULL,        -- 原始文件名
  media_type TEXT NOT NULL,      -- image/png, application/pdf, etc.
  size_bytes INTEGER NOT NULL,
  storage_path TEXT NOT NULL,    -- 相对于 ORCHESTRATOR_HOME 的路径
  source TEXT NOT NULL DEFAULT 'upload',  -- upload | paste | reference
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE
);
CREATE INDEX idx_attachments_task ON attachments(task_id);
CREATE INDEX idx_attachments_owner ON attachments(owner_id);
```

### v69 — Polymorphic 形态（飞书 R71，飞书 R71 后所有新 attachment 走此 schema）

```sql
CREATE TABLE attachments (
  id TEXT PRIMARY KEY,
  task_id TEXT REFERENCES tasks(id) ON DELETE CASCADE,         -- 二选一: task attachment
  owner_id TEXT NOT NULL,
  filename TEXT NOT NULL,
  media_type TEXT NOT NULL,
  size_bytes INTEGER NOT NULL,
  storage_path TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'upload',
  metadata TEXT,                                               -- R121 agent_generated 元数据
  requirement_id TEXT REFERENCES requirements(id) ON DELETE CASCADE,  -- 二选一: requirement attachment
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  CHECK ((task_id IS NOT NULL) <> (requirement_id IS NOT NULL))   -- XOR 兜底
);
CREATE INDEX idx_attachments_task ON attachments(task_id);
CREATE INDEX idx_attachments_owner ON attachments(owner_id);
CREATE INDEX idx_attachments_requirement ON attachments(requirement_id);
```

迁移走 table rebuild（SQLite 不支持 `ALTER COLUMN DROP NOT NULL`），`PRAGMA foreign_keys=OFF`
中间态，详见 `src/lib/db/index.ts` v69 段。

DB 操作模块：`src/lib/db/attachments.ts`（参考 `checkpoints.ts` 极简风格）

## 存储路径

```
task attachment:        $ORCHESTRATOR_HOME/uploads/{owner_id}/{task_id}/{uuid}.{ext}
requirement attachment: $ORCHESTRATOR_HOME/uploads/{owner_id}/requirements/{requirement_id}/{uuid}.{ext}
```

- `uuid` 是附件记录 id
- `ext` 从原始文件名提取
- 目录不存在时 `mkdirSync({ recursive: true })`
- **symlink**：task attachment 在 agent cwd 下创建 `{cwd}/attachments/{filename}` → 指向实际存储路径（同名加后缀 `_1`）；requirement attachment **不建 symlink**（需求点没 agent cwd）。

> ⚠️ **task storage 路径故意没用 `tasks/` 子目录** —— 历史扁平路径，迁移前已有 DB 行的
> `storage_path` 字段引用着，改了等于所有老 attachment 全孤儿。requirement 用
> `requirements/` 子目录避免与 task 撞 hash。

## API 端点

### 上传：`POST /api/tasks/[id]/attachments`

- 接受 `multipart/form-data`（`request.formData()`）
- 校验 owner_id（通过 task 的 owner_id）
- 文件大小上限 10MB
- 类型白名单：`image/*` + `application/pdf` + `application/zip` + `application/x-tar*` + `application/gzip` + `text/*` + `application/json` + Office 全家（xlsx/docx/pptx 及旧版 xls/doc/ppt）+ OpenDocument（odt/ods/odp）+ rtf
  - 实现：`src/lib/db/attachments.ts` 的 `ATTACHMENT_ALLOWED_TYPES` + `isAllowedAttachmentMediaType()`。加新格式要改这两处。
- 类型判定顺序：客户端给的 `file.type` 优先，但 **`application/octet-stream` 视同"没说"** → 落回扩展名表 `ATTACHMENT_EXT_MIME`（含 `md` / `jsonl` / `json` / `txt` / `csv` / `log` / 常见源码后缀 + `xlsx` / `docx` / `pptx` / `xls` / `doc` / `ppt` / `odt` / `ods` / `odp` / `rtf`）。
  ⚠️ 这条兜底是必需的：`curl -F "file=@x.md"` 默认就发 `application/octet-stream`，若直接采信，合法的 `.md` 会被挡成 415（`ao-session.sh import` 踩过）。用 `-F "file=@x.md;type=text/markdown"` 显式给类型最稳。
- 存文件 + 创建 DB 记录 + symlink 到 cwd
- 返回 `{ id, filename, media_type, size_bytes }`

### 上传：`POST /api/requirements/[id]/attachments`（v69 R71 新增）

- 与 task 端点同口径：multipart / 10MB / 同白名单 / 同类型判定
- 区别：**不建 symlink**，不 emit SSE（没 chat timeline）
- 端点位置：`src/app/api/requirements/[id]/attachments/route.ts`
- 通用 `saveAttachmentFromFile(parent, ...)` 内部按 `parent.kind` 分流到不同存储目录 + 是否建 symlink

### 下载/查看：`GET /api/attachments/[id]`

- 校验 owner_id（polymorphic —— 不区分 task / requirement）
- 返回文件流（Content-Type + Content-Disposition: inline 对图片, attachment 对其他）
- 图片 `Cache-Control: private, max-age=3600`

### 删除：`DELETE /api/attachments/[id]`

- 校验 owner_id
- 删文件 + symlink（仅 task attachment）+ DB 记录
- polymorphic —— 端点不看 task 还是 requirement

### 列表：`GET /api/tasks/[id]/attachments`

- 校验 owner_id
- 返回该任务的附件列表

### 列表：`GET /api/requirements/[id]/attachments`（v69 R71 新增）

- 与 task 端点同口径：owner 校验 / 返回 `{attachments: [...]}`
- 端点位置：`src/app/api/requirements/[id]/attachments/route.ts`

## Polymorphic 适配清单

把 `saveAttachmentFromFile` 改成接收 `AttachmentParent` 联合类型后，**所有调用方**都要同步改：

| 调用方 | 文件 | parent.kind |
|--------|------|-------------|
| 用户上传 task | `src/app/api/tasks/[id]/attachments/route.ts` | `task` |
| Fork task 带附件 | `src/app/api/tasks/[id]/fork/route.ts` | `task` |
| Fork checkpoint 带附件 | `src/app/api/tasks/[id]/fork-at-checkpoint/route.ts` | `task` |
| 用户上传 requirement | `src/app/api/requirements/[id]/attachments/route.ts` | `requirement` |

agent 端 `registerAttachmentFromPath`（`/api/tasks/[id]/agent-attachments`）只支持 task，
不做 polymorphic —— 当前没有 agent 给 requirement 注册附件的需求。

`createAttachment` 应用层显式校验 task_id / requirement_id 二选一（DB CHECK XOR 兜底），
抛错文案 `exactly one of task_id / requirement_id must be set`。

## 消息 API 扩展

`POST /api/tasks/[id]/message` 扩展：

```typescript
// 现有
{ message: string }

// 扩展后
{ message: string, attachments?: string[] }  // attachment ids
```

当有 attachments 时，查询附件信息，拼入消息文本：

```
用户上传了以下文件：
- /absolute/path/to/cwd/attachments/screenshot.png (2.1 MB, image/png)
- /absolute/path/to/cwd/attachments/data.zip (30 MB, application/zip)

用户说：帮我看看截图里的错误
```

**关键**：路径用绝对路径，agent 用 Read 可以直接访问。runtime 层 `pushMessage()` 不改签名，仍然是 string。

## SSE 事件扩展

新增事件类型 `attachment`：

```typescript
{ type: "attachment", task_id, attachment: { id, filename, media_type, size_bytes } }
```

requirement 上传**不**emit SSE —— 没 chat timeline 消费者。

## UI 改造

### 聊天窗口（task-detail-client.tsx）

- 消息输入框旁加 📎 按钮
- 点击触发 `<input type="file" multiple />`
- 上传后显示文件标签（缩略图/文件名 + 大小）
- 发送时带上 attachment ids
- 消息历史渲染附件：图片缩略图（点击放大），其他文件名下载链接

### 任务创建表单（tasks/new/page.tsx）

- full 模式加附件上传区
- 创建后自动上传（两步法：先创建任务 → 上传附件）
- quick 模式支持拖拽

### 需求点新建表单（requirements/new/page.tsx，v69 R71 新增）

- 「附件」拖拽区：点击 / 拖拽 / 多选
- 提交走两步法（POST /api/requirements → 逐文件 POST /api/requirements/[id]/attachments）
- 单文件失败不阻断创建（warn 跳过，需求点建了但没附件 — 后续可在详情页补）

### 需求点详情页（requirements/[id]/page.tsx，v69 R71 新增）

- 「附件 (n)」卡片列出文件名（点跳 `/api/attachments/[id]` 下载）+ 大小 + 媒体类型 + 删除按钮
- 删按钮调 `DELETE /api/attachments/[id]`，`router.refresh()` 拉最新列表

## 多租户隔离

| 维度 | 处理 |
|------|------|
| 存储隔离 | `uploads/{owner_id}/` 目录级隔离 |
| 访问控制 | `GET /api/attachments/[id]` 校验 owner_id，非属主 404 |
| Agent 访问 | task attachment symlink 到 agent cwd，agent 通过 Read/Bash 直接访问；requirement attachment 不建 symlink（详情页 / 下载走 API） |
| 清理 | task 删除 CASCADE 删 attachments 记录 + symlink；requirement 软删（status='closed'）不级联物理删附件（FK 是 CASCADE 但应用层软删） |

## Docker/Runner 预留

存储路径用 `ORCHESTRATOR_HOME` 为根，后续 Docker 化时：

- `ORCHESTRATOR_HOME` 映射为 volume
- symlink 在容器内指向同 volume 内的路径
- Runner 抽象层：`ActiveSession.getCwd()` 是 runner 的 workspace root，文件 symlink 到 cwd 下自然兼容容器场景

## 不做的事

- 不改 `SDKUserMessage` 的 content 类型（仍然是 string）
- 不改 `createMessageGenerator()` / `pushMessage()` 的签名
- 不引入 S3/OSS
- 不做 base64 内联（小图优化留后续）
- 不做粘贴图片（剪贴板 paste 事件，P3 优先级）
- 不给 requirement attachment 建 cwd symlink（需求点没 agent cwd）
