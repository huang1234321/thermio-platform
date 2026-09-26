# 建仓红灯演练记录（IMPL-1 / DAT-95 验收项）

蓝本：platform.md §8 #2（样板写 `any` → lint/typecheck 红灯，演练后删除，记录进 PR）与
#7（CI 门禁红灯演练一次并留记录）。演练日期：2026-09-26。

## 演练 1：本地 lint / typecheck 红灯

样板文件 `apps/api/src/red.light.drill.ts`（演练后已删除）：

```ts
export const explicitAny: any = { drill: 'explicit-any' };

export function implicitAnyParam(value) {
  return value;
}
```

`turbo run lint --filter=@thermio/api`（exit 1）：

```
apps/api/src/red.light.drill.ts
  2:27  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
  5:3   error  Unsafe return of a value of type `any`    @typescript-eslint/no-unsafe-return

✖ 2 problems (2 errors, 0 warnings)
Failed:    @thermio/api#lint
```

`turbo run typecheck --filter=@thermio/api`（exit 1）：

```
@thermio/api:typecheck: src/red.light.drill.ts(4,34): error TS7006: Parameter 'value' implicitly has an 'any' type.
Failed:    @thermio/api#typecheck
```

结论：显式 `any` 被 `no-explicit-any`（TS-01 lint 面）拦截，隐式 `any` 被
`noImplicitAny`（TS-01 编译器面）拦截，双通道红灯成立。删除样板后
`turbo run lint typecheck test` 20/20 任务全绿。

## 演练 2：CI 门禁红灯（PR #1 上实跑）

| 步骤               | 提交                | Actions run                                                                              | 结果               |
| ------------------ | ------------------- | ---------------------------------------------------------------------------------------- | ------------------ |
| 基线（门禁先证绿） | `2e44055`           | [36225995636](https://github.com/huang1234321/thermio-platform/actions/runs/36225995636) | ✅ pass（28s）     |
| 推入 any 样板      | `dea5ffe`           | [36226037678](https://github.com/huang1234321/thermio-platform/actions/runs/36226037678) | ❌ **fail（20s）** |
| 回滚样板           | `addb7ab`（revert） | [36226077880](https://github.com/huang1234321/thermio-platform/actions/runs/36226077880) | ✅ pass（29s）     |

红灯 run 的失败日志（`--log-failed` 摘录，lint 与 typecheck 双双拦截）：

```
##[error]src/red.light.drill.ts(4,34): error TS7006: Parameter 'value' implicitly has an 'any' type.
##[error]  2:27  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
##[error]  5:3   error  Unsafe return of a value of type `any`    @typescript-eslint/no-unsafe-return
✖ 2 problems (2 errors, 0 warnings)
##[error]command …/apps/api … pnpm run typecheck exited (2)
```

结论：CI 门禁对 `any` 真实红灯、阻断合并；样板已随 revert 提交删除，PR 历史保留全程可查。

## 附注

- pre-commit 只跑 format（lint-staged + prettier，platform.md §4「本地快、门禁严」），
  演练样板因此能进入远端——正是靠 CI 门禁拦截，链路与设计一致；
- 快照纪律：改枚举必须显式改 `packages/shared-types/src/enums.snapshot.test.ts` 快照，
  本 PR 的首版快照随建仓落盘（13 例测试全绿）。
