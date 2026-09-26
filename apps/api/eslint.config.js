import { configFor } from '@thermio/eslint-config';

export default [
  ...configFor('@thermio/api'),
  {
    // Nest 装饰器空类（@Module 壳）是该框架的惯用形——放行带装饰器的空类。
    rules: {
      '@typescript-eslint/no-extraneous-class': ['error', { allowWithDecorator: true }],
    },
  },
  {
    files: ['test/**/*.test.ts'],
    rules: {
      // supertest/superagent 的 Response.body 与 getHttpServer() 均为 any 形类型（上游如此），
      // unsafe-* 家族在 e2e 边界必然误报。断言面仍走 zod 收窄（ApiErrorEnvelopeSchema.parse），
      // 仅测试文件放宽这六条；src 保持全严。
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-argument': 'off',
      '@typescript-eslint/no-unsafe-call': 'off',
      '@typescript-eslint/no-unsafe-return': 'off',
    },
  },
];
