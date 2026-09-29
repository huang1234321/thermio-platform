/**
 * 顶部告警角标（ui/baseline.md §5.2 / M4-alarm.md §7）：GET /alarms/counts 30s 轮询
 * ——当前 open 计数 + critical 单独红点；点击跳 /alarms。MVP 无告警 SSE（M3 SSE 仅遥测）。
 * 未授权（无 alarms.read）不渲染；请求失败静默保持上次值（角标是辅助信息不阻断）。
 */
import { Badge, Button } from 'antd';
import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { AlarmCountsSchema, type AlarmCounts } from '@thermio/shared-types';
import { apiFetch } from '../../app/api-client.js';
import { useCapabilities } from '../../app/auth-context.js';

const POLL_MS = 30_000;

export function AlarmBadge(): React.ReactNode {
  const capabilities = useCapabilities();
  const navigate = useNavigate();
  const [counts, setCounts] = useState<AlarmCounts | null>(null);

  const refresh = useCallback(async (): Promise<void> => {
    try {
      setCounts(await apiFetch('/alarms/counts', AlarmCountsSchema));
    } catch {
      // 静默保持上次值（角标不阻断主流程）
    }
  }, []);

  useEffect(() => {
    if (!capabilities.includes('alarms.read')) return;
    void refresh();
    const timer = setInterval(() => void refresh(), POLL_MS);
    return () => {
      clearInterval(timer);
    };
  }, [capabilities, refresh]);

  if (!capabilities.includes('alarms.read')) return null;

  return (
    <Button
      type="text"
      onClick={() => void navigate('/alarms')}
      title="当前未确认告警（critical 单独红点）"
    >
      <Badge count={counts?.open ?? 0} size="small" offset={[4, -2]}>
        告警
      </Badge>
      {(counts?.open_critical ?? 0) > 0 && (
        <Badge count={counts?.open_critical ?? 0} size="small" style={{ marginLeft: 12 }} />
      )}
    </Button>
  );
}
