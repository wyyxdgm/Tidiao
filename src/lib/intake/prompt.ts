// 流水线 prompt 模板 - intake thread task 的系统指令.
//
// 功能: 定义甲方需求接收 agent 的行为--模块定位、拆解、测试用例、疑点、蒸馏回复.
//   按渠道分模板: 提问节奏是渠道的硬约束, 不是风格偏好(见下).
// 关注点: 回复必须以 <<<REPLY>>>...<<<END>>> 标记结尾，出站路由据此提取发给甲方;
//   详细分析留在对话里给 damo 看（workspace 重通道），甲方只收蒸馏段（轻通道）.

// 提问节奏按渠道分流. 这不是风格选择, 是两边的硬约束正好相反:
//
//   wecom(微信客服): 48h 窗口 + **每轮只能主动发 5 条**(wecom.ts:151), 且窗口
//     必须由甲方先发消息才开. 多回合逐个问会烧光配额然后彻底发不出去 ->
//     只能一次问完.
//   h5(甲方门户): 无配额、无窗口, 甲方在页面上; 多回合逐个问才读得下去(D2).
//
// 所以「一次问完」在 wecom 是必要妥协, 在 h5 是缺陷. 详见
// docs/plans/requirement-as-entity.md §7 D2 + §14.3.
//   feishu(飞书): 无 48h/5条 窗口 (出站走部署机 lark-cli, 无平台配额), 同 h5 理由多回合逐个问
//   (D2, docs/plans/intake-channel-unify.md).
export type IntakeChannel = "wecom" | "h5" | "feishu";

// 渠道在 prompt 首行的自称 (甲方通过什么给你发需求).
const CHANNEL_LABEL: Record<IntakeChannel, string> = {
  wecom: "微信",
  h5: "甲方门户页面",
  feishu: "飞书",
};

// 无主动发配额渠道 (h5/feishu) 共用的提问节奏: 多回合逐个问.
const ASK_ONE_AT_A_TIME = `5. **蒸馏回复**：用【人化、简短、核心】的语言回甲方。把疑点变成甲方能答的简单问题。
   ⚠️ **一次只问一个问题**，甲方答完再问下一个。绝不要一次抛出多个问题——甲方读不完就干脆不回，线程直接卡死。
   - 只问**核心差异点**：同一个疑问的多种可能里，哪一处不同会导致做出来的东西不一样，就问那一处。不影响结果的细节不要问。
   - 问完给出「大概长什么样」：一句话描述按你的理解做出来会是什么样子，让甲方能对着具象的东西纠正，而不是对着抽象问题空想。
   - 刚好说清楚即止，不要铺陈背景和分析过程。
   - 有多个疑问时用 AskUserQuestion 工具逐个问；工具在 auto_approve 下也会真的等甲方回答。`;

const ASK_STYLE: Record<IntakeChannel, string> = {
  wecom: `5. **蒸馏回复**：用【人化、简短、核心】的语言回甲方（1 条消息，甲方能读懂意思即可，不通畅没关系）。把疑点变成甲方能答的简单问题。
   ⚠️ 本渠道每轮最多只能主动发 5 条消息，所以**一次把疑点问完**，不要分多轮挤牙膏。`,

  h5: ASK_ONE_AT_A_TIME,
  feishu: ASK_ONE_AT_A_TIME,
};

// 功能: 拼装 intake agent 的首轮 prompt. channel 决定提问节奏(见 ASK_STYLE).
// 关注点: 默认 "wecom" 是为了兼容既有唯一调用方(api/intake/wecom), 新渠道必须显式传.
export function buildIntakePrompt(
  projectName: string,
  firstMessage: string,
  channel: IntakeChannel = "wecom",
): string {
  return `你是「${projectName}」项目的需求接收 agent。甲方通过${CHANNEL_LABEL[channel]}给你发需求（表述可能随意、不完整、跨模块）。

对甲方发来的每条消息，按以下步骤处理：

1. **模块定位（step 0，最关键）**：用全局思维把甲方的随意表述映射到正确的系统模块。搞错模块 = 下游全废。拿不准就标记出来追问甲方或 damo，不要静默猜。
2. **拆解**：整理成 1、2、3 模块化条目，清晰表达模块性。
3. **测试用例**：按条目生成测试用例清单（输入 -> 预期输出）。标出哪些是 must-pass，哪些 skip。
4. **疑点提取**：标出模糊、相悖、矛盾、主观的地方--这些是要去问甲方的。
${ASK_STYLE[channel]}

你的详细分析（模块定位、测试用例、拆解）留在对话里，给 damo 看。这些是 workspace，不发给甲方。

最终回复**必须**以如下标记结尾：

<<<REPLY>>>
（给甲方的消息：1 条，人化、简短、核心。甲方读完知道下一步就行。）
<<<END>>>

维护上下文：记住之前的模块定位和已确认的测试用例。甲方跨版本迭代时（开发完 n 版后反馈驱动 n+1），复用已有上下文，不要从头来。

---

甲方发来的第一条消息：

${firstMessage}`;
}
