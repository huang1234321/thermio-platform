/**
 * @thermio/admin —— React + Ant Design Pro（Vite，ADR-010）。
 *
 * 骨架占位：Web 面随 IMPL-10+ 落地（认证/RBAC → 资产 → 遥测 → 告警 → 监控/组态 → 点表导入）。
 * 消费纪律：经 @thermio/api-client 取数，响应 safeParse 后使用；错误按 reason_code 分支，
 * 未知码走通用兜底（API-ERR-02，不白屏不崩溃）。
 */
export const ADMIN_SKELETON_MARKER = 'thermio-admin-skeleton' as const;
