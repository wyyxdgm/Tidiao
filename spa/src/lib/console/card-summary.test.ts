import { describe, expect, it } from 'vitest';
import { clip, extractGain, stripRuntimeMarkers } from './card-summary';

/* 用例文本 = damo 2026-10-03 从 13001 画布「等我处理」卡片贴回的真实汇报
   (改动前的质量问题: checkpoint XML 原文 / 结构词裸露 / 机械截断截不到重点).
   历史: 曾有 extractWhy 测试组; R177 迭代9 (damo 1004)「为什么」整行撤,
   extractWhy 连同用例一并拆除 (语义由「有啥用」覆盖). */

describe('clip', () => {
  it('超长静默截断不加省略号 (damo 1007: 「…」= 总结不到位), 短文原样', () => {
    expect(clip('abc', 10)).toBe('abc');
    const long = 'a'.repeat(50);
    expect(clip(long, 10)).toBe('a'.repeat(10));
  });
  it('markdown 记号轻清', () => {
    expect(clip('## 标题\n**加粗** 正文', 40)).toBe('标题 加粗 正文');
  });
});

describe('stripRuntimeMarkers (damo 1007: 管线符号不进弹窗原文)', () => {
  it('剥 checkpoint/awaiting/git 标签 + 压掉连续空行, 保留换行结构', () => {
    const raw = [
      '<checkpoint step=1 summary="收到派发通知"/>',
      '第一段。',
      '',
      '',
      '<awaiting type="choice"/>',
      '<git commit-id="abc"/>',
      '第二段。',
    ].join('\n');
    expect(stripRuntimeMarkers(raw)).toBe('第一段。\n\n第二段。');
  });
});

describe('extractGain (R177 迭代6: 干了啥/有啥用, damo 1004 拍板)', () => {
  it('① 优先 value_significance (派发时登记的为什么做)', () => {
    expect(
      extractGain({ valueSignificance: '让 damo 一眼看清项目动态', description: '旧描述' }),
    ).toBe('让 damo 一眼看清项目动态');
  });

  it('② 次选 description', () => {
    expect(
      extractGain({ description: '画布卡片摘要一行直取', prompt: '你是 ao-dev 的开发 agent。任务目标: xx' }),
    ).toBe('画布卡片摘要一行直取');
  });

  it('③ prompt「任务目标:」行直取', () => {
    const prompt = '你是 ao-dev 的开发 agent。工作目录已是 /home/user/workspace/x。\n任务目标: 把卡片摘要改成干了啥+有啥用\n== 依据 ==\ndocs/x.md';
    expect(extractGain({ prompt })).toBe('把卡片摘要改成干了啥+有啥用');
  });

  it('③ 无目标标记时取第一条人话行 (跳身份/标记/命令行)', () => {
    const prompt = '你是 xx 的开发 agent。\n<system-reminder>xx</system-reminder>\n```bash\ngit pull\n```\n给需求点页加画布视图, 任务状态用动画表示。';
    expect(extractGain({ prompt })).toBe('给需求点页加画布视图, 任务状态用动画表示。');
  });

  it('③ 跳过 [role: default] 等 bracket 配置行 (13001 线上实测泄漏)', () => {
    const prompt = '你是 ao-dev 的开发 agent。工作目录已是 /x。\n[role: default]\n== damo 的指令 ==\n把现有定时任务都删掉，再触发2个一次性的定时任务。\n== 平台 API ==';
    expect(extractGain({ prompt })).toBe('把现有定时任务都删掉，再触发2个一次性的定时任务。');
  });

  it('③ 跳 checkpoint 约定套话, 标题呼应行优先于裸首行 (13001 线上实测泄漏)', () => {
    const prompt = '你是 ao-dev 的开发 agent。\n[role: default]\n≥2 步的任务，每完成一个里程碑必须输出：<checkpoint …/>\n辅助 deploy --wsl -p，推 ao-prod + ao-pulu。\n== 端点 ==';
    expect(
      extractGain({ prompt, title: '辅助 deploy --wsl -p (推 ao-prod + ao-pulu)' }),
    ).toBe('辅助 deploy --wsl -p，推 ao-prod + ao-pulu。');
  });

  it('跳「## 通用约定」节区行, 命令行作二级兜底 (13001 线上实测 R51 卡)', () => {
    // prompt 原文 = orchestrator-dev DB 里 R51 卡的真实 prompt
    const prompt =
      '[role: default]\n## 强制要求：Checkpoint 输出\n\n≥2 步的任务，每完成一个里程碑必须输出：\n\n<checkpoint step=N summary="一句话说明这一步做了什么"/>\n\nN 从 1 自增。最终步也要写。不写 = 面板空白。\n\n## 通用约定\n\n- 写操作前 git pull --ff-only\n- 完成后 git commit\n- 优先用中文回答\n\nbash ~/workspace/agent-orchestrator-dev/scripts/ao-platform-upgrade.sh --deploy-flags \'--wsl -p\' --notify-task-id 6c83e798';
    expect(extractGain({ prompt, title: 'R51 fix 升级 ao-prod + ao-pulu (commit dafa46b)' })).toBe(
      clip(
        "bash ~/workspace/agent-orchestrator-dev/scripts/ao-platform-upgrade.sh --deploy-flags '--wsl -p' --notify-task-id 6c83e798",
        80,
      ),
    );
  });

  it('通用约定节区行不压过短真指令 (13001 线上实测「更新布署13000」卡)', () => {
    const prompt =
      '[role: default]\n## 强制要求：Checkpoint 输出\n≥2 步的任务，每完成一个里程碑必须输出：<checkpoint step=N summary="…"/>\nN 从 1 自增。最终步也要写。不写 = 面板空白。\n## 通用约定\n- 写操作前 git pull --ff-only\n- 完成后 git commit\n- 优先用中文回答\n\n更新布署13000';
    expect(extractGain({ prompt, title: '调研三实例 HEAD + BUILD_ID + 健康' })).toBe('更新布署13000');
  });

  it('全空 → 空串 (卡片只少一行)', () => {
    expect(extractGain({})).toBe('');
    expect(extractGain({ prompt: '' })).toBe('');
  });
});
