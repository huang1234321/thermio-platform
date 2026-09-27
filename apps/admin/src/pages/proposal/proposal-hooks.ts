/**
 * 建议域共享 hooks（M5-proposal.md §6，IMPL-17 / DAT-163）。
 */
import { useEffect, useRef, useState } from 'react';
import { BuildingListResponseSchema } from '@thermio/shared-types';
import { apiFetch } from '../../app/api-client.js';

/** 楼宇下拉（全局上下文联动，baseline §5.1；GET /buildings 一次性取全量翻页首页）。 */
export function useBuildingOptions(): readonly { value: string; label: string }[] {
  const [options, setOptions] = useState<readonly { value: string; label: string }[]>([]);
  useEffect(() => {
    let cancelled = false;
    void apiFetch('/buildings?limit=200', BuildingListResponseSchema)
      .then((result) => {
        if (!cancelled) {
          setOptions(
            result.items.map((building) => ({ value: building.id, label: building.name })),
          );
        }
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);
  return options;
}

// ---------------------------------------------------------------------------
// 状态轮询（M5-proposal.md §7：202 异步语义落码；B2 抽取复用）
// ---------------------------------------------------------------------------

/** 轮询节奏 3s（对齐 SSE 节流窗口量级，platform §12）。 */
export const PROPOSAL_POLL_INTERVAL_MS = 3_000;
/** 连续 30 次（≈90s）未终态 → 停止（仲裁预算 90s 由 dispatcher 兜底收敛）。 */
export const PROPOSAL_POLL_MAX_ROUNDS = 30;

/**
 * 通用轮询 hook：3s 节奏、isActive 为真续轮、终态（isActive 假）即停、
 * 30 次上限、页面隐藏暂停（baseline §4.5 纪律沿用）。
 * `enabled` 翻真（如 approve 后进 approved 态）即启动一个新轮询窗口；
 * 返回轮次 ref（消费方可据此渲染「执行仍在进行，请稍后手动刷新」提示）。
 */
export function useProposalPolling<T>(
  load: () => Promise<T>,
  isActive: (data: T) => boolean,
  onData: (data: T) => void,
  enabled: boolean,
): Readonly<{ readonly rounds: React.MutableRefObject<number> }> {
  const rounds = useRef(0);
  const activeRef = useRef(isActive);
  activeRef.current = isActive;
  const dataRef = useRef(onData);
  dataRef.current = onData;

  useEffect(() => {
    if (!enabled) return;
    rounds.current = 0; // 新轮询窗口重新计数
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const round = async (): Promise<void> => {
      try {
        const next = await load();
        if (stopped) return;
        dataRef.current(next);
        if (
          activeRef.current(next) &&
          rounds.current < PROPOSAL_POLL_MAX_ROUNDS &&
          document.visibilityState === 'visible'
        ) {
          rounds.current += 1;
          timer = setTimeout(() => void round(), PROPOSAL_POLL_INTERVAL_MS);
        }
      } catch {
        // 读失败不乐观更新：保留上一帧数据、停止轮询（手动刷新兜底）
      }
    };
    void round();
    return () => {
      stopped = true;
      if (timer !== null) clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- enabled 变更须重启窗口
  }, [load, enabled]);

  return { rounds };
}
