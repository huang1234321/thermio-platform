/**
 * M11 kpi 域 DI tokens（IMPL-22 / DAT-246；mv.tokens 同款纪律）。
 */
import type { InjectionToken } from '@nestjs/common';
import type { Pool } from 'pg';
import type { KpiTsdbStore } from './kpi-tsdb.repository.js';
import type { FddPdfRenderer } from './kpi-fdd-pdf.js';
import type { DigestMailer } from './kpi-mailer.js';

/** kpi 侧 TSDB 只读池（与 MvModule 的池同 URL 不同实例——故障域隔离，M9 同款）。 */
export const KPI_TSDB_POOL: InjectionToken<Pool | null> = Symbol('KPI_TSDB_POOL');

/** kpi 侧 TSDB 只读出口（telemetry_1h cagg 桶查询；停用形态 = null）。 */
export const KPI_TSDB: InjectionToken<KpiTsdbStore | null> = Symbol('KPI_TSDB');

/** fdd_report PDF 渲染器（puppeteer 实现；e2e 覆写为确定性 fake）。 */
export const KPI_PDF_RENDERER: InjectionToken<FddPdfRenderer> = Symbol('KPI_PDF_RENDERER');

/** 订阅投递 SMTP 客户端（nodemailer 实现；e2e 覆写为可控 fake）。 */
export const KPI_MAILER: InjectionToken<DigestMailer> = Symbol('KPI_MAILER');

/**
 * fdd 导出件目录（deploy.md v1.0.3：随载体落 M9 同一 mv-exports/ 私桶——同
 * config.MV_EXPORT_DIR 解析，token 按模块独立注入，MvModule 故障域互不影响）。
 */
export const KPI_EXPORT_DIR: InjectionToken<string> = Symbol('KPI_EXPORT_DIR');
