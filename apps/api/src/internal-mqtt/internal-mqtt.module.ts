/**
 * EMQX 内部端点模块（emqx.md §3/§5/§7，IMPL-7）。
 *
 * 自包含接线：双角色 DB 池（thermio_auth 读 / thermio_api 租户写）、
 * argon2 校验器、失败限速、ServiceAuthGuard、reconciler。
 * 显式 @Inject token 纪律与 AppModule 相同（vitest/esbuild 无 design:paramtypes）。
 * 依赖注入自 @Global CoreModule（APP_CONFIG / LOGGER / MetricsService）。
 */
import { Module, type Provider } from '@nestjs/common';
import type { Logger as PinoLogger } from 'pino';
import type { AppConfig } from '../config.js';
import { APP_CONFIG, CoreModule } from '../infrastructure/core.module.js';
import { LOGGER } from '../infrastructure/logger.js';
import { MqttAuthenticateService } from './authenticate.service.js';
import { EmqxAdminClient, EMQX_ADMIN, type EmqxAdminPort } from './emqx-admin.client.js';
import { MqttEventsService } from './events.service.js';
import { GatewayStatusService } from './gateway-status.service.js';
import { InternalMqttDbPools } from './internal-mqtt-db-pools.js';
import { MqttInternalController } from './mqtt-internal.controller.js';
import { MqttReconcilerService } from './reconciler.service.js';
import {
  Argon2PasswordVerifier,
  PASSWORD_VERIFIER,
  type PasswordVerifierPort,
} from './password-verifier.js';
import {
  MQTT_AUTH_FAILURE_COUNTER,
  SlidingWindowFailureCounter,
  type MqttAuthFailureCounterPort,
} from './failure-counter.js';
import { AUTH_DB, TENANT_DB, type DbQueryPort, type TenantDbPort } from './db.js';
import { ServiceAuthGuard } from './service-auth.guard.js';

const INTERNAL_MQTT_POOLS = Symbol('INTERNAL_MQTT_POOLS');

/** 模块内固定接线（测试以 overrideProvider 替换 token，不动这里的形状）。 */
const INTERNAL_MQTT_PROVIDERS: Provider[] = [
  {
    provide: INTERNAL_MQTT_POOLS,
    useFactory: (config: AppConfig): InternalMqttDbPools => InternalMqttDbPools.fromConfig(config),
    inject: [APP_CONFIG],
  },
  {
    provide: AUTH_DB,
    useFactory: (pools: InternalMqttDbPools): DbQueryPort => pools.authPool.asQueryPort(),
    inject: [INTERNAL_MQTT_POOLS],
  },
  {
    provide: TENANT_DB,
    useFactory: (pools: InternalMqttDbPools): TenantDbPort => pools.platformPool.asTenantDb(),
    inject: [INTERNAL_MQTT_POOLS],
  },
  {
    provide: PASSWORD_VERIFIER,
    useFactory: (logger: PinoLogger): PasswordVerifierPort =>
      new Argon2PasswordVerifier(logger.child({ component: 'mqtt-password-verifier' })),
    inject: [LOGGER],
  },
  {
    provide: MQTT_AUTH_FAILURE_COUNTER,
    useFactory: (config: AppConfig, logger: PinoLogger): MqttAuthFailureCounterPort =>
      new SlidingWindowFailureCounter(
        config.MQTT_AUTH_FAIL_LIMIT,
        config.MQTT_AUTH_FAIL_WINDOW_MS,
        (username, peerhost) => {
          // 触顶信号（§3.3-6）：防爆破进行中——v1 留痕，IMPL-13 接告警域。
          logger.warn({ msg: 'mqtt_auth_failure_threshold_reached', username, peerhost });
        },
      ),
    inject: [APP_CONFIG, LOGGER],
  },
  {
    provide: EMQX_ADMIN,
    useFactory: (config: AppConfig): EmqxAdminPort => new EmqxAdminClient(config),
    inject: [APP_CONFIG],
  },
  GatewayStatusService,
  MqttAuthenticateService,
  MqttEventsService,
  MqttReconcilerService,
  ServiceAuthGuard,
];

@Module({
  imports: [CoreModule],
  controllers: [MqttInternalController],
  providers: [...INTERNAL_MQTT_PROVIDERS],
  // IMPL-13 接通（M4-alarm.md §5.1 通道①②）：告警引擎复用 AUTH_DB 旁路读
  // （质量事件 gateway_id → tenant 解析）并经 GatewayStatusService 注册离线信号 sink
  exports: [AUTH_DB, GatewayStatusService],
})
export class InternalMqttModule {}
