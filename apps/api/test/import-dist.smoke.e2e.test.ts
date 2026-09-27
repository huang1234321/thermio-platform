/**
 * 编译产物（dist）冒烟——真实 Node 运行时上传→解析闭环（QA 阻塞 #1 回归钉）。
 *
 * 背景：exceljs@4 为 CJS，动态 import 的命名空间在**编译产物**运行时只有 default
 * （vitest 的 CJS interop 会合成命名导出，src 面测试探测不到 interop 缺陷——
 * PR #19 曾因此全绿合入而 dist 五步流第 1→2 步全断）。本冒烟从 `node dist/main.js`
 * 起服走一次真实 multipart 上传，断言解析完成信号（row_count>0，§5.3）——
 * 任何「测试绿 / 产物红」的 interop 缺陷在此暴露。
 *
 * 门：PG e2e 环境齐备 **且** dist/main.js 存在（本地未 build 时跳过；
 * CI 在 api-e2e 工作流显式 build 后运行——见 workflow build 步骤）。
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import ExcelJS from 'exceljs';
import pg from 'pg';
import type { ImportJob, LoginResponse } from '@thermio/shared-types';
import {
  E2E_ADMIN_URL,
  E2E_API_URL,
  E2E_AUTH_URL,
  E2E_JWT_SECRET,
  E2E_READY,
  PASSWORDS,
  seedWorld,
  type SeededWorld,
} from './e2e-env.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const DIST_MAIN = path.resolve(here, '../dist/main.js');
const SMOKE_PORT = 8098;
const BASE = `http://127.0.0.1:${String(SMOKE_PORT)}`;

const distReady = E2E_READY && existsSync(DIST_MAIN);
const skipped = distReady ? describe : describe.skip;

let child: ChildProcess | null = null;
let world: SeededWorld;
let gatewayId: string;

/** dist 产物启动（停用形态：MQTT/Kafka/TSDB 不设 → dev 降级，同 QA 复现口径）。 */
async function bootDistApi(): Promise<void> {
  child = spawn(process.execPath, [DIST_MAIN], {
    cwd: path.resolve(here, '..'),
    env: {
      ...process.env,
      PORT: String(SMOKE_PORT),
      PG_API_URL: E2E_API_URL,
      PG_AUTH_URL: E2E_AUTH_URL,
      AUTH_JWT_SECRET: E2E_JWT_SECRET,
      AUTH_LOGIN_RATE_LIMIT: '50/300',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  // 兜底清杀：vitest 钩子被超时中止时 afterAll 可能不执行——进程级退出钩子保证
  // 子进程不泄漏（泄漏实例会占死 SMOKE_PORT，使后续冒烟轮次假失败）
  const spawned = child;
  const hardKill = (): void => {
    spawned.kill('SIGKILL');
  };
  process.once('exit', hardKill);
  spawned.once('exit', () => {
    process.removeListener('exit', hardKill);
  });
  const deadline = Date.now() + 30_000;
  for (;;) {
    const response = await fetch(`${BASE}/healthz`).catch(() => null);
    if (response !== null && response.ok) return;
    if (Date.now() > deadline) throw new Error('dist api 30s 未就绪');
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
}

async function smokeWorkbook(): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('点表');
  sheet.addRow(['点号', '描述', '单位', '方向']);
  sheet.addRow(['CHWS_T_1F', '冷冻水供水温度', '℃', '只读']);
  sheet.addRow(['PUMP_PWR', '水泵功率', 'kW', 'ro']);
  sheet.addRow(['PUMP_RUN', '水泵运行状态', '', 'read']);
  sheet.addRow(['TANK_LVL_SET', '水箱液位设定', 'm', '写']);
  return Buffer.from(await workbook.xlsx.writeBuffer());
}

skipped('dist 冒烟：编译产物真实上传→解析闭环（QA 阻塞 #1 回归）', () => {
  beforeAll(async () => {
    world = await seedWorld();
    const pool = new pg.Pool({ connectionString: E2E_ADMIN_URL, max: 1 });
    try {
      const gateway = await pool.query<{ id: string }>(
        `INSERT INTO gateway (tenant_id, building_id, name, serial, mqtt_client_id, status)
         VALUES ($1, $2, '冒烟网关', 'DT118SMOKE', 'gw-DT118SMOKE', 'online') RETURNING id`,
        [world.tenantA, world.buildingA1],
      );
      const gatewayRow = gateway.rows[0];
      if (gatewayRow === undefined) throw new Error('冒烟网关种子未返回行');
      gatewayId = gatewayRow.id;
    } finally {
      await pool.end();
    }
    await bootDistApi();
  }, 60_000);

  afterAll(async () => {
    const proc = child;
    if (proc !== null) {
      proc.kill('SIGTERM');
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          proc.kill('SIGKILL');
          resolve();
        }, 5_000);
        proc.once('exit', () => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
  });

  it('shouldParseUploadedWorkbook_inCompiledDistRuntime', async () => {
    // 登录（真实 HTTP 面，非 supertest 内嵌栈）
    const login = await fetch(`${BASE}/api/v1/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'admin-a@dt113.test', password: PASSWORDS.admin }),
    });
    expect(login.status).toBe(200);
    const token = ((await login.json()) as LoginResponse).access_token;

    // multipart 上传（Node 原生 FormData/Blob——与 supertest 不同的另一条传输面）
    const form = new FormData();
    const workbookBytes = await smokeWorkbook();
    form.append('file', new Blob([new Uint8Array(workbookBytes)]), 'smoke-point-table.xlsx');
    form.append('building_id', world.buildingA1);
    form.append('gateway_id', gatewayId);
    const upload = await fetch(`${BASE}/api/v1/imports`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}` },
      body: form,
    });
    expect(upload.status).toBe(202);
    const job = (await upload.json()) as ImportJob;
    expect(job.status).toBe('parsed');
    expect(job.row_count).toBe(0);

    // 解析完成信号（§5.3）：row_count>0；修复前 dist 形态必为 failed(sheet_corrupt)
    const deadline = Date.now() + 10_000;
    let current = job;
    for (;;) {
      if (current.row_count > 0 || current.status === 'failed') break;
      if (Date.now() > deadline) break;
      await new Promise((resolve) => setTimeout(resolve, 200));
      const polled = await fetch(`${BASE}/api/v1/imports/${job.id}`, {
        headers: { authorization: `Bearer ${token}` },
      });
      current = (await polled.json()) as ImportJob;
    }
    expect(current.status).toBe('parsed');
    expect(current.failure).toBeNull();
    expect(current.row_count).toBe(4);
  }, 30_000);
});
