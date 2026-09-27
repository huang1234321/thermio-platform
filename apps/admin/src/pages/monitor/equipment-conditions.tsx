/**
 * 设备工况（M3-monitor §8.2 页面 2 · 检索）：跨系统设备运行态检索。
 * 筛选白名单（§3.2）：system / equipment_type / run_state / keyword；
 * 卡片行 = run_state 徽标 + alarm_worst + 关键点位实时值（去重 ≤5）。
 * 布局：三列固定栅格（身份 / 告警槽 / 点位三列）——跨卡同列纵向对齐，
 * 告警徽标有无不挤占数据列（视觉门 r1 页3-2）。
 * 列表接口游标分页——mock 数据单页返回，加载更多按钮随 next_cursor 显隐。
 */
import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Card, Empty, Input, Segmented, Select, Space, Spin, Tag, Typography, theme } from 'antd';
import type { ReactNode } from 'react';
import { EQUIPMENT_TYPES } from '@thermio/shared-types';
import type { EquipmentConditionCard } from './api-contracts.js';
import {
  MONITOR_MOCK,
  fetchMonitorOverview,
  fetchMonitorSystems,
  fetchEquipmentConditions,
  statusDisplayText,
} from './monitor-data.js';

const RUN_STATE_META = {
  running: { label: '运行', color: 'green' },
  standby: { label: '备用', color: 'default' },
  fault: { label: '故障', color: 'red' },
  unknown: { label: '未知', color: 'default' },
} as const;

const SEVERITY_TAG = {
  info: { color: 'blue', label: 'info' },
  warning: { color: 'orange', label: 'warning' },
  minor: { color: 'gold', label: 'minor' },
  major: { color: 'volcano', label: 'major' },
  critical: { color: 'red', label: 'critical' },
} as const;

/** 关键点位固定三列（同型设备点位集一致，跨卡列位对齐）。 */
const KEY_POINT_COLUMNS = 'repeat(3, minmax(96px, 120px))';

export function EquipmentConditionsPage(): ReactNode {
  const navigate = useNavigate();
  const { token } = theme.useToken();
  const [items, setItems] = useState<readonly EquipmentConditionCard[]>([]);
  const [loading, setLoading] = useState(true);
  const [systemId, setSystemId] = useState<string>('');
  const [systems, setSystems] = useState<readonly { id: string; name: string }[]>([]);
  const [runState, setRunState] = useState<string>('');
  const [equipmentType, setEquipmentType] = useState<string>('');
  const [keyword, setKeyword] = useState('');

  const load = useCallback(async (): Promise<void> => {
    setLoading(true);
    try {
      const page = await fetchEquipmentConditions({
        ...(systemId !== '' && { systemId }),
        ...(runState !== '' && { runState }),
        ...(equipmentType !== '' && { equipmentType }),
        keyword,
      });
      setItems(page.items);
    } finally {
      setLoading(false);
    }
  }, [systemId, runState, equipmentType, keyword]);

  useEffect(() => {
    void load();
  }, [load]);

  // 系统清单（§3.2 首项筛选）：mock 走 fixtures；real 缺 assets.read 时降级隐藏
  useEffect(() => {
    let cancelled = false;
    const loadSystems = async (): Promise<void> => {
      try {
        const overview = await fetchMonitorOverview();
        const list = await fetchMonitorSystems(overview.building.id);
        if (!cancelled) setSystems(list);
      } catch {
        if (!cancelled) setSystems([]);
      }
    };
    void loadSystems();
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <Card
      title={
        <Space>
          设备工况
          {MONITOR_MOCK && <Tag color="orange">演示数据</Tag>}
        </Space>
      }
      extra={
        <Space wrap>
          {systems.length > 0 && (
            <Select<string>
              allowClear
              placeholder="系统"
              style={{ minWidth: 160 }}
              value={systemId === '' ? null : systemId}
              onChange={(value) => {
                // antd 泛型把 clear 值标成 string，运行时可能是 undefined——按可空宽化处理
                const next = value as string | null | undefined;
                setSystemId(next ?? '');
              }}
              options={systems.map((system) => ({ value: system.id, label: system.name }))}
            />
          )}
          <Segmented
            value={runState}
            onChange={(value) => {
              setRunState(value);
            }}
            options={[
              { label: '全部', value: '' },
              { label: '运行', value: 'running' },
              { label: '备用', value: 'standby' },
              { label: '故障', value: 'fault' },
              { label: '未知', value: 'unknown' },
            ]}
          />
          <Select<string>
            allowClear
            placeholder="设备类型"
            style={{ minWidth: 140 }}
            value={equipmentType === '' ? null : equipmentType}
            onChange={(value) => {
              const next = value as string | null | undefined;
              setEquipmentType(next ?? '');
            }}
            options={EQUIPMENT_TYPES.map((type) => ({ value: type, label: type }))}
          />
          <Input.Search
            allowClear
            placeholder="名称 / 编号"
            style={{ width: 200 }}
            onSearch={(value) => {
              setKeyword(value);
            }}
          />
        </Space>
      }
    >
      {loading ? (
        <div style={{ textAlign: 'center', padding: 48 }}>
          <Spin />
        </div>
      ) : items.length === 0 ? (
        <Empty description="无匹配设备" />
      ) : (
        <Space direction="vertical" size={12} style={{ width: '100%' }}>
          {items.map((card) => {
            const severity = card.alarm_worst;
            return (
              <Card
                key={card.equipment.id}
                size="small"
                hoverable
                onClick={() => {
                  void navigate(`/monitor/equipments/${card.equipment.id}`);
                }}
                styles={{
                  body: {
                    display: 'grid',
                    gridTemplateColumns: 'minmax(220px, 280px) 132px 1fr',
                    gap: 16,
                    alignItems: 'center',
                  },
                }}
              >
                <div>
                  <Space size={8}>
                    <Tag
                      color={RUN_STATE_META[card.run_state].color}
                      style={{ marginInlineEnd: 0 }}
                    >
                      {RUN_STATE_META[card.run_state].label}
                    </Tag>
                    <Typography.Text strong>{card.equipment.name}</Typography.Text>
                    <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                      {card.equipment.local_id} · {card.equipment.equipment_type}
                    </Typography.Text>
                  </Space>
                </div>
                {/* 告警槽固定列宽：无告警也占位，数据列不漂移 */}
                <div>
                  {severity !== null ? (
                    <Tag color={SEVERITY_TAG[severity].color} style={{ marginInlineEnd: 0 }}>
                      在用告警 {SEVERITY_TAG[severity].label}
                    </Tag>
                  ) : (
                    <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                      无在用告警
                    </Typography.Text>
                  )}
                </div>
                <div style={{ display: 'grid', gridTemplateColumns: KEY_POINT_COLUMNS, gap: 16 }}>
                  {card.key_points.length === 0 ? (
                    <Typography.Text type="secondary">—</Typography.Text>
                  ) : (
                    card.key_points.map((point) => (
                      <div key={point.point_id}>
                        <div style={{ fontSize: 12, color: token.colorTextTertiary }}>
                          {point.display_name ?? point.point_id}
                        </div>
                        <div>
                          {statusDisplayText(point.quantity_type, point.latest, card.run_state)}
                          {point.unit_std !== null ? ` ${point.unit_std}` : ''}
                        </div>
                      </div>
                    ))
                  )}
                </div>
              </Card>
            );
          })}
        </Space>
      )}
    </Card>
  );
}
