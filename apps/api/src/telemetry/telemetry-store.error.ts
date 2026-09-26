/**
 * 遥测存储不可用载体（IMPL-12 显式降级口径）：
 * TSDB 只读连接 / PG 点位档案未配置或不可达时抛出，由服务层归一
 * telemetry.store_unavailable 503——区别于程序缺陷的 500 兜底，
 * 客户端可按 503 做重试/降级展示（API-ERR-03 状态语义正确）。
 *
 * 连接类错误码集（pg / libpq）：网络不可达/超时/DNS、认证失败、库不存在、
 * 连接被服务端终止。其余 pg 错误（语法/权限漂移等）视为程序缺陷原样上抛 → 500。
 */
export class TelemetryStoreUnavailableError extends Error {
  /** 保留 Error.cause 通道（ES2022）：底层 pg 错误实例随行，不进响应体（API-ERR-04）。 */
  override readonly cause?: unknown;

  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = 'TelemetryStoreUnavailableError';
    this.cause = cause;
  }
}

/** pg 错误是否为连接类（不可用面）而非程序缺陷。 */
const PG_CONNECTIVITY_CODES = new Set([
  'ECONNREFUSED',
  'ETIMEDOUT',
  'ENOTFOUND',
  'EAI_AGAIN',
  'ECONNRESET',
  '28P01', // invalid_password
  '3D000', // invalid_catalog_name（库不存在）
  '57P03', // cannot_connect_now
  '08000', // connection_exception 族
  '08006', // connection_failure
  '08001', // sqlclient_unable_to_establish_sqlconnection
  '53300', // too_many_connections
]);

export function isPgConnectivityError(err: unknown): boolean {
  if (err === null || typeof err !== 'object') return false;
  const code = (err as { code?: unknown }).code;
  return typeof code === 'string' && PG_CONNECTIVITY_CODES.has(code);
}
