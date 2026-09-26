# 遥测查询基准记录（IMPL-12 / DAT-115，验收要点 3）

大跨度查询延迟 + 写路径影响，单楼量级（ADR-014 点位上界 5,000）。复现入口：

```bash
# repo 根执行；需兄弟 checkout thermio-ingest（TSDB 迁移链唯一来源）与本地 docker
apps/api/bench/bench-telemetry-read.sh [SEED_POINTS]   # 默认 5000；冒烟可传 500
```

脚本一次性起 `timescale/timescaledb:2.17.2-pg16` 容器（`thermio-bench-tsdb`，
127.0.0.1:55433，跑完即毁，环境隔离纪律），DDL 逐文件取自 thermio-ingest
`db/migrations/tsdb/`（0001–0004），先 bootstrap 三角色（ddl.md §10）后迁移。
度量取服务器端 `EXPLAIN (ANALYZE, TIMING OFF)` 的 Execution Time（p50/p95，
不含连接噪声）；查询与 `apps/api/src/telemetry/telemetry-sql.ts` 同形。

## 数据形态

| 集        | 规模                                 | 说明                                                                         |
| --------- | ------------------------------------ | ---------------------------------------------------------------------------- |
| 单楼一天  | 5,000 点 × 1,440 分钟 = 7,200,000 行 | 点 9000001–9005000，值确定性变化防常量折叠                                   |
| 长历史    | 1 点 × 730 天 = 1,051,200 行         | bench 点 9900001，混入 quality=4 / value_text 行                             |
| cagg 物化 | 5min ≈ 1.65M 桶、1h ≈ 138k 桶        | `refresh_continuous_aggregate` 全量（策略 job start_offset 5d 盖不住历史窗） |

## 记录（2026-09-26，docker 28.3.2 / macOS 宿主，tsdb_api 只读角色执行读集）

| 场景                                          | p50        | p95        | n   |
| --------------------------------------------- | ---------- | ---------- | --- |
| Q1 latest（单点最新一行）                     | 0.4 ms     | 0.5 ms     | 20  |
| Q2 raw 31d（原始层跨度上限窗，limit 201）     | 0.1 ms     | 0.2 ms     | 20  |
| Q3 5min 730d（cagg 跨度上限窗，limit 201）    | 0.7 ms     | 0.8 ms     | 20  |
| Q4 1h 3650d 请求窗（730d 数据）               | 0.3 ms     | 0.3 ms     | 20  |
| W 写路径基线（ingest 形态 100 点批量 upsert） | 1.5 ms     | 1.8 ms     | 60  |
| **W 写路径 × Q3 读并发**                      | **1.6 ms** | **2.1 ms** | 60  |
| Q3 × W 写并发                                 | 0.8 ms     | 1.0 ms     | 60  |

## 结论

- **写路径不受大跨度读影响**：100 点批量 upsert 在 Q3（730d cagg 上限窗）持续
  并发下 p50 持平（1.5→1.6 ms），p95 变化 +0.3 ms（1.8→2.1 ms，单并发噪声量级）；
- 读侧上限窗全部毫秒级：PK (point_id, ts) 前缀上的 ChunkAppend 反向/正向扫描，
  LIMIT 201 截断使代价与窗长解耦（游标分页下每页成本恒定）；
- 执行计划形状符合路由预期：raw → `Custom Scan (ChunkAppend) on telemetry`
  （hypertable），5min → `... on _materialized_hypertable_*`（cagg 物化表，
  不扫原始）；
- cagg 默认 real-time 聚合：近窗（策略 end_offset 1h 内）由原始表现场合并，
  为 ddl.md §11.2 声明的默认行为，读入口仍为 cagg 视图。

已知边界：宿主为开发笔记本（容器无独立 I/O 隔离），绝对值仅供量级参考；
生产 replica 形态（IMPL-20 prod compose）落地后按同脚本复测。
