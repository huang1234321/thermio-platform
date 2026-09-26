// CI 门禁红灯演练样板（下一提交即回滚）——TS-01：禁 any（显式）+ noImplicitAny（隐式）
export const explicitAny: any = { drill: 'ci-gate-red-light' };

export function implicitAnyParam(value) {
  return value;
}
