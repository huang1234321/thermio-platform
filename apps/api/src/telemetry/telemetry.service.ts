/**
 * 遥测查询服务（IMPL-12 编排层）：
 * 点位档案判别（PG）→ 跨度/时间窗校验 → interval 路由（raw/5min/1h）→ 游标分页。
 *
 * 错误口径（overview M1 端点表 → platform §5.2 落码）：
 * - 未登记点位 / 越租户：asset.not_found 404（POINT_NOT_FOUND 映射，SEC-AZ-03 不泄露存在性）；
 * - 已登记无遥测：point.no_data 404（latest 空态）；
 * - 跨度超限 / from≥to：telemetry.range_invalid 422（TELEMETRY_RANGE_INVALID 映射）；
 * - 存储未配置/不可达：telemetry.store_unavailable 503（显式降级口径，ADR-005）。
 */
import { Inject, Injectable } from '@nestjs/common';
import type { Logger as PinoLogger } from 'pino';
import {
  TELEMETRY_DEFAULT_WINDOW_HOURS,
  type PointLatest,
  type TelemetryPage,
  type TelemetryQuery,
} from '@thermio/shared-types';
import { APP_CONFIG } from '../infrastructure/core.module.js';
import { LOGGER } from '../infrastructure/logger.js';
import type { AppConfig } from '../config.js';
import { ReasonCodeException } from '../infrastructure/errors/reason-code.exception.js';
import { decodeCursor, encodeCursor } from './telemetry-cursor.js';
import { type PointRegistry } from './point-lookup.service.js';
import { type TelemetryStore } from './tsdb-read.repository.js';
import { TELEMETRY_STORE, POINT_REGISTRY } from './telemetry.tokens.js';
import { TelemetryStoreUnavailableError } from './telemetry-store.error.js';

/** 跨度毫数（to - from）→ 天，留 3 位小数（小时级窗口也能判档）。 */
const MS_PER_DAY = 24 * 60 * 60 * 1000;

@Injectable()
export class TelemetryService {
  constructor(
    @Inject(TELEMETRY_STORE) private readonly store: TelemetryStore,
    @Inject(POINT_REGISTRY) private readonly points: PointRegistry,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(LOGGER) private readonly logger: PinoLogger,
  ) {}

  /** GET /points/{id}/latest：最新一行遥测。 */
  async latest(pointId: number): Promise<PointLatest> {
    await this.ensureRegistered(pointId);
    const row = await this.guarded(() => this.store.latest(pointId));
    if (row === null) {
      throw new ReasonCodeException('point.no_data', '该点位尚无遥测数据', { point_id: pointId });
    }
    return {
      point_id: pointId,
      ts: row.ts,
      value: row.value,
      value_text: row.value_text,
      quality: row.quality,
    };
  }

  /** GET /points/{id}/telemetry：interval 路由 + 游标分页。 */
  async telemetry(pointId: number, query: TelemetryQuery): Promise<TelemetryPage> {
    const window = this.resolveWindow(query);
    await this.ensureRegistered(pointId);

    const interval = query.interval; // const 局部量：闭包内保住 raw/聚合 narrowing
    const fetchLimit = query.limit + 1; // 探测 next_cursor 的多取一行
    if (interval === 'raw') {
      const rows = await this.guarded(() =>
        this.store.listRaw({
          pointId,
          from: window.from,
          to: window.to,
          after: window.after,
          fetchLimit,
        }),
      );
      const { items, nextCursor } = pageOf(rows, (row) => row.ts, query.limit);
      return {
        point_id: pointId,
        interval: 'raw',
        from: window.from,
        to: window.to,
        items,
        next_cursor: nextCursor,
      };
    }

    const rows = await this.guarded(() =>
      this.store.listAggregate(interval, {
        pointId,
        from: window.from,
        to: window.to,
        after: window.after,
        fetchLimit,
      }),
    );
    const { items, nextCursor } = pageOf(rows, (row) => row.bucket, query.limit);
    return {
      point_id: pointId,
      interval,
      from: window.from,
      to: window.to,
      items,
      next_cursor: nextCursor,
    };
  }

  /** 点位登记判别：未登记/越租户统一 404（不泄露存在性）。 */
  private async ensureRegistered(pointId: number): Promise<void> {
    const exists = await this.guarded(() => this.points.exists(pointId));
    if (!exists) {
      throw new ReasonCodeException('asset.not_found', '点位不存在', { point_id: pointId });
    }
  }

  /**
   * 时间窗解析：缺省 to=now、from=to-24h（TELEMETRY_DEFAULT_WINDOW_HOURS）；
   * 校验 from<to、跨度按 interval 分档不超限（env 可覆盖默认档）；
   * 游标解码失败归一校验错误。全部通过才发查询。
   */
  private resolveWindow(query: TelemetryQuery): {
    from: string;
    to: string;
    after: string | null;
  } {
    const toDate = query.to !== undefined ? new Date(query.to) : new Date(Date.now());
    const fromDate =
      query.from !== undefined
        ? new Date(query.from)
        : new Date(toDate.getTime() - TELEMETRY_DEFAULT_WINDOW_HOURS * 60 * 60 * 1000);

    if (Number.isNaN(fromDate.getTime()) || Number.isNaN(toDate.getTime())) {
      throw new ReasonCodeException('telemetry.range_invalid', '时间参数无法解析', {
        from: query.from ?? null,
        to: query.to ?? null,
      });
    }
    if (fromDate.getTime() >= toDate.getTime()) {
      throw new ReasonCodeException('telemetry.range_invalid', 'from 必须早于 to', {
        from: fromDate.toISOString(),
        to: toDate.toISOString(),
      });
    }

    const maxDays = this.config.telemetrySpanLimitDays[query.interval];
    const spanDays = (toDate.getTime() - fromDate.getTime()) / MS_PER_DAY;
    if (spanDays > maxDays) {
      throw new ReasonCodeException(
        'telemetry.range_invalid',
        `查询跨度超出该粒度上限（${String(maxDays)} 天），请缩窗或改用更粗粒度`,
        {
          interval: query.interval,
          from: fromDate.toISOString(),
          to: toDate.toISOString(),
          span_days: Math.round(spanDays * 1000) / 1000,
          max_span_days: maxDays,
        },
      );
    }

    const cursor = decodeCursor(query.cursor);
    if (query.cursor !== undefined && cursor === null) {
      throw new ReasonCodeException('common.validation_failed', 'cursor 无法解析', {
        cursor: query.cursor.slice(0, 64),
      });
    }

    return {
      from: fromDate.toISOString(),
      to: toDate.toISOString(),
      after: cursor?.ts ?? null,
    };
  }

  /** 存储不可用 → 503 信封；其余异常原样上抛（全局过滤器兜底）。 */
  private async guarded<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation();
    } catch (err: unknown) {
      if (err instanceof TelemetryStoreUnavailableError) {
        this.logger.warn({ msg: 'telemetry_store_unavailable', err: err.message });
        throw new ReasonCodeException(
          'telemetry.store_unavailable',
          '遥测存储暂不可用（未配置或不可达）',
        );
      }
      throw err;
    }
  }
}

/** 多取一行截回 limit；末行时间戳编为 next_cursor（不足 limit 即末页 → null）。 */
function pageOf<T>(
  rows: readonly T[],
  anchorOf: (row: T) => string,
  limit: number,
): { items: T[]; nextCursor: string | null } {
  const hasMore = rows.length > limit;
  const items = hasMore ? rows.slice(0, limit) : [...rows];
  const last = items.at(-1);
  return {
    items,
    nextCursor: hasMore && last !== undefined ? encodeCursor({ ts: anchorOf(last) }) : null,
  };
}
