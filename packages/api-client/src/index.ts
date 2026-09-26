/**
 * @thermio/api-client —— OpenAPI 生成的 TS SDK + 响应校验封装（platform.md §5.3）。
 *
 * 骨架占位：生成链（zod → OpenAPI → openapi-typescript）在 platform.md §8 #5 落地；
 * 建成后消费方（admin / mobile / viz）响应一律 safeParse 后使用，失败走宽松回退（API-CT-01/03）。
 */
export type { SystemType } from '@thermio/shared-types';
