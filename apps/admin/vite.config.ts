/**
 * Vite 构建 + vitest 单测环境。
 * dev 代理 /api → 本地 api（8080，bootstrap.ts 默认端口）；生产由部署侧网关拼前缀。
 */
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      '/api': {
        target: 'http://localhost:8080',
        changeOrigin: false,
      },
    },
  },
  test: {
    environment: 'jsdom',
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
  },
});
