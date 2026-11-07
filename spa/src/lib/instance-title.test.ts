import { describe, it, expect } from 'vitest';
import { instanceEnvTag, pageTitle } from './instance-title';

// R193: 页面 title 按访问入口区分实例; 2026-10-25 拍板格式 提调（env）;
// 2026-11-07 i18n 接入: title 跟随语言 (zh 全角括号 / en 半角括号), tag 本身 ASCII 双语共用。
describe('instanceEnvTag', () => {
  it('dev 入口 (13001 直连 / dev 域名) → dev', () => {
    expect(instanceEnvTag('localhost', '13001')).toBe('dev');
    expect(instanceEnvTag('192.0.2.50', '13001')).toBe('dev');
    expect(instanceEnvTag('dev.example.com', '')).toBe('dev');
  });

  it('公网域名 → 对应环境', () => {
    expect(instanceEnvTag('mac.example.com', '')).toBe('mac');
    expect(instanceEnvTag('air.example.com', '')).toBe('air');
    expect(instanceEnvTag('dao.example.com', '')).toBe('wsl');
    expect(instanceEnvTag('192.0.2.50', '13000')).toBe('wsl');
    expect(instanceEnvTag('ao.example.com', '')).toBe('pulu');
  });

  it('未识别入口 (localhost:13000 等) → null', () => {
    expect(instanceEnvTag('localhost', '13000')).toBeNull();
    expect(instanceEnvTag('unknown.example.com', '')).toBeNull();
  });
});

describe('pageTitle', () => {
  it('zh-CN: 带环境 tag → 提调（tag）全角括号', () => {
    expect(pageTitle('zh-CN', 'localhost', '13001')).toBe('提调（dev）');
    expect(pageTitle('zh-CN', 'mac.example.com', '')).toBe('提调（mac）');
    expect(pageTitle('zh-CN', 'ao.example.com', '')).toBe('提调（pulu）');
  });

  it('zh-CN: 无 tag → 默认 提调（Tidiao）', () => {
    expect(pageTitle('zh-CN', 'localhost', '13000')).toBe('提调（Tidiao）');
    expect(pageTitle('zh-CN', 'unknown.example.com', '')).toBe('提调（Tidiao）');
  });

  it('en-US: 带环境 tag → Tidiao (tag) 半角括号', () => {
    expect(pageTitle('en-US', 'localhost', '13001')).toBe('Tidiao (dev)');
    expect(pageTitle('en-US', 'mac.example.com', '')).toBe('Tidiao (mac)');
    expect(pageTitle('en-US', 'dao.example.com', '')).toBe('Tidiao (wsl)');
  });

  it('en-US: 无 tag → Tidiao', () => {
    expect(pageTitle('en-US', 'localhost', '13000')).toBe('Tidiao');
    expect(pageTitle('en-US', 'unknown.example.com', '')).toBe('Tidiao');
  });
});
