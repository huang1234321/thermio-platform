/**
 * 遥测查询模块（IMPL-12 / DAT-115）：GET /points/{id}/latest 与
 * GET /points/{id}/telemetry。
 *
 * 接线形态（复用 KafkaModule 的停用纪律）：
 * - TSDB_READ_URL / PG_URL 任一未设置 → 对应仓储为停用形态（调用即
 *   TelemetryStoreUnavailableError → 503 telemetry.store_unavailable 显式降级），
 *   服务本体照常起（本地无栈可跑其余端点与测试）；
 * - TelemetryGateway 是两池唯一生命周期持有者（优雅停机 end），与
 *   TsdbReadRepository/PointLookupService 的工厂解耦——仓储只拿池实例。
 * api→TSDB 只读边界（DATA-MODEL §2）：本模块不出现任何非 SELECT 出口。
 */
import {
  Inject,
  type InjectionToken,
  Injectable,
  Module,
  type OnApplicationShutdown,
  type OnModuleInit,
} from '@nestjs/common';
import type { Logger as PinoLogger } from 'pino';
import type { Pool } from 'pg';
import type { AppConfig } from '../config.js';
import { APP_CONFIG } from '../infrastructure/core.module.js';
import { LOGGER } from '../infrastructure/logger.js';
import {
  PointLookupService,
  disabledPointRegistry,
  type PointRegistry,
} from './point-lookup.service.js';
import { PG_READ_APP_NAME, TSDB_READ_APP_NAME, createReadPool } from './read-pools.js';
import {
  TsdbReadRepository,
  disabledTelemetryStore,
  type TelemetryStore,
} from './tsdb-read.repository.js';
import { POINT_REGISTRY, TELEMETRY_STORE } from './telemetry.tokens.js';
import { TelemetryController } from './telemetry.controller.js';
import { TelemetryService } from './telemetry.service.js';

const TSDB_READ_POOL: InjectionToken<Pool | null> = Symbol('TSDB_READ_POOL');
const PG_LOOKUP_POOL: InjectionToken<Pool | null> = Symbol('PG_LOOKUP_POOL');
const TELEMETRY_LOGGER: InjectionToken<PinoLogger> = Symbol('TELEMETRY_LOGGER');

@Injectable()
class TelemetryGateway implements OnModuleInit, OnApplicationShutdown {
  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(TSDB_READ_POOL) private readonly tsdbPool: Pool | null,
    @Inject(PG_LOOKUP_POOL) private readonly pgPool: Pool | null,
    @Inject(TELEMETRY_LOGGER) private readonly logger: PinoLogger,
  ) {}

  onModuleInit(): void {
    // 只读连接形态留痕（ADR-005 read replica 纪律 dev 形态：单实例即「replica 位」）
    this.logger.info({
      msg: 'telemetry_module_state',
      tsdb_read: this.config.tsdbReadEnabled ? 'enabled' : 'disabled',
      pg_lookup: this.config.pgLookupEnabled ? 'enabled' : 'disabled',
      hint: 'set TSDB_READ_URL / PG_URL (+PG_TENANT_ID) to enable',
    });
  }

  async onApplicationShutdown(): Promise<void> {
    await Promise.allSettled([this.tsdbPool?.end(), this.pgPool?.end()]);
    this.logger.info({ msg: 'telemetry_pools_closed' });
  }
}

@Module({
  controllers: [TelemetryController],
  providers: [
    {
      provide: TELEMETRY_LOGGER,
      useFactory: (logger: PinoLogger): PinoLogger => logger.child({ component: 'telemetry' }),
      inject: [LOGGER],
    },
    {
      provide: TSDB_READ_POOL,
      useFactory: (config: AppConfig): Pool | null =>
        config.tsdbReadEnabled
          ? createReadPool({
              url: config.TSDB_READ_URL,
              max: config.TSDB_READ_POOL_MAX,
              appName: TSDB_READ_APP_NAME,
            })
          : null,
      inject: [APP_CONFIG],
    },
    {
      provide: PG_LOOKUP_POOL,
      useFactory: (config: AppConfig): Pool | null =>
        config.pgLookupEnabled
          ? createReadPool({
              url: config.PG_URL,
              max: config.PG_POOL_MAX,
              appName: PG_READ_APP_NAME,
            })
          : null,
      inject: [APP_CONFIG],
    },
    {
      provide: TELEMETRY_STORE,
      useFactory: (pool: Pool | null, logger: PinoLogger): TelemetryStore =>
        pool !== null
          ? new TsdbReadRepository(pool, logger.child({ component: 'tsdb-read', pool: 'readonly' }))
          : disabledTelemetryStore('TSDB 只读连接未配置（TSDB_READ_URL 为空）'),
      inject: [TSDB_READ_POOL, TELEMETRY_LOGGER],
    },
    {
      provide: POINT_REGISTRY,
      useFactory: (pool: Pool | null, config: AppConfig, logger: PinoLogger): PointRegistry =>
        pool !== null
          ? new PointLookupService(
              pool,
              config.PG_TENANT_ID,
              logger.child({ component: 'pg-lookup', pool: 'readonly' }),
            )
          : disabledPointRegistry('PG 点位档案连接未配置（PG_URL 为空）'),
      inject: [PG_LOOKUP_POOL, APP_CONFIG, TELEMETRY_LOGGER],
    },
    TelemetryService,
    TelemetryGateway,
  ],
})
export class TelemetryModule {}
