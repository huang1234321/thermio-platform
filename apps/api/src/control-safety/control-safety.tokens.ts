/**
 * control-safety 模块 DI tokens（独立文件防 ESM 循环，沿 db.tokens.ts 先例）。
 */
import type { InjectionToken } from '@nestjs/common';
import type { ControlChannel } from './control-channel.js';

export const CONTROL_CHANNEL: InjectionToken<ControlChannel> = Symbol('CONTROL_CHANNEL');
