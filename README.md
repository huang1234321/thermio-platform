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

## 蓝本与规范

架构与工程蓝本在伞仓 [thermio](https://github.com/huang1234321/thermio)：

- `docs/design/platform.md` —— 本仓建仓蓝图（目录结构 / TS 基线 / lint 门禁 / 枚举清单）
- `docs/architecture/ARCHITECTURE-ADR.md` —— ADR-001 命名、ADR-008 提案结构、ADR-010 monorepo、ADR-016 语言边界等
- `docs/architecture/DATA-MODEL.md` —— 枚举取值唯一来源（§3/§6）
- `docs/conventions/company/` —— TS / API / 测试 / 流程规范（编号如 TS-01、API-ERR-01、FLOW-GIT-01）

建仓红灯演练记录见 [docs/drill-records.md](docs/drill-records.md)。
