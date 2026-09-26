/**
 * PG 连接模块（IMPL-10，ddl.md §5.1 角色矩阵）：
 * - API_DB_POOL：thermio_api 角色连接（业务读写，每事务 SET LOCAL app.tenant_id——
 *   TenantDb 是唯一事务入口）；
 * - AUTH_DB_POOL：thermio_auth 角色连接（0004 迁移 internal_read 定向旁路，仅
 *   app_user SELECT——登录前无租户上下文，email→(tenant, password_hash) 解析的唯一出口，
 *   与 device_credential 旁路同构）；
 * - 环境变量未配置时池不创建（authEnabled=false，与 kafka 未接线同骨架期形态）；
 *   此时启动打 WARN，受保护端点的行为见 jwt-auth.guard（fail-closed）。
 */
import {
  Global,
  Inject,
  Injectable,
  Module,
  type OnApplicationShutdown,
  type Provider,
} from '@nestjs/common';
import type { Logger } from 'pino';
import type { AppConfig } from '../../config.js';
import { APP_CONFIG } from '../core.module.js';
import { childLogger, LOGGER } from '../logger.js';
import pg from 'pg';
import { API_DB_POOL, AUTH_DB_POOL, TENANT_DB } from './db.tokens.js';
import { TenantDb } from './tenant-db.js';

function createPool(url: string): pg.Pool | null {
  if (url.length === 0) return null;
  return new pg.Pool({ connectionString: url, max: 10 });
}

/** 池生命周期唯一持有者：优雅停机断开（enableShutdownHooks 已在 bootstrap 挂钩）。 */
@Injectable()
class DbPools implements OnApplicationShutdown {
  constructor(
    @Inject(API_DB_POOL) private readonly apiPool: pg.Pool | null,
    @Inject(AUTH_DB_POOL) private readonly authPool: pg.Pool | null,
  ) {}

  async onApplicationShutdown(): Promise<void> {
    await this.apiPool?.end();
    await this.authPool?.end();
  }
}

const DB_PROVIDERS: Provider[] = [
  {
    provide: API_DB_POOL,
    useFactory: (config: AppConfig): pg.Pool | null => createPool(config.PG_API_URL),
    inject: [APP_CONFIG],
  },
  {
    provide: AUTH_DB_POOL,
    useFactory: (config: AppConfig): pg.Pool | null => createPool(config.PG_AUTH_URL),
    inject: [APP_CONFIG],
  },
  {
    provide: TENANT_DB,
    useFactory: (pool: pg.Pool | null, config: AppConfig, rootLogger: Logger): TenantDb | null => {
      if (pool === null || !config.authEnabled) {
        childLogger(rootLogger, null).warn(
          '认证域未接线（PG_API_URL/PG_AUTH_URL/AUTH_JWT_SECRET 缺失）：认证/用户端点不可用，仅限本地开发骨架',
        );
        return null;
      }
      return new TenantDb(pool);
    },
    inject: [API_DB_POOL, APP_CONFIG, LOGGER],
  },
  DbPools,
];

@Global()
@Module({
  providers: [...DB_PROVIDERS],
  exports: [API_DB_POOL, AUTH_DB_POOL, TENANT_DB],
})
export class DbModule {}
