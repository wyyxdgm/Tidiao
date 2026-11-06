# 7. 预设与复用

> 模板、角色、配置快照三种机制，让你把常用的 prompt、配置和参数存下来反复使用。

## 概述

创建任务时经常重复输入相似的 prompt、模型、推理强度等参数。平台提供三种预设机制减少重复操作：**模板**保存完整的 prompt + 配置、一键实例化为任务；**角色**保存 system_prompt + 默认执行参数、创建任务时选择；**配置快照**按 global/project/version 三级作用域自动应用执行配置。三者互补：模板面向"一句话建任务"，角色面向"行为人格定义"，配置快照面向"按位置自动套参数"。

### 功能点：模板（Template）

- **是什么**：保存一份完整的 prompt 和可选执行配置（model、effort、max_turns、auto_approve、tags），需要时一键预填到新建任务表单。
- **怎么用**：
  1. 进入 `/templates` 模板管理页面。
  2. 点击"新建模板"，填写模板名称（必填）、prompt（必填），以及可选配置：模型、推理强度、最大轮次、自动审批、标签。
  3. 保存后，模板以卡片形式展示在列表中。
  4. 点击卡片上的"从此模板创建任务"，跳转到 `/tasks/new` 页面，prompt 和配置已预填在表单中。你可以在表单上进一步修改后提交。
- **注意**：
  - 模板**不可编辑**（没有编辑接口），只能删除后重新创建。如需修改，删除旧模板再新建。
  - 实例化只是预填表单参数，不会自动提交任务。你仍需要选择项目、版本等必填项后手动提交。
  - 模板支持 `allowedTools` 字段（API 创建时可传），但 UI 表单未暴露该字段。
  - 所有数据按 owner 隔离，只能看到和操作自己创建的模板。

### 功能点：角色（Role）

- **是什么**：角色是一组可复用的"行为定义"--包含 system_prompt 和默认执行参数（model、tools、effort、max_turns、memory_doc），创建任务时可选择某个角色来继承这些配置。
- **怎么用**：
  - **创建角色**：通过 API `POST /api/roles` 创建，必填 `name` 和 `system_prompt`，可选 `description`、`model`、`allowed_tools`（字符串数组）、`effort`、`max_turns`、`memory_doc`。
  - **使用角色**：创建任务时传入 `role_id`，任务会继承角色的 system_prompt 和默认参数。这些参数可被任务创建时的显式传值覆盖。
  - **管理角色**：通过 API `GET /api/roles` 列表、`PATCH /api/roles/[id]` 修改、`DELETE /api/roles/[id]` 删除。
  - 角色字段说明：
    - `system_prompt`：角色的系统提示词，定义 agent 行为模式。
    - `model`：默认使用的模型。
    - `allowed_tools`：允许使用的工具列表。
    - `effort`：推理强度（low/medium/high 等）。
    - `max_turns`：最大对话轮次。
    - `memory_doc`：记忆文档路径或内容，供 agent 跨会话参考。
- **注意**：
  - 角色支持完整 CRUD（创建后可修改），与模板不同。
  - `allowed_tools` 以 JSON 数组存储，API 传入时为字符串数组格式。
  - 角色按 owner 隔离，任务创建时只能引用自己创建的角色。

### 功能点：配置快照（Config Snapshot）

- **是什么**：按作用域存储执行配置（model、effort、maxTurns、autoApprove、allowedTools、tags），创建任务时自动匹配最具体的快照并应用。
- **怎么用**：
  - **创建快照**：通过 API `POST /api/config-snapshots` 创建，必填 `name` 和 `scope`。可选配置字段：`model`、`effort`、`maxTurns`、`autoApprove`、`allowedTools`、`tags`、`type`。
  - **三级作用域**：
    - `global`：全局生效，不绑定项目。适用于所有项目。
    - `project`：绑定特定项目（`projectId` 必填），只在该项目下生效。
    - `version`：绑定特定版本（`projectId` + `versionId` 必填），只在该版本下生效。
  - **自动应用规则**：在 `/tasks/new` 页面创建任务时，系统根据当前所在的项目/版本，调用 `listApplicableSnapshots()` 查询匹配的快照。返回结果按**最具体优先**排序：version > project > global，同级别按更新时间倒序。最匹配的快照自动应用到任务配置中。
  - **查询快照**：
    - `GET /api/config-snapshots`（不带参数）：返回当前用户所有快照。
    - `GET /api/config-snapshots?project=<pid>&version=<vid>`：返回该位置适用的快照列表（global + project + version），按最具体优先排序。
  - **修改/删除**：`PUT /api/config-snapshots/[id]` 全量更新，`DELETE /api/config-snapshots/[id]` 删除。
- **注意**：
  - 作用域校验严格：global 快照不能绑定 project；project 快照必须绑定 projectId 且不能有 versionId；version 快照必须同时绑定 projectId 和 versionId。
  - project/version 快照绑定的项目必须是当前用户拥有的（不存在或不属于自己返回 404，不泄露项目存在性）。
  - 快照**不含 prompt**，只管执行配置。与模板（含 prompt）和角色（含 system_prompt）互补。
  - `autoApprove` 存储为 0/1（SQLite 整数），`allowedTools` 和 `tags` 以 JSON 数组存储。

### 功能点：三者区别与搭配

- **是什么**：模板、角色、配置快照各有侧重，可搭配使用。
- **怎么用**：根据场景选择：
  - **模板**：适合"整套 prompt + 配置一键复用"。比如"代码审查"模板，保存固定的审查 prompt + 模型 + 自动审批，每次新建审查任务一键带入。
  - **角色**：适合"定义 agent 人格和行为模式"。比如"测试工程师"角色，定义 system_prompt 让 agent 以测试视角工作，附带默认 model 和 tools。
  - **配置快照**：适合"按项目/版本自动套用执行参数"。比如给项目 A 绑定一个快照指定用高性能模型和高 effort，在该项目下建任务时自动应用，无需手动选。
- **注意**：三者不互斥。可以同时用角色（定义 prompt 行为）+ 配置快照（定义执行参数）+ 模板（快速入口）。任务创建时，显式传值 > 角色 > 配置快照（具体优先级见 [配置解析文档](../config-resolution.md)）。

## 常见问题

**Q: 模板能编辑吗？**
A: 不能。模板只支持创建（POST）和删除（DELETE），没有更新接口。需要修改时删除旧模板重新创建。角色和配置快照支持完整 CRUD。

**Q: 配置快照的"最具体优先"是什么意思？**
A: 如果同时存在 global、project、version 三个级别的快照，version 级别排在最前面，project 次之，global 最后。系统取列表第一条作为最佳匹配自动应用。同一级别内按更新时间倒序排列。

**Q: 创建 project/version 快照时提示 Project not found？**
A: 快照绑定的项目必须是当前用户拥有的。如果项目不存在或不属于你，API 返回 404（不泄露项目存在性）。确认 `projectId` 正确且项目属于当前登录用户。
