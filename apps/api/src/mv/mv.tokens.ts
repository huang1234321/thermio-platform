/**
 * M&V 模块 DI token（DI 纪律同 app.module：显式 token，vitest/esbuild 与
 * 运行时同一套解析路径；e2e 以 token 覆写真/假仓储）。
 */
import type { InjectionToken } from '@nestjs/common';
import type { MvTsdbStore } from './mv-tsdb.repository.js';

export const MV_TSDB: InjectionToken<MvTsdbStore | null> = Symbol('MV_TSDB');
export const MV_EXPORT_DIR: InjectionToken<string> = Symbol('MV_EXPORT_DIR');
