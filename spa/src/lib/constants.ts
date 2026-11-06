// 通用常量 — 与 master src/lib/constants.ts 对齐, 仅放 SPA 视图实际消费的
//   子集 (避免一次性拉全部常量, 后续 M3+ 再扩).
//
// 关注点:
//   - R16 详情页 CreateRequirementTaskButton 需要 EFFORT_LEVELS /
//     TOOL_PRESETS / AVAILABLE_TOOLS / TASK_TYPE_OPTIONS, 全部走本模块.
//   - 任务状态名/颜色不引 (R11 + R19 + R33 已各自 inline, 集中化留后续 task).

/** 推理强度 5 档 — 与 master EFFORT_LEVELS 对齐. */
export const EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
export type EffortLevel = (typeof EFFORT_LEVELS)[number];

/** Agent 可用工具全开集 — 与 master AVAILABLE_TOOLS 对齐. */
export const AVAILABLE_TOOLS: string[] = [
  'Read',
  'Write',
  'Edit',
  'Bash',
  'Glob',
  'Grep',
  'WebSearch',
  'WebFetch',
  'Agent',
  'NotebookEdit',
];

/** 工具快速 preset — 与 master TOOL_PRESETS 同款 4 档. */
export interface ToolPreset {
  key: string;
  label: string;
  tools: string[];
}
// i18n (W4.5b): label 为 locale key (taskNew.preset_* 已有键), 渲染层 t() —
//   TaskNew/SnapshotManager 早已按 key 自行 t(), CreateRequirementTaskButton W4.5b 跟进.
export const TOOL_PRESETS: ToolPreset[] = [
  { key: 'full', label: 'taskNew.preset_full', tools: [...AVAILABLE_TOOLS] },
  { key: 'plan', label: 'taskNew.preset_plan', tools: ['Read', 'Glob', 'Grep', 'Agent'] },
  {
    key: 'explore',
    label: 'taskNew.preset_explore',
    tools: ['Read', 'Glob', 'Grep', 'WebSearch', 'WebFetch', 'Agent'],
  },
  {
    key: 'local',
    label: 'taskNew.preset_local',
    tools: [
      'Read',
      'Write',
      'Edit',
      'Bash',
      'Glob',
      'Grep',
      'Agent',
      'NotebookEdit',
    ],
  },
];

/** 任务阶段 4 选 — 与 master create-task-button.tsx TASK_TYPE_OPTIONS 对齐.
    设计/调研不计入「可标完成」前置; 实现/测试/部署才计入. */
export type TaskType = 'design' | 'dev' | 'test' | 'deploy';
export interface TaskTypeOption {
  value: TaskType;
  label: string;
}
// i18n (W4.5b): label 为 locale key (taskNew.type_* 已有键), 渲染层 t().
export const TASK_TYPE_OPTIONS: TaskTypeOption[] = [
  { value: 'design', label: 'taskNew.type_design' },
  { value: 'dev', label: 'taskNew.type_dev' },
  { value: 'test', label: 'taskNew.type_test' },
  { value: 'deploy', label: 'taskNew.type_deploy' },
];
