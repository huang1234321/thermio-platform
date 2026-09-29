/**
 * severity token AA 护栏（ui/baseline §4.6 / §2.1，DAT-157 修单簇 3）：
 * 解析 tokens.css 双主题的 --ti-sev-* 值，对各自主题卡片底（--ti-bg-card）计算
 * WCAG 对比度，正文色须 ≥4.5:1。改 token 值必须连带核对本测试。
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';

const cssPath = join(dirname(fileURLToPath(import.meta.url)), 'tokens.css');
const css = readFileSync(cssPath, 'utf8');

function themeBlock(theme: 'light' | 'dark'): Map<string, string> {
  const selector = theme === 'light' ? ':root,' : ":root[data-theme='dark']";
  const start = css.indexOf(selector);
  if (start < 0) throw new Error(`selector not found: ${selector}`);
  const open = css.indexOf('{', start);
  const close = css.indexOf('}', open);
  const body = css.slice(open + 1, close);
  const map = new Map<string, string>();
  for (const line of body.split(';')) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('--')) continue;
    const idx = trimmed.indexOf(':');
    map.set(trimmed.slice(0, idx).trim(), trimmed.slice(idx + 1).trim());
  }
  return map;
}

function channel(value: number): number {
  const v = value / 255;
  return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
}

function luminance(hex: string): number {
  const v = hex.replace('#', '');
  const r = Number.parseInt(v.slice(0, 2), 16);
  const g = Number.parseInt(v.slice(2, 4), 16);
  const b = Number.parseInt(v.slice(4, 6), 16);
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

function contrast(fg: string, bg: string): number {
  const l1 = luminance(fg);
  const l2 = luminance(bg);
  const hi = Math.max(l1, l2);
  const lo = Math.min(l1, l2);
  return (hi + 0.05) / (lo + 0.05);
}

const SEVERITY_TOKENS = [
  '--ti-sev-critical',
  '--ti-sev-major',
  '--ti-sev-minor',
  '--ti-sev-warning',
  '--ti-sev-info',
] as const;

function required(map: Map<string, string>, token: string): string {
  const value = map.get(token);
  if (value === undefined) throw new Error(`token not found in tokens.css: ${token}`);
  return value;
}

describe('severity token 双主题 AA（正文 4.5:1 on 卡片底）', () => {
  it.each(SEVERITY_TOKENS)('light: %s on --ti-bg-card ≥ 4.5', (token) => {
    const light = themeBlock('light');
    expect(
      contrast(required(light, token), required(light, '--ti-bg-card')),
    ).toBeGreaterThanOrEqual(4.5);
  });

  it.each(SEVERITY_TOKENS)('dark: %s on --ti-bg-card ≥ 4.5', (token) => {
    const dark = themeBlock('dark');
    expect(contrast(required(dark, token), required(dark, '--ti-bg-card'))).toBeGreaterThanOrEqual(
      4.5,
    );
  });

  it('顶栏角标深色徽标字/底 ≥ 4.5（§4.6，DAT-169 colorTextLightSolid 口径）', () => {
    const dark = themeBlock('dark');
    // theme.tsx dark colorTextLightSolid #08252B on colorError = --ti-sev-critical
    expect(contrast('#08252b', required(dark, '--ti-sev-critical'))).toBeGreaterThanOrEqual(4.5);
  });
});
