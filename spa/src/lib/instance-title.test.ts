import { describe, it, expect } from 'vitest';
import { instanceTitle } from './instance-title';

// R193: 页面 title 按访问入口区分实例; 2026-10-25 拍板格式 提调（env）。
describe('instanceTitle', () => {
  it('dev 入口 (13001 直连 / dev 域名) → 提调（dev）', () => {
    expect(instanceTitle('localhost', '13001')).toBe('提调（dev）');
    expect(instanceTitle('192.0.2.50', '13001')).toBe('提调（dev）');
    expect(instanceTitle('dev.example.com', '')).toBe('提调（dev）');
  });

  it('公网域名 → 提调（对应环境）', () => {
    expect(instanceTitle('mac.example.com', '')).toBe('提调（mac）');
    expect(instanceTitle('air.example.com', '')).toBe('提调（air）');
    expect(instanceTitle('dao.example.com', '')).toBe('提调（wsl）');
    expect(instanceTitle('192.0.2.50', '13000')).toBe('提调（wsl）');
    expect(instanceTitle('ao.example.com', '')).toBe('提调（pulu）');
  });

  it('未识别入口 (localhost:13000 等) → 默认', () => {
    expect(instanceTitle('localhost', '13000')).toBe('提调（Tidiao）');
    expect(instanceTitle('unknown.example.com', '')).toBe('提调（Tidiao）');
  });
});
