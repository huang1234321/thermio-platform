# thermio-platform

暖通（HVAC）节能系统中台 monorepo —— TypeScript 应用族（ADR-001 / ADR-010）。

- **apps**：api（NestJS，含 control-safety 仲裁层）/ admin（React）/ mobile（Expo/RN）/ viz-2d（原理图组态）/ viz-3d（3D 组态，后置）
- **packages**：shared-types（领域契约单一来源）/ api-client / scene-schema / bind-core / ui
- **tooling**：tsconfig / eslint / prettier 共享基线

> 架构与工程蓝本在伞仓 [thermio](https://github.com/huang1234321/thermio)：
> `docs/design/platform.md`（建仓蓝图）、`docs/architecture/ARCHITECTURE-ADR.md`、`docs/architecture/DATA-MODEL.md`。
