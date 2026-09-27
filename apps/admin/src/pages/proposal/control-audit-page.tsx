/**
 * 执行审计页 /control-audit（M5-proposal.md §6.4，UC-M5-4/5）。
 *
 * - 列表页型（baseline §3.1）：筛选区 = 点位 / 建议 id（从执行详情带入，直填只读）/
 *   行为者 / 结果 / 时间区间（全部白名单内 §3.7）；无 Tabs；
 * - 行：时间 + actor 徽标 + result 徽标 + 点位 + old→new + reason + 建议深链
 *   （proposal_id 空的 system 行显示「系统接管（无关联提案）」，§2.2）；
 * - 默认排序 at DESC；加载更多。
 */
import { Alert, Button, Card, DatePicker, Input, Select, Space, Typography } from 'antd';
import { useCallback, useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { ControlAuditListResponseSchema, type ControlAuditRow } from '@thermio/shared-types';
import { apiFetch } from '../../app/api-client.js';
import { errorText } from '../asset/asset-shared.js';
import { AuditChainTable } from './proposal-execution-page.js';

export function ControlAuditPage(): React.ReactNode {
  const [searchParams] = useSearchParams();
  const [rows, setRows] = useState<readonly ControlAuditRow[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [pointId, setPointId] = useState(searchParams.get('point_id') ?? '');
  const [proposalId, setProposalId] = useState(searchParams.get('proposal_id') ?? '');
  const [actorType, setActorType] = useState<string | undefined>(undefined);
  const [result, setResult] = useState<string | undefined>(undefined);
  const [range, setRange] = useState<[Date | null, Date | null] | null>(null);
  const proposalLocked = searchParams.get('proposal_id') !== null;

  const load = useCallback(
    async (nextCursor?: string): Promise<void> => {
      setLoading(true);
      setError(null);
      try {
        const params = new URLSearchParams({ limit: '50' });
        if (pointId.trim().length > 0) params.set('point_id', pointId.trim());
        if (proposalId.trim().length > 0) params.set('proposal_id', proposalId.trim());
        if (actorType !== undefined) params.set('actor_type', actorType);
        if (result !== undefined) params.set('result', result);
        if (range !== null && range[0] !== null) params.set('from', range[0].toISOString());
        if (range !== null && range[1] !== null) params.set('to', range[1].toISOString());
        if (nextCursor !== undefined && nextCursor.length > 0) params.set('cursor', nextCursor);
        const response = await apiFetch(
          `/control-audit?${params.toString()}`,
          ControlAuditListResponseSchema,
        );
        setRows((prev) =>
          nextCursor === undefined ? response.items : [...prev, ...response.items],
        );
        setCursor(response.next_cursor);
      } catch (cause) {
        setError(errorText(cause, '执行审计加载失败'));
      } finally {
        setLoading(false);
      }
    },
    [pointId, proposalId, actorType, result, range],
  );

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <Space direction="vertical" size={12} style={{ width: '100%' }}>
      <Card size="small">
        <Space wrap size={12}>
          <Input
            allowClear
            placeholder="点位 ID（point_id）"
            style={{ width: 180 }}
            value={pointId}
            onChange={(event) => {
              setPointId(event.target.value);
            }}
          />
          <Input
            allowClear={!proposalLocked}
            placeholder="建议 ID（proposal_id）"
            style={{ width: 240 }}
            value={proposalId}
            onChange={(event) => {
              setProposalId(event.target.value);
            }}
            disabled={proposalLocked}
          />
          <Select
            allowClear
            placeholder="行为者"
            style={{ width: 120 }}
            value={actorType}
            onChange={setActorType}
            options={[
              { value: 'algo', label: '算法' },
              { value: 'human', label: '人工' },
              { value: 'system', label: '系统' },
            ]}
          />
          <Select
            allowClear
            placeholder="结果"
            style={{ width: 140 }}
            value={result}
            onChange={setResult}
            options={[
              { value: 'ok', label: '成功' },
              { value: 'verify_failed', label: '验证失败' },
              { value: 'reverted', label: '已回滚' },
              { value: 'rejected', label: '已拒绝' },
            ]}
          />
          <DatePicker.RangePicker
            showTime
            onChange={(values) => {
              setRange(
                values === null ? null : [values[0]?.toDate() ?? null, values[1]?.toDate() ?? null],
              );
            }}
          />
        </Space>
      </Card>
      <Card size="small" title="执行审计">
        {error !== null && (
          <Alert type="error" showIcon message={error} style={{ marginBottom: 12 }} />
        )}
        <AuditChainTable rows={rows} />
        <Space style={{ marginTop: 12 }} align="center">
          <Button
            loading={loading}
            disabled={cursor === null}
            onClick={() => void load(cursor ?? undefined)}
          >
            加载更多
          </Button>
          <Typography.Text type="secondary">已加载 {String(rows.length)} 条</Typography.Text>
        </Space>
      </Card>
    </Space>
  );
}
