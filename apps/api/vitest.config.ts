import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts', 'src/**/*.test.ts'],
    setupFiles: ['test/setup.ts'],
    // e2e 文件共享同一个一次性 PG 容器（seedWorld 会 TRUNCATE 重种）——
    // 并行文件会互相踩库；顺序执行换确定性（后续模块的 DB e2e 同受益）。
    fileParallelism: false,
  },
});
