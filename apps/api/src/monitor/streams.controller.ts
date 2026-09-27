/**
 * SSE 实时推送通道（platform.md §10 逐字 + M3-monitor §3.5 事件形状，IMPL-14）：
 * GET /streams/telemetry?point_ids=（csv ≤500，超出整单 400 stream.limit_exceeded；
 * 点集任一越权/不存在 → 整单 400 point.not_found + details.point_ids）。
 *
 * 通道纪律：
 * - 订阅状态为连接内存态（多副本无会话亲和控制面）——本实现按节流窗口轮询 TSDB
 *   latest 批量、按 (ts,value,value_text,quality) diff 出变更点推送（幂等最新值
 *   快照语义，§3.5）；无回放、Last-Event-ID 忽略（快照重取归 §3.6 批量端点）；
 * - 心跳 `: ping` 每 15s（可配）；连接超限 503 stream.server_busy + Retry-After: 5；
 * - 认证 = 普通 Bearer（EventSource 不能带头 → api-client fetch 流式封装，§10）；
 * - 指标 svc_sse_active_connections / svc_sse_push_total（§10 可观测）。
 */
import { Controller, Get, Inject, Query, Req, Res, UseGuards } from '@nestjs/common';
import type { Request, Response } from 'express';
import type { Logger as PinoLogger } from 'pino';
import { APP_CONFIG } from '../infrastructure/core.module.js';
import { LOGGER } from '../infrastructure/logger.js';
import { MetricsService } from '../infrastructure/metrics/metrics.service.js';
import type { AppConfig } from '../config.js';
import { ReasonCodeException } from '../infrastructure/errors/reason-code.exception.js';
import { CapabilitiesGuard } from '../auth/capabilities.guard.js';
import { CurrentAuth, type AuthContext } from '../auth/auth-context.js';
import { RequireCapabilities } from '../auth/require-capabilities.decorator.js';
import { TELEMETRY_STORE } from '../telemetry/telemetry.tokens.js';
import type { TelemetryStore } from '../telemetry/tsdb-read.repository.js';
import { TelemetryStoreUnavailableError } from '../telemetry/telemetry-store.error.js';
import { MonitorService } from './monitor.service.js';
import { actorOf, parsePointIdsCsv } from './monitor.controller.js';
import { diffChangedPoints, toSnapshotMap, type StreamPointSnapshot } from './run-state.js';

/** 每实例并发连接计数（platform §12：≤100；超限 503 + Retry-After）。 */
export class SseConnectionRegistry {
  private active = 0;

  constructor(private readonly maxConnections: number) {}

  tryAcquire(): boolean {
    if (this.active >= this.maxConnections) return false;
    this.active += 1;
    return true;
  }

  release(): void {
    this.active = Math.max(0, this.active - 1);
  }

  get activeCount(): number {
    return this.active;
  }
}

@Controller()
@UseGuards(CapabilitiesGuard)
export class StreamsController {
  private readonly registry: SseConnectionRegistry;
  private readonly logger: PinoLogger;
  private readonly sseConfig: AppConfig['sse'];

  constructor(
    @Inject(MonitorService) private readonly monitor: MonitorService,
    @Inject(TELEMETRY_STORE) private readonly store: TelemetryStore,
    @Inject(APP_CONFIG) config: AppConfig,
    @Inject(MetricsService) private readonly metrics: MetricsService,
    @Inject(LOGGER) rootLogger: PinoLogger,
  ) {
    this.sseConfig = config.sse;
    this.registry = new SseConnectionRegistry(config.sse.maxConnections);
    this.logger = rootLogger.child({ component: 'monitor-sse' });
  }

  @Get('streams/telemetry')
  @RequireCapabilities('monitor.read')
  async telemetryStream(
    @Query('point_ids') pointIdsRaw: string | undefined,
    @CurrentAuth() auth: AuthContext | undefined,
    @Req() req: Request,
    @Res() res: Response,
  ): Promise<void> {
    const pointIds = [...new Set(parsePointIdsCsv(pointIdsRaw))];
    // 可见性整单校验（platform §10：任一越界/不存在 → 400 point.not_found）
    await this.monitor.assertStreamPoints(actorOf(auth), pointIds);

    // 连接数门（§1.2 stream.server_busy：Retry-After 预设到 res，异常过滤器渲染信封时保留）
    if (!this.registry.tryAcquire()) {
      res.setHeader('Retry-After', '5');
      this.logger.warn({ msg: 'sse_server_busy', active: this.registry.activeCount });
      throw new ReasonCodeException('stream.server_busy', 'SSE 连接数已达实例上限，请稍后重试');
    }

    // 首帧前探一次存储——不可用在建流前显式 503（建流后错误只能断流，不能改状态码）
    let lastSent: Map<number, StreamPointSnapshot>;
    try {
      lastSent = toSnapshotMap(await this.store.latestBatch(pointIds));
    } catch (err: unknown) {
      this.registry.release();
      if (err instanceof TelemetryStoreUnavailableError) {
        throw new ReasonCodeException(
          'telemetry.store_unavailable',
          '遥测存储暂不可用（未配置或不可达）',
        );
      }
      throw err;
    }

    // ——— 200 建流（此后错误经日志 + 连接自愈语义，不再走异常过滤器）———
    this.metrics.sseConnectionOpened();
    res.status(200);
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('X-Accel-Buffering', 'no'); // 私有化 nginx 部署防缓冲（§10 工程约束）
    res.flushHeaders();

    let closed = false;
    const write = (chunk: string): void => {
      if (!closed && !res.writableEnded) res.write(chunk);
    };
    const pushEvent = (points: readonly StreamPointSnapshot[]): void => {
      write(`event: telemetry\ndata: ${JSON.stringify({ points })}\n\n`);
      this.metrics.ssePushed();
    };

    // 首帧 = 订阅集当前快照基线（幂等最新值；窗口内 diff 以此为起点）
    if (lastSent.size > 0) pushEvent([...lastSent.values()]);

    const heartbeat = setInterval(() => {
      write(': ping\n\n');
    }, this.sseConfig.heartbeatIntervalMs);
    const poll = async (): Promise<void> => {
      if (closed) return;
      try {
        const current = toSnapshotMap(await this.store.latestBatch(pointIds));
        const changed = diffChangedPoints(lastSent, current);
        lastSent = current;
        if (changed.length > 0) pushEvent(changed);
      } catch (err: unknown) {
        // 窗口级失败：跳过本窗不断流（连接内存态自愈；持续失败由客户端断流/重连兜底）
        this.logger.warn({
          msg: 'sse_poll_failed',
          err: err instanceof Error ? err.message : String(err),
        });
      }
    };
    const throttle = setInterval(() => {
      void poll();
    }, this.sseConfig.throttleWindowMs);

    const cleanup = (): void => {
      if (closed) return;
      closed = true;
      clearInterval(heartbeat);
      clearInterval(throttle);
      this.registry.release();
      this.metrics.sseConnectionClosed();
      res.end();
    };
    res.on('close', cleanup);
    req.on('close', cleanup);
  }
}
