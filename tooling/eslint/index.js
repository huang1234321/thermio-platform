/**
 * @thermio/eslint-config —— 共享 flat config（platform.md §4）。
 *
 * 每个包的 eslint.config.js 调 configFor('<包名>') 取回完整配置；
 * 依赖方向表集中在本文件，CI 即门禁（TS-03）。
 */
import importPlugin from 'eslint-plugin-import';
import reactHooks from 'eslint-plugin-react-hooks';
import prettierCompat from 'eslint-config-prettier';
import tseslint from 'typescript-eslint';

/** 仓内全部内部包名（apps + packages）。 */
const APPS = ['@thermio/api', '@thermio/admin', '@thermio/mobile', '@thermio/viz-2d'];
const PACKAGES = [
  '@thermio/shared-types',
  '@thermio/api-client',
  '@thermio/scene-schema',
  '@thermio/bind-core',
  '@thermio/ui',
];
const INTERNAL = [...APPS, ...PACKAGES];

/**
 * 依赖方向表（platform.md §2.2，箭头约定「X ← Y」= Y 可依赖 X）：
 * - apps/* → packages/* 全允许；apps 互引 = error；
 * - packages 之间仅允许 其余 ← shared-types、bind-core ← scene-schema；
 * - 任何包不得依赖 apps。
 */
const ALLOWED_INTERNAL_DEPS = {
  '@thermio/api': PACKAGES,
  '@thermio/admin': PACKAGES,
  '@thermio/mobile': PACKAGES,
  '@thermio/viz-2d': PACKAGES,
  '@thermio/shared-types': [],
  '@thermio/api-client': ['@thermio/shared-types'],
  '@thermio/scene-schema': ['@thermio/shared-types', '@thermio/bind-core'],
  '@thermio/bind-core': ['@thermio/shared-types'],
  '@thermio/ui': ['@thermio/shared-types'],
};

function boundaryPatterns(packageName) {
  const allowed = ALLOWED_INTERNAL_DEPS[packageName];
  if (!allowed) {
    throw new Error(
      `[eslint-config] 未知包名 ${packageName}：请把它登记进 ALLOWED_INTERNAL_DEPS（依赖方向表）。`,
    );
  }
  const forbidden = INTERNAL.filter((name) => name !== packageName && !allowed.includes(name));
  return [
    {
      group: forbidden.flatMap((name) => [name, `${name}/*`]),
      message: `依赖方向违规（TS-03 / platform.md §2.2）：${packageName} 不允许引用此包。`,
    },
  ];
}

/**
 * @param {string} packageName 当前包名（须在依赖方向表内）
 * @param {{ react?: boolean }} [options] react 包置 true：启用 FE 条文配套规则
 * （react-hooks exhaustive-deps = error，platform.md §4）
 */
export function configFor(packageName, { react = false } = {}) {
  return tseslint.config(
    {
      ignores: ['dist/**', 'coverage/**', '.turbo/**', 'eslint.config.js'],
    },
    {
      files: ['**/*.{ts,tsx}'],
      extends: tseslint.configs.strictTypeChecked,
      languageOptions: {
        parserOptions: {
          projectService: true,
        },
      },
      plugins: {
        import: importPlugin,
        ...(react ? { 'react-hooks': reactHooks } : {}),
      },
      settings: {
        'import/resolver': {
          typescript: { alwaysTryTypes: true },
        },
      },
      rules: {
        // TS-01：禁 any（显式）——边界未知数据一律 unknown + zod 收窄（TS-02）
        '@typescript-eslint/no-explicit-any': 'error',
        // 剔除字段再断言的测试写法（const { x, ...rest } = obj）不算未使用
        '@typescript-eslint/no-unused-vars': ['error', { ignoreRestSiblings: true }],
        // TS-02 的 lint 面：unsafe 家族显式置 error（strictTypeChecked 已含，此处钉死可见）
        '@typescript-eslint/no-unsafe-assignment': 'error',
        '@typescript-eslint/no-unsafe-call': 'error',
        '@typescript-eslint/no-unsafe-member-access': 'error',
        '@typescript-eslint/no-unsafe-return': 'error',
        '@typescript-eslint/no-unsafe-argument': 'error',
        // TS-04 双保险：直接引用的外部包必须声明进本包 package.json
        'import/no-extraneous-dependencies': ['error', { includeTypes: true }],
        // TS-03：循环依赖为构建错误
        'import/no-cycle': 'error',
        // TS-03 / platform.md §2.2：包边界单向
        'no-restricted-imports': ['error', { patterns: boundaryPatterns(packageName) }],
        ...(react
          ? {
              // FE 条文配套（platform.md §4）
              'react-hooks/rules-of-hooks': 'error',
              'react-hooks/exhaustive-deps': 'error',
            }
          : {}),
      },
    },
    {
      files: ['**/*.test.ts', '**/*.test.tsx'],
      rules: {
        // 测试文件允许引用 devDependencies（vitest 等）
        'import/no-extraneous-dependencies': [
          'error',
          { devDependencies: true, includeTypes: true },
        ],
      },
    },
    // 收尾：关闭所有与 Prettier 冲突的格式规则（只管格式不管质量）
    prettierCompat,
  );
}
