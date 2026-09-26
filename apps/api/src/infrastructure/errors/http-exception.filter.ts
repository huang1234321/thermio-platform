/**
 * NestJS 全局异常过滤器（platform.md §5.1，platform.md §8 #4）：捕获一切出口，
 * 错误响应统一信封 { error: { reason_code, message, request_id, details? } }。
 *
 * 分派顺序：
 * 1. ReasonCodeException —— 业务异常：注册表定状态码；闸门码联动
 *    thermio_gate_rejections_total{gate}（§5.2 与 ADR-017 咬合）；
 * 2. ZodError —— 控制器内直接 parse 的漏网：归一 common.validation_failed 422；
 * 3. 框架 HttpException —— 无显式 reason_code 的框架错误按状态归一：
 *    400/422 → common.validation_failed（畸形请求体即校验失败）；
 *    401 → auth.invalid_credentials；403 → auth.forbidden；
 *    404 → common.not_found（路由级 404 信封码）；5xx → common.internal_error（唯一 5xx 文案出口）；
 *    其余未映射 4xx → common.validation_failed + 原状态保留 + WARN 日志（骨架期可见）；
 * 4. 未知异常 —— common.internal_error 500：响应不泄露堆栈/SQL/内部路径（API-ERR-04），
 *    堆栈只进 ERROR 日志（CODE-LOG-02/04）。
 *
 * common.not_found 已随 DAT-119 / DAT-96 收尾增补进 shared-types 种子表（§5.2，
 * 17 → 18 码）：本过滤器不再持有本地占位常量，404 归一直接引用种子码，
 * 取值正确性由 ReasonCode 类型在编译期钉死。
 */
import {
  type ArgumentsHost,
  Catch,
  type ExceptionFilter,
  HttpException,
  Inject,
} from '@nestjs/common';
import type { ReasonCode } from '@thermio/shared-types';
import type { Logger } from 'pino';
import type { Response } from 'express';
import { ZodError } from 'zod';
import { childLogger, LOGGER } from '../logger.js';
import { MetricsService } from '../metrics/metrics.service.js';
import { getRequestContext } from '../request-context.js';
import { zodFieldIssues } from '../validation/zod-validation.pipe.js';
import { buildEnvelope } from './envelope.js';
import { ReasonCodeException } from './reason-code.exception.js';

/** 框架错误的状态码归一表（仅收录语义无歧义的条目；数值键与 HttpStatus 对齐）。 */
const FRAMEWORK_STATUS_TO_REASON_CODE: Readonly<Record<number, ReasonCode>> = {
  400: 'common.validation_failed',
  401: 'auth.invalid_credentials',
  403: 'auth.forbidden',
  404: 'common.not_found',
  422: 'common.validation_failed',
  500: 'common.internal_error',
};

function zodIssuesToDetails(error: ZodError): Record<string, string> {
  return zodFieldIssues(error);
}

/** Nest 框架异常体 { statusCode, message, error } 形状的窄化提取。 */
function extractFrameworkMessage(body: unknown): string | null {
  if (typeof body === 'object' && body !== null && 'message' in body) {
    const message = (body as { message?: unknown }).message;
    if (typeof message === 'string') return message;
  }
  return null;
}

@Catch()
export class HttpExceptionFilter implements ExceptionFilter {
  constructor(
    @Inject(LOGGER) private readonly rootLogger: Logger,
    @Inject(MetricsService) private readonly metrics: MetricsService,
  ) {}

  catch(exception: unknown, host: ArgumentsHost): void {
    const res = host.switchToHttp().getResponse<Response>();
    const logger = childLogger(this.rootLogger, getRequestContext());

    let status: number;
    let reasonCode: string;
    let message: string;
    let details: Readonly<Record<string, unknown>> | undefined;
    let logLevel: 'info' | 'warn' | 'error';
    const logExtra: Record<string, unknown> = {};

    if (exception instanceof ReasonCodeException) {
      status = exception.meta.http;
      reasonCode = exception.reasonCode;
      message = exception.reasonMessage;
      details = exception.reasonDetails;
      if (exception.meta.gate !== undefined) {
        this.metrics.recordGate(exception.meta.gate);
      }
      logLevel = status >= 500 ? 'error' : status === 429 || status === 503 ? 'warn' : 'info';
    } else if (exception instanceof ZodError) {
      status = 422;
      reasonCode = 'common.validation_failed';
      message = '请求体校验失败';
      details = zodIssuesToDetails(exception);
      logLevel = 'info';
    } else if (exception instanceof HttpException) {
      const frameworkStatus = exception.getStatus();
      status = frameworkStatus;
      const body = exception.getResponse();
      const frameworkMessage =
        typeof body === 'string' ? body : (extractFrameworkMessage(body) ?? exception.message);
      const mapped = FRAMEWORK_STATUS_TO_REASON_CODE[frameworkStatus];
      if (mapped !== undefined) {
        reasonCode = mapped;
        // §5.2 钉死 validation_failed=422：框架 400（畸形 JSON 等）归一到 422，
        // 状态语义与种子表一致（API-ERR-03）。
        if (frameworkStatus === 400) status = 422;
        logLevel = status >= 500 ? 'error' : 'info';
      } else {
        // 未映射框架状态：归一校验失败语义但保留原状态，WARN 留痕（骨架期不扩种子表）。
        reasonCode = 'common.validation_failed';
        logLevel = 'warn';
        logExtra.unmapped_framework_status = status;
      }
      message = frameworkMessage;
    } else {
      status = 500;
      reasonCode = 'common.internal_error';
      message = '服务内部错误，请稍后重试';
      logLevel = 'error';
      // 堆栈只进日志，不进响应（API-ERR-04）。
      logExtra.err = exception;
      logExtra.stack = exception instanceof Error ? exception.stack : undefined;
    }

    logger[logLevel]({ msg: 'http_error', status, ...logExtra, reason_code: reasonCode });
    res
      .status(status)
      .json(buildEnvelope({ reason_code: reasonCode, message, request_id: undefined, details }));
  }
}
