## 变更说明

<!-- 改了什么、为什么；关联任务/蓝本章节（platform.md / ADR / DATA-MODEL） -->

## 自查清单

- [ ] `turbo run lint typecheck test` 本地全绿
- [ ] 枚举如有变更：确认为发版动作（DATA-MODEL §6 治理），快照 `enums.snapshot.test.ts` 已同步显式更新，并同步 DATA-MODEL 示例
- [ ] reason_code 如有新增：走 PR 流程新增，不改既有语义（platform.md §5.2 / API-CT-05）
- [ ] 依赖方向未破坏：apps → packages；packages 之间仅 shared-types ← 其余、bind-core ← scene-schema；无循环依赖（TS-03）
- [ ] 无显式/隐式 any，无 as any 逃生（TS-01）；边界未知数据 unknown + zod 收窄（TS-02）
- [ ] 新增外部依赖已声明进所在包 package.json（TS-04，无幽灵依赖）
- [ ] 涉及 API 契约的端点已带畸形响应测试（platform.md §5.4）
