/**
 * M11 kpi 域模块组装（M11-kpi-dashboard.md §5/§6；IMPL-22 / DAT-246）。
 *
 * - KPI_TSDB：kpi 侧 TSDB 只读出口（telemetry_1h cagg 单查询面，ddl §5.4 tsdb_api
 *   授权恰好覆盖，零新增授权）。独立池实例（与 MvModule 的池同 URL 不同实例——
 *   查询形态不同（桶扫描 vs 日聚合），隔离池参数与故障域；停用形态调用即
 *   503 telemetry.store_unavailable 显式降级）；
 * - KPI_PDF_RENDERER：fdd_report 渲染引擎（puppeteer-core + FDD_PDF_CHROMIUM_PATH
 *   随镜像 Chromium；dev 无 Chromium → 不可用渲染器，导出 failed 可见可重试）；
 * - KPI_MAILER：SMTP 客户侧 relay（nodemailer；SMTP_HOST 空 → 停用形态）；
 * - KPI_EXPORT_DIR：fdd 导出件目录（= MV_EXPORT_DIR 同一 mv-exports/ 私桶锚，
 *   deploy.md v1.0.3 两引擎分列但私桶共用）；
 * - 周调度：KpiDigestService onModuleInit 起 60s 扫描（proposal expiry-sweeper
 *   同款；周一 08:00 后幂等补投）。
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
import { LOGGER } from '../infrastructure/logger.js';
import type { AppConfig } from '../config.js';
import { createReadPool } from '../telemetry/read-pools.js';
import { KpiTsdbRepository, type KpiTsdbStore } from './kpi-tsdb.repository.js';
import {
  KPI_EXPORT_DIR,
  KPI_MAILER,
  KPI_PDF_RENDERER,
  KPI_TSDB,
  KPI_TSDB_POOL,
} from './kpi.tokens.js';
import { puppeteerFddPdfRenderer, type FddPdfRenderer } from './kpi-fdd-pdf.js';
import { disabledDigestMailer, nodemailerDigestMailer, type DigestMailer } from './kpi-mailer.js';
import { KpiController } from './kpi.controller.js';
import { KpiService } from './kpi.service.js';
import { KpiExportService } from './kpi-export.service.js';
import { KpiDigestService } from './kpi-digest.service.js';
import { KpiMetrics } from './kpi.metrics.js';

const KPI_LOGGER: InjectionToken<PinoLogger> = Symbol('KPI_LOGGER');

@Injectable()
class KpiGateway implements OnApplicationShutdown {
  constructor(
    @Inject(KPI_TSDB_POOL) private readonly pool: Pool | null,
    @Inject(KPI_LOGGER) private readonly logger: PinoLogger,
  ) {}

  async onApplicationShutdown(): Promise<void> {
    await this.pool?.end();
    this.logger.info({ msg: 'kpi_tsdb_pool_closed' });
  }
}

@Module({
  controllers: [KpiController],
  providers: [
    {
      provide: KPI_LOGGER,
      useFactory: (logger: PinoLogger): PinoLogger => logger.child({ component: 'kpi-module' }),
      inject: [LOGGER],
    },
    {
      provide: KPI_TSDB_POOL,
      useFactory: (config: AppConfig): Pool | null =>
        config.tsdbReadEnabled
          ? createReadPool({
              url: config.TSDB_READ_URL,
              max: 4,
              appName: 'thermio-api/kpi-read',
            })
          : null,
      inject: [APP_CONFIG],
    },
    {
      provide: KPI_TSDB,
      useFactory: (pool: Pool | null, logger: PinoLogger): KpiTsdbStore | null =>
        pool !== null
          ? new KpiTsdbRepository(pool, logger.child({ component: 'kpi-tsdb', pool: 'readonly' }))
          : null,
      inject: [KPI_TSDB_POOL, KPI_LOGGER],
    },
    {
      provide: KPI_PDF_RENDERER,
      useFactory: (config: AppConfig, logger: PinoLogger): FddPdfRenderer =>
        config.fddPdfEnabled
          ? puppeteerFddPdfRenderer(config.FDD_PDF_CHROMIUM_PATH, logger)
          : unavailableRenderer(logger),
      inject: [APP_CONFIG, KPI_LOGGER],
    },
    {
      provide: KPI_MAILER,
      useFactory: (config: AppConfig, logger: PinoLogger): DigestMailer =>
        config.smtpEnabled
          ? nodemailerDigestMailer(
              {
                host: config.SMTP_HOST,
                port: config.SMTP_PORT,
                user: config.SMTP_USER,
                pass: config.SMTP_PASS,
                from: config.SMTP_FROM,
              },
              logger,
            )
          : disabledDigestMailer('SMTP 未配置（SMTP_HOST 为空，RUNBOOK §5.1）'),
      inject: [APP_CONFIG, KPI_LOGGER],
    },
    {
      provide: KPI_EXPORT_DIR,
      useFactory: (config: AppConfig): string => path.resolve(config.MV_EXPORT_DIR),
      inject: [APP_CONFIG],
    },
    KpiMetrics,
    KpiService,
    KpiExportService,
    KpiDigestService,
    KpiGateway,
  ],
})
export class KpiModule {}

/** 渲染器停用形态（dev 无 Chromium）：调用即抛 → 导出任务 failed 可见可重试。 */
function unavailableRenderer(logger: PinoLogger): FddPdfRenderer {
  return {
    render(): Promise<Uint8Array> {
      logger.warn({ msg: 'kpi_pdf_renderer_unavailable', hint: 'FDD_PDF_CHROMIUM_PATH 未配置' });
      return Promise.reject(
        new Error('FDD PDF 渲染器不可用（Chromium 路径未配置，deploy.md §5 M11 行）'),
      );
    },
  };
}
