# thermio-platform

暖通（HVAC）节能系统中台 monorepo —— TypeScript 应用族（ADR-001 / ADR-010）。

## 结构

```
apps/
  api/        NestJS：BFF + 业务域 + control-safety 仲裁层（IMPL-2 起实现）
  admin/      React + Ant Design Pro（Vite）
  mobile/     Expo / React Native —— 骨架先行，功能二期（附录 A：APP 二期）
  viz-2d/     2D 原理图组态（SVG + bind-core）—— MVP 可视化形态（ADR-013）
  viz-3d/     3D 组态（react-three-fiber）—— 优先级后置，仅 README 占位
packages/
  shared-types/   领域契约单一来源：枚举常量 + zod schema（★本仓核心资产）
  api-client/     OpenAPI 生成 TS SDK + 响应校验封装（IMPL-5 起实现）
  scene-schema/   组态场景配置类型
  bind-core/      绑定引擎（point_id ↔ 节点属性）
  ui/             共享组件
tooling/
  tsconfig/   strict 全开基线 + 各变体（TS-01）
  eslint/     共享 flat config + 依赖方向门禁（TS-03/TS-04）
  prettier/   共享格式配置
```

依赖方向（TS-03，lint 钉死）：`apps/* → packages/*`；packages 之间仅允许
`shared-types ← 其余`、`bind-core ← scene-schema`；任何包不得依赖 apps。

## 工具链

| 项         | 选型                                                          |
| ---------- | ------------------------------------------------------------- |
| 包管理     | pnpm ≥10（`packageManager` 钉死；workspace 隔离杜绝幽灵依赖） |
| 构建编排   | turborepo（build / lint / typecheck / test 任务图）           |
| TypeScript | ~5.9 单一版本（pnpm catalog 统一）                            |
| Node       | 22 LTS（`engines` + `engine-strict`）                         |
| 校验       | ESLint flat config（typescript-eslint `strictTypeChecked`）   |
| 格式化     | Prettier（pre-commit 只跑 format，lint-staged）               |

## 快速开始

```bash
corepack enable            # 激活 packageManager 钉死的 pnpm
pnpm install
pnpm lint && pnpm typecheck && pnpm test   # 或：pnpm exec turbo run lint typecheck test
```

## api 骨架（IMPL-2 / DAT-96）

`apps/api` 已落 NestJS 骨架（platform.md §5 + §8 #4）：全局异常过滤器错误信封
（`reason_code / message / request_id / details`，§5.1）、zod validation pipe（§5.3）、
pino 结构化日志（统一字段 `tenant_id / building_id / point_id / trace_id`，§7）、
prom-client 指标（`svc_http_request_duration_ms` / `thermio_gate_rejections_total{gate}` /
`thermio_proposal_decisions_total{decision}`，§7）、kafkajs 两 topic 接线
（`thermio.control.proposal` 生产 / `thermio.control.executed` 消费，trace_id header 纪律）。

reason_code 首版种子表（17 码）与 modules/overview 设计码映射表在
`packages/shared-types/src/reason-codes.ts`（§5.2 治理：改表 = 发版，快照钉死）。

```bash
# 本地起服务（默认 :8080；/healthz 与 /metrics 在 /api/v1 前缀之外）
pnpm --filter @thermio/api build && pnpm --filter @thermio/api start

# 对接 dev 栈（伞仓 deploy/docker-compose.dev.yml 独立栈，禁止复用宿主既有服务）：
# Kafka EXTERNAL listener 已映射宿主 localhost:9092
KAFKA_BROKERS=localhost:9092 pnpm --filter @thermio/api start

# 环境变量：PORT（默认 8080）/ LOG_LEVEL（info）/ KAFKA_BROKERS（空 = kafka 停用，
# 服务可起可测）/ KAFKA_CLIENT_ID / KAFKA_CONSUMER_GROUP_ID
```

## 蓝本与规范

架构与工程蓝本在伞仓 [thermio](https://github.com/huang1234321/thermio)：

- `docs/design/platform.md` —— 本仓建仓蓝图（目录结构 / TS 基线 / lint 门禁 / 枚举清单）
- `docs/architecture/ARCHITECTURE-ADR.md` —— ADR-001 命名、ADR-008 提案结构、ADR-010 monorepo、ADR-016 语言边界等
- `docs/architecture/DATA-MODEL.md` —— 枚举取值唯一来源（§3/§6）
- `docs/conventions/company/` —— TS / API / 测试 / 流程规范（编号如 TS-01、API-ERR-01、FLOW-GIT-01）

建仓红灯演练记录见 [docs/drill-records.md](docs/drill-records.md)。
