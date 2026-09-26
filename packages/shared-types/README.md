# @thermio/shared-types

领域契约**单一来源**（DATA-MODEL §6 / platform.md §5.3）：枚举常量 + zod schema，
TS 类型一律由 `z.infer` 推导，不双轨维护。与 FDD 规则库 key、Blender 资产命名规范共用一份枚举清单。

- 运行时依赖仅 `zod`（§5.3 单源校验链所需），除此零依赖；
- DB 侧 `text` + 应用层校验（不用 PG 原生 ENUM）；
- **新增枚举 = 发版动作**：改清单必须同步改 `enums.snapshot.test.ts` 快照，评审可见（§6.4 的 CI 面）。

## 显式不定义（留给兄弟设计定稿，platform.md §6.3 尾注）

`gateway.status` 全集（→ 伞仓 emqx.md）、`telemetry.quality` 位掩码（→ ingest.md）、
`alarm severity` 取值（告警域实现期）、`mv_baseline.method` 完整清单（M&V 实现期按 IPMVP 扩充）。

## 构建

`tsc -p tsconfig.build.json` → `dist/`（ESM + d.ts）。消费方经 workspace 链接使用。
