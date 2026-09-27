/** 导入域 DI tokens（M2-import；IMPL-15 / DAT-118）。 */
import type { InjectionToken } from '@nestjs/common';
import type { DownChannel } from './down-channel.publisher.js';

export const DOWN_CHANNEL: InjectionToken<DownChannel> = Symbol('DOWN_CHANNEL');
