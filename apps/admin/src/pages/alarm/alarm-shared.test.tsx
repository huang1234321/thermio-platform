/**
 * severity 标签用例（DAT-157 修单簇 3）：中文词表 + --ti-sev-* token 消费
 * （FE-02 禁硬编码，样式须引用 CSS 变量而非 antd 预设色名）。
 */
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { SeverityTag } from './alarm-shared.js';

afterEach(cleanup);

describe('SeverityTag', () => {
  it('rendersChineseLabels', () => {
    for (const [severity, label] of [
      ['critical', '紧急'],
      ['major', '严重'],
      ['minor', '较重'],
      ['warning', '警告'],
      ['info', '提示'],
    ] as const) {
      const { unmount } = render(<SeverityTag severity={severity} />);
      expect(screen.getByText(label)).not.toBeNull();
      unmount();
    }
  });

  it('consumesSevTokens_noPresetColorName（FE-02）', () => {
    const { container } = render(<SeverityTag severity="major" />);
    const tag = container.querySelector('.ant-tag');
    expect(tag).not.toBeNull();
    const style = tag?.getAttribute('style') ?? '';
    expect(style).toContain('var(--ti-sev-major)');
    expect(tag?.className).not.toMatch(/ant-tag-(red|volcano|orange|gold|blue)/);
  });
});
