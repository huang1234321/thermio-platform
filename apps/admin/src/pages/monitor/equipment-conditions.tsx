/**
 * 设备工况（M3-monitor §8.2 页面 2 · 检索）：跨系统设备运行态检索。
 * 筛选白名单（§3.2）：system / equipment_type / run_state / keyword；
 * 卡片行 = run_state 徽标 + alarm_worst + 关键点位实时值（去重 ≤5）。
 * 列表接口游标分页——mock 数据单页返回，加载更多按钮随 next_cursor 显隐。
 */
import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Card, Empty, Input, Segmented, Select, Space, Spin, Tag, Typography } from 'antd';
import type { ReactNode } from 'react';
import { EQUIPMENT_TYPES } from '@thermio/shared-types';
import type { EquipmentConditionCard } from './api-contracts.js';
import { MONITOR_MOCK, displayPointValue, fetchEquipmentConditions } from './monitor-data.js';

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

export function EquipmentConditionsPage(): ReactNode {
  const navigate = useNavigate();
  const [items, setItems] = useState<readonly EquipmentConditionCard[]>([]);
  const [loading, setLoading] = useState(true);
  const [runState, setRunState] = useState<string>('');
  const [equipmentType, setEquipmentType] = useState<string>('');
  const [keyword, setKeyword] = useState('');

  const load = useCallback(async (): Promise<void> => {
    setLoading(true);
    try {
      const page = await fetchEquipmentConditions({
        runState,
        equipmentType,
        keyword,
      });
      setItems(page.items);
    } finally {
      setLoading(false);
    }
  }, [runState, equipmentType, keyword]);

  useEffect(() => {
    void load();
  }, [load]);

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
              // antd 泛型把 clear 值标成 string，运行时可能是 undefined——按可空宽化处理
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
                  body: { display: 'flex', gap: 16, alignItems: 'center', flexWrap: 'wrap' },
                }}
              >
                <div style={{ minWidth: 240 }}>
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
                {severity !== null && (
                  <Tag color={SEVERITY_TAG[severity].color} style={{ marginInlineEnd: 0 }}>
                    在用告警 {SEVERITY_TAG[severity].label}
                  </Tag>
                )}
                <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', flex: 1 }}>
                  {card.key_points.map((point) => (
                    <div key={point.point_id} style={{ minWidth: 120 }}>
                      <div style={{ fontSize: 12, color: '#8c8c8c' }}>
                        {point.display_name ?? point.point_id}
                      </div>
                      <div>
                        {displayPointValue(point.quantity_type, point.latest)}
                        {point.unit_std !== null ? ` ${point.unit_std}` : ''}
                      </div>
                    </div>
                  ))}
                </div>
              </Card>
            );
          })}
        </Space>
      )}
    </Card>
  );
}
