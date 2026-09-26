/**
 * zod 校验管道（platform.md §5.3：接口入参过 zod pipe——TS-02 服务器面）。
 * 适用于请求体、查询串与路径参数（IMPL-12 起三类入口共用）。
 *
 * 校验失败 → common.validation_failed 422，details 带字段级错误（§5.2）；
 * 管道抛 ReasonCodeException，出口形状由全局过滤器统一，不再另行包错。
 */
import { type PipeTransform, Injectable } from '@nestjs/common';
import type { ZodError } from 'zod';
import type { z } from 'zod';
import { ReasonCodeException } from '../errors/reason-code.exception.js';

/** 字段级校验错误 → details 扁平映射（§5.2「details 带字段级错误」）。 */
export function zodFieldIssues(error: ZodError): Record<string, string> {
  return error.issues.reduce<Record<string, string>>((details, issue, index) => {
    const path =
      issue.path.map((segment) => String(segment)).join('.') || `(root_${String(index)})`;
    details[path] = issue.message;
    return details;
  }, {});
}

@Injectable()
export class ZodValidationPipe<T> implements PipeTransform<unknown, T> {
  constructor(private readonly schema: z.ZodType<T>) {}

  transform(value: unknown): T {
    const result = this.schema.safeParse(value);
    if (!result.success) {
      throw new ReasonCodeException(
        'common.validation_failed',
        '请求参数校验失败',
        zodFieldIssues(result.error),
      );
    }
    return result.data;
  }
}
