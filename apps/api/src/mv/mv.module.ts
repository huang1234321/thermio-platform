/**
 * M&V 模块组装（M9-mv-report.md；IMPL-21 / DAT-242）。
 *
 * - MV_TSDB：M&V 侧 TSDB 只读出口（telemetry_1h cagg + weather_actual 双查询，
 *   ddl §5.4 tsdb_api 授权面恰好覆盖，零新增授权）。独立池实例（与 TelemetryModule
 *   的 TSDB 池同 URL 不同实例——查询形态不同（聚合扫描 vs 点查），隔离池参数与
 *   故障域；停用形态调用即 503 telemetry.store_unavailable 显式降级）；
 * - 生成/导出执行器：api 进程内 setImmediate 异步（§5 归属定夺，M2 同族）；
 * - MV_EXPORT_DIR：导出件目录（默认 ./mv-exports，R7 私桶锚本地形态）。
 */
import {
  Inject,
  type InjectionToken,
  Injectable,
  Module,
  type OnApplicationShutdown,
} from '@nestjs/common';
import type { Logger as PinoLogger } from 'pino';
import type { Pool } from 'pg';
import path from 'node:path';
import { APP_CONFIG } from '../infrastructure/core.module.js';
import { AssetModule } from '../asset/asset.module.js';
import { LOGGER } from '../infrastructure/logger.js';
import type { AppConfig } from '../config.js';
import { createReadPool } from '../telemetry/read-pools.js';
import { MvTsdbRepository, type MvTsdbStore } from './mv-tsdb.repository.js';
import { MV_EXPORT_DIR, MV_TSDB } from './mv.tokens.js';
import { MvController } from './mv.controller.js';
import { MvService } from './mv.service.js';
import { MvGenerateService } from './mv-generate.service.js';
import { MvExportService } from './mv-export.service.js';
import { MvMetrics } from './mv.metrics.js';

const MV_TSDB_POOL: InjectionToken<Pool | null> = Symbol('MV_TSDB_POOL');
const MV_LOGGER: InjectionToken<PinoLogger> = Symbol('MV_LOGGER');

@Injectable()
class MvGateway implements OnApplicationShutdown {
  constructor(
    @Inject(MV_TSDB_POOL) private readonly pool: Pool | null,
    @Inject(MV_LOGGER) private readonly logger: PinoLogger,
  ) {}

  async onApplicationShutdown(): Promise<void> {
    await this.pool?.end();
    this.logger.info({ msg: 'mv_tsdb_pool_closed' });
  }
}

@Module({
  imports: [AssetModule], // IdempotencyStore（generate/export 幂等，fdd/import 同款）
  controllers: [MvController],
  providers: [
    {
      provide: MV_LOGGER,
      useFactory: (logger: PinoLogger): PinoLogger => logger.child({ component: 'mv' }),
      inject: [LOGGER],
    },
    {
      provide: MV_TSDB_POOL,
      useFactory: (config: AppConfig): Pool | null =>
        config.tsdbReadEnabled
          ? createReadPool({
              url: config.TSDB_READ_URL,
              max: 4,
              appName: 'thermio-api/mv-read',
            })
          : null,
      inject: [APP_CONFIG],
    },
    {
      provide: MV_TSDB,
      useFactory: (pool: Pool | null, logger: PinoLogger): MvTsdbStore | null =>
        pool !== null
          ? new MvTsdbRepository(pool, logger.child({ component: 'mv-tsdb', pool: 'readonly' }))
          : null,
      inject: [MV_TSDB_POOL, MV_LOGGER],
    },
    {
      provide: MV_EXPORT_DIR,
      useFactory: (config: AppConfig): string => path.resolve(config.MV_EXPORT_DIR),
      inject: [APP_CONFIG],
    },
    MvMetrics,
    MvService,
    MvGenerateService,
    MvExportService,
    MvGateway,
  ],
})
export class MvModule {}
