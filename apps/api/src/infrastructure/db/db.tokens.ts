/**
 * PG 连接 DI token（独立文件：db.module 与 tenant-db 互不 import，破 ESM 循环——
 * Node 原生 ESM 下 module.ts ⇄ tenant-db.ts 的符号互引会 TDZ 崩，vitest 加载器
 * 掩盖了该问题，dist/main.js 实跑才暴露）。
 */
import type { InjectionToken } from '@nestjs/common';
import pg from 'pg';
import type { TenantDb } from './tenant-db.js';

export const API_DB_POOL: InjectionToken<pg.Pool> = Symbol('API_DB_POOL');
export const AUTH_DB_POOL: InjectionToken<pg.Pool> = Symbol('AUTH_DB_POOL');
export const TENANT_DB: InjectionToken<TenantDb> = Symbol('TENANT_DB');
