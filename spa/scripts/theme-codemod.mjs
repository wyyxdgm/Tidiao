#!/usr/bin/env node
/* 功能: R206 主题支持 codemod — 把 spa/src 内硬编码 hex 颜色批量替换为 CSS 变量,
 *       让 [data-theme='dark'] 覆盖生效。浅色模式变量值 = 原 hex, 视觉零回归.
 * 用法: node spa/scripts/theme-codemod.mjs --report   # 只报告, 不改文件
 *       node spa/scripts/theme-codemod.mjs --apply    # 应用替换
 * 关注点: ① <style> 段按 CSS 属性感知映射(#fff 的 background→bg-elevated, color 保持字面);
 *         ② script/template 段只替换「整值带引号」的 hex(状态色 map), 包成 'var(--tw-*)';
 *         ③ SVG presentation 属性(stroke="#...")不支持 var(), 由 --apply 显式跳过并报告,
 *            该 2 处 (IconSvg.vue) 手工处理;
 *         ④ 注释里的 #227 (RFC 编号) 等非颜色引用天然不匹配「带引号/声明值」模式.
 */

import { readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', 'src');
const MODE = process.argv.includes('--apply') ? 'apply' : 'report';

/* ---- Tailwind v3 默认色板 (仅列出本项目实际用到的 hue) ---- */
const TW = {
  slate: { 50: '#f8fafc', 100: '#f1f5f9', 200: '#e2e8f0', 300: '#cbd5e1', 400: '#94a3b8', 500: '#64748b', 600: '#475569', 700: '#334155', 800: '#1e293b', 900: '#0f172a', 950: '#020617' },
  gray: { 50: '#f9fafb', 100: '#f3f4f6', 200: '#e5e7eb', 300: '#d1d5db', 400: '#9ca3af', 500: '#6b7280', 600: '#4b5563', 700: '#374151', 800: '#1f2937', 900: '#111827', 950: '#030712' },
  red: { 50: '#fef2f2', 100: '#fee2e2', 200: '#fecaca', 300: '#fca5a5', 400: '#f87171', 500: '#ef4444', 600: '#dc2626', 700: '#b91c1c', 800: '#991b1b', 900: '#7f1d1d', 950: '#450a0a' },
  orange: { 50: '#fff7ed', 100: '#ffedd5', 200: '#fed7aa', 300: '#fdba74', 400: '#fb923c', 500: '#f97316', 600: '#ea580c', 700: '#c2410c', 800: '#9a3412', 900: '#7c2d12', 950: '#431407' },
  amber: { 50: '#fffbeb', 100: '#fef3c7', 200: '#fde68a', 300: '#fcd34d', 400: '#fbbf24', 500: '#f59e0b', 600: '#d97706', 700: '#b45309', 800: '#92400e', 900: '#78350f', 950: '#451a03' },
  yellow: { 50: '#fefce8', 100: '#fef9c3', 200: '#fef08a', 300: '#fde047', 400: '#facc15', 500: '#eab308', 600: '#ca8a04', 700: '#a16207', 800: '#854d0e', 900: '#713f12', 950: '#422006' },
  green: { 50: '#f0fdf4', 100: '#dcfce7', 200: '#bbf7d0', 300: '#86efac', 400: '#4ade80', 500: '#22c55e', 600: '#16a34a', 700: '#15803d', 800: '#166534', 900: '#14532d', 950: '#052e16' },
  emerald: { 50: '#ecfdf5', 100: '#d1fae5', 200: '#a7f3d0', 300: '#6ee7b7', 400: '#34d399', 500: '#10b981', 600: '#059669', 700: '#047857', 800: '#065f46', 900: '#064e3b', 950: '#022c22' },
  cyan: { 50: '#ecfeff', 100: '#cffafe', 200: '#a5f3fc', 300: '#67e8f9', 400: '#22d3ee', 500: '#06b6d4', 600: '#0891b2', 700: '#0e7490', 800: '#155e75', 900: '#164e63', 950: '#083344' },
  sky: { 50: '#f0f9ff', 100: '#e0f2fe', 200: '#bae6fd', 300: '#7dd3fc', 400: '#38bdf8', 500: '#0ea5e9', 600: '#0284c7', 700: '#0369a1', 800: '#075985', 900: '#0c4a6e', 950: '#082f49' },
  blue: { 50: '#eff6ff', 100: '#dbeafe', 200: '#bfdbfe', 300: '#93c5fd', 400: '#60a5fa', 500: '#3b82f6', 600: '#2563eb', 700: '#1d4ed8', 800: '#1e40af', 900: '#1e3a8a', 950: '#172554' },
  indigo: { 50: '#eef2ff', 100: '#e0e7ff', 200: '#c7d2fe', 300: '#a5b4fc', 400: '#818cf8', 500: '#6366f1', 600: '#4f46e5', 700: '#4338ca', 800: '#3730a3', 900: '#312e81', 950: '#1e1b4b' },
  violet: { 50: '#f5f3ff', 100: '#ede9fe', 200: '#ddd6fe', 300: '#c4b5fd', 400: '#a78bfa', 500: '#8b5cf6', 600: '#7c3aed', 700: '#6d28d9', 800: '#5b21b6', 900: '#4c1d95', 950: '#2e1065' },
  purple: { 50: '#faf5ff', 100: '#f3e8ff', 200: '#e9d5ff', 300: '#d8b4fe', 400: '#c084fc', 500: '#a855f7', 600: '#9333ea', 700: '#7e22ce', 800: '#6b21a8', 900: '#581c87', 950: '#3b0764' },
  pink: { 50: '#fdf2f8', 100: '#fce7f3', 200: '#fbcfe8', 300: '#f9a8d4', 400: '#f472b6', 500: '#ec4899', 600: '#db2777', 700: '#be185d', 800: '#9d174d', 900: '#831843', 950: '#500724' },
};
/* 非 Tailwind 标准值 → 语义命名 custom token (light 保持原值) */
const CUSTOM = {
  '#f5f7fa': { var: '--t-grad-a', dark: '#1f2937' },
  '#e4e8ef': { var: '--t-grad-b', dark: '#111827' },
  '#f5faff': { var: '--t-grad-c', dark: '#172554' },
  '#fafafa': { var: '--t-zinc-50', dark: '#111827' },
  '#a7f3d3': { var: '--tw-emerald-200', dark: null }, // emerald-200 笔误色, 归并
  /* UsageTab 8 色 categorical palette (dataviz) — 暗色给亮化变体保对比 */
  '#2a78d6': { var: '--t-series-1', dark: '#6ea8ff' },
  '#eb6834': { var: '--t-series-2', dark: '#ff9a62' },
  '#1baf7a': { var: '--t-series-3', dark: '#4ed4a2' },
  '#eda100': { var: '--t-series-4', dark: '#ffc94d' },
  '#e87ba4': { var: '--t-series-5', dark: '#ffa8c9' },
  '#008300': { var: '--t-series-6', dark: '#5ec45e' },
  '#4a3aa7': { var: '--t-series-7', dark: '#9d8fff' },
  '#e34948': { var: '--t-series-8', dark: '#ff8080' },
};

const HEX_RE = /#([0-9a-fA-F]{6}|[0-9a-fA-F]{3})\b/g;

function norm(hex) {
  const h = hex.toLowerCase();
  if (h.length === 4) return '#' + h[1] + h[1] + h[2] + h[2] + h[3] + h[3];
  return h;
}
/** hex → { hue, level } | null (custom 单独查) */
function resolve(hex) {
  for (const [hue, levels] of Object.entries(TW)) {
    for (const [lv, val] of Object.entries(levels)) {
      if (val === hex) return { hue, level: Number(lv) };
    }
  }
  return null;
}
/** 暗色镜像规则: L → 1000−L, 400/500 保持; gray 手调 (见下方 DARK_GRAY) */
const GRAY_DARK = { 50: '#111827', 100: '#1f2937', 200: '#374151', 300: '#4b5563', 400: '#9ca3af', 500: '#9ca3af', 600: '#d1d5db', 700: '#e5e7eb', 800: '#f3f4f6', 900: '#f9fafb', 950: '#f9fafb' };
function darkFor(hue, level) {
  if (hue === 'gray') return GRAY_DARK[level] ?? TW.gray[level];
  if (level === 400 || level === 500) return TW[hue][level];
  const mirror = 1000 - level;
  return TW[hue][mirror] ?? TW[hue][level];
}

/* ---- --gen-vars: 生成 CSS 变量表 (light :root + [data-theme=dark]) ----
 * 扫描 spa/src 里实际引用的 --tw-* / --t-* 变量, 按 TW/CUSTOM 表反推 light 值,
 * 按 darkFor/CUSTOM.dark 推 dark 值, 输出自包含 CSS. 浅色值 == codemod 前的原始
 * hex, 保证 light 视觉零回归. 用法: node spa/scripts/theme-codemod.mjs --gen-vars
 */
function generateVars() {
  const SRC = join(ROOT);
  const used = new Set();
  for (const file of walk(SRC)) {
    const src = readFileSync(file, 'utf8');
    for (const m of src.matchAll(/var\((--(?:tw|t)-[a-z0-9-]+)/g)) used.add(m[1]);
  }
  // hex → CUSTOM 反查 (light 值 = CUSTOM 的 key)
  const customByVar = {};
  for (const [hex, def] of Object.entries(CUSTOM)) customByVar[def.var] = { light: hex, dark: def.dark };

  const light = [];
  const dark = [];
  for (const name of [...used].sort()) {
    let lv, dv;
    if (name.startsWith('--t-')) {
      const c = customByVar[name];
      if (!c) { console.error(`⚠️  ${name} 未在 CUSTOM 表找到`); continue; }
      lv = c.light;
      dv = c.dark ?? c.light;
    } else {
      const m = name.match(/^--tw-([a-z]+)-(\d+)(-solid)?$/);
      if (!m) { console.error(`⚠️  ${name} 无法解析`); continue; }
      const [, hue, lvlRaw, solid] = m;
      const level = Number(lvlRaw);
      const val = TW[hue]?.[level];
      if (!val) { console.error(`⚠️  ${name}: TW.${hue}[${level}] 不存在`); continue; }
      lv = val;
      dv = solid ? val : darkFor(hue, level); // -solid: 实心按钮/徽章, 暗色保持原值
    }
    light.push(`  ${name}: ${lv};`);
    dark.push(`  ${name}: ${dv};`);
  }

  const header =
    '/* 功能: R206 主题变量表 — 由 spa/scripts/theme-codemod.mjs --gen-vars 生成, 勿手改.\n' +
    ' * 浅色值 == codemod 前的原始 hex (light 零回归); 深色值按 Tailwind 色板镜像规则\n' +
    ' * (L → 1000−L, 400/500 保持; gray 单独映射) 生成. 重新生成:\n' +
    ' *   node spa/scripts/theme-codemod.mjs --gen-vars > spa/src/assets/theme-vars.css\n' +
    ' */\n';
  const out =
    header +
    `\n:root {\n${light.join('\n')}\n}\n\n` +
    `/* 深色主题: html[data-theme='dark'] 时覆盖全部变量. theme store 会把 'system'\n` +
    `   解析成具体 light/dark 再写该属性. */\n` +
    `:root[data-theme='dark'] {\n${dark.join('\n')}\n}\n`;
  process.stdout.write(out);
  console.error(`生成 ${light.length} 个变量 (light + dark)`);
}

if (process.argv.includes('--gen-vars')) {
  generateVars();
  process.exit(0);
}

/* ---- 收集文件 ---- */
function walk(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else if (p.endsWith('.vue')) out.push(p);
  }
  return out;
}

const stats = { files: 0, cssRepl: 0, jsRepl: 0, svgAttrSkip: [], unmatched: new Map() };

for (const file of walk(ROOT)) {
  const src = readFileSync(file, 'utf8');
  let out = '';
  let last = 0;
  const styleRe = /<style[^>]*>([\s\S]*?)<\/style>/g;
  let m;
  while ((m = styleRe.exec(src)) !== null) {
    out += transformNonCss(src.slice(last, m.index), file);
    out += transformCss(m[0], file);
    last = m.index + m[0].length;
  }
  out += transformNonCss(src.slice(last), file);
  if (out !== src) {
    stats.files++;
    if (MODE === 'apply') writeFileSync(file, out);
  }
}

function recordUnmatched(hex, file) {
  const n = stats.unmatched.get(hex) ?? [];
  if (n.length < 2 && !n.includes(file)) n.push(file);
  stats.unmatched.set(hex, n);
}

/* ---- <style> 段: 按属性感知替换 ---- */
function transformCss(seg, file) {
  // 先保护 var(--x, #fallback) — fallback 永不渲染, 不动它 (避免无意义 churn)
  const stash = [];
  seg = seg.replace(/var\(--[a-z0-9-]+,\s*#[0-9a-fA-F]{3,8}\s*\)/gi, (v) => {
    stash.push(v);
    return ` VARSTASH${stash.length - 1}ENDSTASH `;
  });
  // 逐条声明处理: prop: value
  let result = seg.replace(/([a-z-]+)\s*:\s*([^;{}]*?)(;|(?=\s*[}]))/gi, (full, prop, value, tail) => {
    if (!value.includes('#')) return full;
    const newVal = value.replace(HEX_RE, (whole) => {
      const hex = norm(whole);
      if (hex === '#ffffff' || hex === '#fff') {
        if (/^background/.test(prop)) return 'var(--color-bg-elevated)'; // 白底 → 面板底
        return whole; // 彩底上的文字 / 白边框: 两主题都白
      }
      if (CUSTOM[hex]) return `var(${CUSTOM[hex].var})`;
      const r = resolve(hex);
      if (!r) { recordUnmatched(hex, file); return whole; }
      const { hue, level } = r;
      // 非灰中高饱和纯色作背景 (按钮/实心 chip) → -solid 变量, 暗色保持原值
      const solid = hue !== 'gray' && /^background/.test(prop) && level >= 500 && level <= 700;
      return `var(--tw-${hue}-${level}${solid ? '-solid' : ''})`;
    });
    if (newVal !== value) stats.cssRepl++;
    return `${prop}: ${newVal}${tail}`;
  });
  return result.replace(/ VARSTASH(\d+)ENDSTASH /g, (_, i) => stash[Number(i)]);
}

/* ---- 非样式段: 只替换整值带引号 hex (状态色 map / 内联 style 绑定) ---- */
function transformNonCss(seg, file) {
  // SVG presentation 属性 stroke="#hex" fill="#hex" — var() 在属性里不生效, 跳过并报告.
  // skip 时 stash 占位, 防止下方 JS 引号规则把 skip 过的属性二次替换成 var().
  const stash2 = [];
  const out = seg.replace(/\b(fill|stroke|stop-color|color)\s*=\s*("|')#([0-9a-fA-F]{3,8})\2/g, (whole) => {
    stats.svgAttrSkip.push(`${file}: ${whole.trim()}`);
    stash2.push(whole);
    return ` SVGATTR${stash2.length - 1}ATTREND `;
  });
  // JS/模板: '...': '#hex' 或 "#hex" 整字符串值 → 'var(--tw-*)'
  let restored = out.replace(/(['"])(#(?:[0-9a-fA-F]{6}|[0-9a-fA-F]{3}))\1/g, (whole, q, raw) => {
    const hex = norm(raw);
    if (CUSTOM[hex]) return `${q}var(${CUSTOM[hex].var})${q}`;
    const r = resolve(hex);
    if (!r) { recordUnmatched(hex, file); return whole; }
    stats.jsRepl++;
    return `${q}var(--tw-${r.hue}-${r.level})${q}`;
  });
  return restored.replace(/ SVGATTR(\d+)ATTREND /g, (_, i) => stash2[Number(i)]);
}

/* ---- 报告 ---- */
console.log(`mode=${MODE}  files_changed=${stats.files}  css_repl=${stats.cssRepl}  js_repl=${stats.jsRepl}`);
if (stats.svgAttrSkip.length) {
  console.log('\nSVG 属性跳过 (var() 不生效, 需手工):');
  for (const s of stats.svgAttrSkip) console.log('  ' + s);
}
if (stats.unmatched.size) {
  console.log('\n未匹配 hex (不在 Tailwind 表, 需补 CUSTOM):');
  for (const [hex, files] of stats.unmatched) console.log(`  ${hex}  ← ${files.join(', ')}`);
}

/* 命名色审计: hex 之外的 white/black/rgba(255,255,255) 是 codemod 盲区 (hex 正则抓不到).
 * 背景类命名色在暗色下会留一块白/黑, 必须显式处理或标 theme-ok 豁免.
 * 注: rgba(0,0,0,*) 背景多为遮罩 (两主题通用), 不报; 只报白系. */
{
  const NAMED_BG = /^\s*background(-color)?\s*:\s*(white|black|rgba\(\s*255\s*,\s*255\s*,\s*255\s*,)/;
  const hits = [];
  for (const file of walk(join(ROOT))) {
    const lines = readFileSync(file, 'utf8').split('\n');
    lines.forEach((l, i) => {
      if (!NAMED_BG.test(l)) return;
      const prev = (lines[i - 1] || '');
      if (/theme-ok/.test(prev)) return;
      hits.push(`${file}:${i + 1}  ${l.trim()}`);
    });
  }
  if (hits.length) {
    console.log('\n命名背景色 (white/black/rgba(255,255,255)) 未处理 — 改 var(--color-bg-elevated) 或加 /* theme-ok */ 注释:');
    for (const h of hits) console.log('  ' + h);
  } else {
    console.log('\n命名背景色审计: ✅ 无遗漏');
  }
}
