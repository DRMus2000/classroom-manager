import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * 开发用 Vite 配置。
 *
 * - `/api` 代理到本地后端（默认 3000），避免开发期跨域与 Cookie SameSite 问题。
 * - SSE（/api/v1/events）必须关闭代理缓冲，否则事件会被攒在缓冲区里不下发。
 *   这里用 ws:false + 关闭 compression 的方式表达；生产由 nginx 处理（见根目录 nginx.conf）。
 */
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: 'http://localhost:3000',
        changeOrigin: true,
        // 说明：http-proxy 默认不缓冲 text/event-stream，这里显式声明意图。
        configure: (proxy) => {
          proxy.on('proxyRes', (proxyRes) => {
            if (proxyRes.headers['content-type']?.includes('text/event-stream')) {
              proxyRes.headers['cache-control'] = 'no-cache, no-transform';
            }
          });
        },
      },
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: true,
    target: 'es2020',
  },
});
