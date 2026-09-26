/**
 * 遥测模块 DI token（DI 纪律同 app.module：显式 token，vitest/esbuild 与
 * 运行时同一套解析路径；e2e 以 token 覆写真/假仓储）。
 */
import type { InjectionToken } from '@nestjs/common';
import type { PointRegistry } from './point-lookup.service.js';
import type { TelemetryStore } from './tsdb-read.repository.js';

export const TELEMETRY_STORE: InjectionToken<TelemetryStore> = Symbol('TELEMETRY_STORE');
export const POINT_REGISTRY: InjectionToken<PointRegistry> = Symbol('POINT_REGISTRY');
