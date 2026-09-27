/**
 * 建议域共享 hooks（M5-proposal.md §6，IMPL-17 / DAT-163）。
 */
import { useEffect, useState } from 'react';
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
