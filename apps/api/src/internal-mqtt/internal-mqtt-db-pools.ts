/**
 * 内部端点双角色连接池的生命周期持有者（ddl.md §5.1）：
 * AUTH_DB_POOL = thermio_auth（旁路只读）、PLATFORM_DB_POOL = thermio_api（租户写）。
 * pg.Pool 惰性连接——dev 栈不配 DB 也能起服务（骨架期同 KAFKA_BROKERS 纪律）。
 * 关停时统一 end（Nest 对 provider 同样调用 OnApplicationShutdown）。
 */
import { Injectable, type OnApplicationShutdown } from '@nestjs/common';
import type { AppConfig } from '../config.js';
import { PgPoolHolder } from './db.js';

@Injectable()
export class InternalMqttDbPools implements OnApplicationShutdown {
  readonly authPool: PgPoolHolder;
  readonly platformPool: PgPoolHolder;

  constructor(authPool: PgPoolHolder, platformPool: PgPoolHolder) {
    this.authPool = authPool;
    this.platformPool = platformPool;
  }

  static fromConfig(config: AppConfig): InternalMqttDbPools {
    return new InternalMqttDbPools(
      new PgPoolHolder({
        host: config.AUTH_DB_HOST,
        port: config.AUTH_DB_PORT,
        database: config.AUTH_DB_NAME,
        user: config.AUTH_DB_USER,
        password: config.AUTH_DB_PASSWORD,
      }),
      new PgPoolHolder({
        host: config.PLATFORM_DB_HOST,
        port: config.PLATFORM_DB_PORT,
        database: config.PLATFORM_DB_NAME,
        user: config.PLATFORM_DB_USER,
        password: config.PLATFORM_DB_PASSWORD,
      }),
    );
  }

  async onApplicationShutdown(): Promise<void> {
    await Promise.allSettled([this.authPool.close(), this.platformPool.close()]);
  }
}
