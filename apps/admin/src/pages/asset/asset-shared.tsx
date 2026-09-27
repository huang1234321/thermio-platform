/**
 * 资产页面共享件（M1-asset §7）：错误文案 + 能力判定。
 * 布局/三态/键盘规范继承 ui/baseline（§2–§4）不重述；antd 组件面与 settings-users 同源。
 */
import { useCapabilities } from '../../app/auth-context.js';
import { ApiError } from '../../app/api-client.js';
import type { Capability } from '@thermio/shared-types';

export function errorText(cause: unknown, fallback: string): string {
  return cause instanceof ApiError ? cause.parsed.message : fallback;
}

/** 当前会话是否持有某能力（SEC-AZ-05：UI 只看 /me 下发的 capabilities）。 */
export function useHasCapability(capability: Capability): boolean {
  return useCapabilities().includes(capability);
}
