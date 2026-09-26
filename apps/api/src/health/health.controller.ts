/**
 * /healthz 存活探针（platform.md §8 #4：健康端点）。
 *
 * 骨架期只报进程存活，不探测 Kafka/DB 依赖（依赖就绪探针随对应接线落地，
 * 且 kafka 停用是合法形态，不能让存活探针翻红）。不进 /api/v1 前缀。
 */
import { Controller, Get } from '@nestjs/common';
import { Public } from '../auth/public.decorator.js';

@Public()
@Controller('healthz')
export class HealthController {
  @Get()
  health(): { status: string; svc: string } {
    return { status: 'ok', svc: 'thermio-api' };
  }
}
