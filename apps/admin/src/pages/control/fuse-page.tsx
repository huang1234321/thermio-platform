/**
 * 熔断状态页 /control/fuse（M8-safety-ui.md §7，UC-M8-5；MVP 只读）。
 *
 * - 系统卡片组：closed 灰绿 / open 红描边；open 卡展示 trigger_detail 快照
 *   （窗口/异常占比/连续失败数——未知键折叠原文）+「受影响点位」入口（→ 清单页
 *   系统过滤）；60s 自动轮询（§7.1：与 fuse-evaluator 节奏耦合，SSE 边界外）；
 * - 事件时间线：选中系统 control_fuse_event（tripped/released · actor · at ·
 *   detail/reason）；tripped 行附降级联动摘要 + 变更历史预筛链接；
 * - open 卡固定黄条：「熔断解除后点位仍停 advisory，恢复控制须逐档前进」；
 * - 手动解除按钮 P1 不渲染（§7.5：能力键 control.fuse_release P1 才下发）。
 */
import { Alert, Button, Card, Space, Tag, Timeline, Typography, message } from 'antd';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import {
  BuildingListResponseSchema,
  ControlPointsListResponseSchema,
  FuseEventsResponseSchema,
  type ControlPointItem,
  type FuseEventItem,
} from '@thermio/shared-types';
import { apiFetch } from '../../app/api-client.js';
import { errorText } from '../asset/asset-shared.js';

/** trigger_detail 解码（§7.2：「窗口 15min · 异常占比 42%（≥30% 阈值）· 连续失败 3 次」；未知键折叠）。 */
function detailLines(detail: Record<string, unknown> | null | undefined): string[] {
  if (detail === null || detail === undefined) return [];
  const lines: string[] = [];
  const detailWindowS = detail['window_s'];
  if (typeof detailWindowS === 'number')
    lines.push(`窗口 ${String(Math.round(detailWindowS / 60))}min`);
  const detailRatio = detail['ratio'];
  if (typeof detailRatio === 'number')
    lines.push(`异常占比 ${String(Math.round(detailRatio * 100))}%`);
  const detailConsecutive = detail['consecutive_fails'];
  if (typeof detailConsecutive === 'number') lines.push(`连续失败 ${String(detailConsecutive)} 次`);
  const detailNumerator = detail['numerator'];
  const detailDenominator = detail['denominator'];
  if (typeof detailNumerator === 'number' && typeof detailDenominator === 'number') {
    lines.push(`分子/分母 ${String(detailNumerator)}/${String(detailDenominator)}`);
  }
  const detailSustainedS = detail['sustained_s'];
  if (typeof detailSustainedS === 'number')
    lines.push(`回落持续 ${String(Math.round(detailSustainedS / 60))}min`);
  const known = [
    'window_s',
    'ratio',
    'consecutive_fails',
    'numerator',
    'denominator',
    'sustained_s',
    'ratio_ok_since',
  ];
  const rest = Object.entries(detail).filter(([key]) => !known.includes(key));
  if (lines.length === 0 && rest.length === 0) lines.push(JSON.stringify(detail));
  else if (rest.length > 0) lines.push(JSON.stringify(Object.fromEntries(rest)));
  return lines;
}

const FUSE_POLL_INTERVAL_MS = 60_000; // §7.1：与 FUSE_EVAL_INTERVAL_S 耦合的界面体验值

export function FusePage(): React.ReactNode {
  const navigate = useNavigate();
  const [points, setPoints] = useState<readonly ControlPointItem[]>([]);
  const [selectedSystem, setSelectedSystem] = useState<string | null>(null);
  const [events, setEvents] = useState<readonly FuseEventItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);

  const load = useCallback(async (): Promise<void> => {
    setLoading(true);
    setError(null);
    try {
      const response = await apiFetch(
        '/control/points?limit=200&is_controllable=all',
        ControlPointsListResponseSchema,
      );
      setPoints(response.items);
      // 空楼校验仅防未初始化告警；楼宇上下文过滤由后端 scope 承担
      void apiFetch('/buildings?limit=1', BuildingListResponseSchema).catch(() => undefined);
    } catch (cause) {
      setError(errorText(cause, '熔断状态加载失败'));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
    timer.current = setInterval(() => void load(), FUSE_POLL_INTERVAL_MS);
    return () => {
      if (timer.current !== null) clearInterval(timer.current);
    };
  }, [load]);

  const loadEvents = useCallback(async (systemId: string): Promise<void> => {
    try {
      const response = await apiFetch(
        `/control/systems/${systemId}/fuse-events?limit=30`,
        FuseEventsResponseSchema,
      );
      setEvents(response.items);
    } catch (cause) {
      message.warning(errorText(cause, '事件历史加载失败'));
      setEvents([]);
    }
  }, []);

  useEffect(() => {
    if (selectedSystem !== null) void loadEvents(selectedSystem);
  }, [selectedSystem, loadEvents]);

  /** 按系统聚合清单行（§7.1 系统卡片组数据面：system_fuse 从点位行 join 派生）。 */
  const systems = Array.from(
    new Map(
      points
        .filter((p) => p.system !== null)
        .map((p) => [p.system?.id as string, { system: p.system, fuse: p.system_fuse, point: p }]),
    ).entries(),
  );

  return (
    <Space direction="vertical" size={16} style={{ width: '100%' }}>
      {error !== null && <Alert type="error" showIcon message={error} />}
      <Alert
        type="info"
        showIcon
        message="熔断期间闸门 5 拒绝全部新提案；系统内非 advisory 点位被强制压回 advisory（逐点 config_audit 留痕）"
      />
      <Space size={16} wrap>
        {systems.length === 0 && !loading && (
          <Typography.Text type="secondary">暂无系统（先在资产域登记冷热源系统）</Typography.Text>
        )}
        {systems.map(([systemId, { system, fuse }]) => (
          <Card
            key={systemId}
            size="small"
            style={{
              width: 340,
              borderColor: fuse === 'open' ? 'var(--ti-sev-critical)' : undefined,
            }}
            title={
              <Space size={8}>
                <span>{system?.name}</span>
                {fuse === 'open' ? (
                  <Tag color="red">熔断 open</Tag>
                ) : (
                  <Tag color="green">正常 closed</Tag>
                )}
              </Space>
            }
            extra={
              <Button
                size="small"
                onClick={() => {
                  setSelectedSystem(systemId);
                }}
              >
                事件历史
              </Button>
            }
          >
            <Space direction="vertical" size={6} style={{ width: '100%' }}>
              <Typography.Text type="secondary">{system?.system_type}</Typography.Text>
              {fuse === 'open' && (
                <>
                  <Alert
                    type="warning"
                    showIcon
                    message="熔断解除后点位仍停 advisory，恢复控制须逐档前进（reason 必填）"
                  />
                  <Button
                    size="small"
                    onClick={() => {
                      void navigate(`/control/points?system_id=${systemId}`);
                    }}
                  >
                    查看受影响点位
                  </Button>
                </>
              )}
            </Space>
          </Card>
        ))}
      </Space>

      {selectedSystem !== null && (
        <Card
          title={`事件历史 · ${points.find((p) => p.system?.id === selectedSystem)?.system?.name ?? selectedSystem}`}
          size="small"
        >
          {events.length === 0 ? (
            <Typography.Text type="secondary">暂无触发/恢复记录</Typography.Text>
          ) : (
            <Timeline
              items={events.map((event) => ({
                color: event.event_type === 'tripped' ? 'red' : 'green',
                children: (
                  <Space direction="vertical" size={2}>
                    <Typography.Text strong>
                      {event.event_type === 'tripped'
                        ? '触发熔断'
                        : event.actor_type === 'human'
                          ? '手动解除'
                          : '自动恢复'}
                      {' · '}
                      {event.actor_type === 'human' ? (event.actor_ref ?? '用户') : 'system'} ·{' '}
                      {event.at.replace('T', ' ').slice(0, 19)}
                    </Typography.Text>
                    {detailLines(event.detail).map((line) => (
                      <Typography.Text key={line} type="secondary" style={{ fontSize: 12 }}>
                        {line}
                      </Typography.Text>
                    ))}
                    {event.reason !== null && event.reason.length > 0 && (
                      <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                        {event.reason}
                      </Typography.Text>
                    )}
                    {event.event_type === 'tripped' && (
                      <Link to={`/control/config-audit?actor_type=system&field=control_mode`}>
                        查看降级联动留痕（config_audit · system）
                      </Link>
                    )}
                  </Space>
                ),
              }))}
            />
          )}
        </Card>
      )}
    </Space>
  );
}
