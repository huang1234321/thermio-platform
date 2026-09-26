import { configFor } from '@thermio/eslint-config';

// FE 条文配套规则已启用（react-hooks exhaustive-deps = error，platform.md §4）
export default configFor('@thermio/admin', { react: true });
