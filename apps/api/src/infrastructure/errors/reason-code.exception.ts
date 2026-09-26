/**
 * 领域错误载体（§5.1 / §5.2）：
 * - ReasonCodeException：携带种子表 reason_code 的业务异常，HTTP 状态取注册表；
 * - GateClampedResult：闸门 2「成功但被修正」的 2xx 载体——非异常（API-ERR-03 不适用，
 *   §5.2 注 *），控制器返回值经 GateClampedInterceptor 以 200 + 信封形状输出。
 *
 * message 由调用方给定（骨架期中文直书；走 locale 资源文件是 I18N-01 的后续动作）。
 * details 不得含堆栈/SQL/内部路径（API-ERR-04）。
 */
import { HttpException } from '@nestjs/common';
import { REASON_CODE_REGISTRY, type ReasonCode, type ReasonCodeMeta } from '@thermio/shared-types';

export class ReasonCodeException extends HttpException {
  readonly reasonCode: ReasonCode;
  readonly reasonMessage: string;
  readonly reasonDetails: Readonly<Record<string, unknown>> | undefined;
  readonly meta: ReasonCodeMeta;

  constructor(
    reasonCode: ReasonCode,
    message: string,
    details?: Readonly<Record<string, unknown>>,
  ) {
    const meta = REASON_CODE_REGISTRY[reasonCode];
    super({ reason_code: reasonCode, message }, meta.http);
    this.reasonCode = reasonCode;
    this.reasonMessage = message;
    this.reasonDetails = details;
    this.meta = meta;
  }
}

/** 闸门 2 夹紧结果（details 必带夹紧前后值，§5.2）。 */
export class GateClampedResult {
  constructor(readonly details: Readonly<Record<string, unknown>>) {}
}
