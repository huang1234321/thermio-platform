/**
 * FDD admin 面模块（modules/M6-fdd.md §5，IMPL-16 切片 / DAT-212）。
 *
 * 六读端点 + 两写端点（review/ignore，fdd.write）；internal 写读面在
 * InternalFddModule（不在此模块——两套写路径字段集不相交，M6 §1）。
 * ignore 幂等复用 AssetModule 的 IdempotencyStore（M2 apply 同款，ADR-014 阶段 1）。
 */
import { Module } from '@nestjs/common';
import { AssetModule } from '../asset/asset.module.js';
import { FddController } from './fdd.controller.js';
import { FddService } from './fdd.service.js';

@Module({
  imports: [AssetModule],
  controllers: [FddController],
  providers: [FddService],
})
export class FddModule {}
