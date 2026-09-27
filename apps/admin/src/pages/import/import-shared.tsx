/**
 * 导入页面共享件（M2-import §10；ui/baseline §3.4 向导规范）：
 * 状态徽标、issue 徽标、轮询 hook、单位换算预览文案（§6.5 affine 展示公式）。
 */
import { useEffect, useRef } from 'react';
import { Tag } from 'antd';
import {
  type ImportIssueCode,
  type ImportJobStatus,
  convertSample,
  findUnitConversion,
} from '@thermio/shared-types';
import { ApiError } from '../../app/api-client.js';

export function errorText(cause: unknown, fallback: string): string {
  return cause instanceof ApiError ? cause.parsed.message : fallback;
}

/** 作业状态徽标（六值封闭集；色阶对齐原型 status chip）。 */
export function JobStatusTag({ status }: { status: ImportJobStatus }): React.ReactNode {
  const map: Record<ImportJobStatus, { color: string; label: string }> = {
    parsed: { color: 'blue', label: 'parsed' },
    mapping: { color: 'gold', label: 'mapping' },
    validated: { color: 'cyan', label: 'validated' },
    applied: { color: 'green', label: 'applied' },
    checked: { color: 'green', label: 'checked' },
    failed: { color: 'red', label: 'failed' },
  };
  const meta = map[status];
  return <Tag color={meta.color}>{meta.label}</Tag>;
}

/** issue 级别徽标（阻塞红/警告橙；§7 分级）。 */
export function IssueTag({
  code,
  blocking,
}: {
  code: ImportIssueCode;
  blocking: boolean;
}): React.ReactNode {
  return (
    <Tag color={blocking ? 'red' : 'orange'} title={code}>
      {blocking ? '阻塞' : '警告'} · {code}
    </Tag>
  );
}

/** 轮询 hook（客户端 1–2s 间隔轮询驱动步骤推进，§3.3；卸载即停）。 */
export function usePolling(callback: () => void, intervalMs: number, active: boolean): void {
  const ref = useRef(callback);
  ref.current = callback;
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => {
      ref.current();
    }, intervalMs);
    return () => {
      clearInterval(timer);
    };
  }, [intervalMs, active]);
}

/** 换算式预览文案（§6.5：affine 必须展示公式而非单因子；identity = 不换算）。 */
export function conversionLabel(unitRaw: string, unitStd: string): string {
  const entry = findUnitConversion(unitRaw, unitStd);
  if (entry === null) {
    return `⚠ ${unitRaw} → ${unitStd}：无内置转换（dry-run 将报阻塞 unit_unsupported）`;
  }
  if (entry.kind === 'identity') {
    return `${unitRaw} → ${unitStd}：1:1 直通（不换算）`;
  }
  if (entry.kind === 'linear') {
    return `${unitRaw} → ${unitStd}：× ${String(entry.scale)}（样例 1 → ${convertSample(1, entry).toPrecision(4)}）`;
  }
  return `${unitRaw} → ${unitStd}：${String(entry.scale)} × x + ${entry.offset.toPrecision(3)}（样例 1 → ${convertSample(1, entry).toPrecision(4)}）`;
}

/** Excel 行号展示（§2.2 注记：UI 展示 Excel 行号 = row_no + 1）。 */
export function excelRow(rowNo: number): number {
  return rowNo + 1;
}
