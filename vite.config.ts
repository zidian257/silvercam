import { defineConfig } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const r = (p: string) => path.resolve(path.dirname(fileURLToPath(import.meta.url)), p);

// MPA：dash/inbox/studio/fits 各自独立入口，首屏只带自己的代码；
// 产物输出到 web/dist，由 server 以 /app/ 前缀静态伺服（页面路由在 web/dist 存在时优先用构建产物）
export default defineConfig({
  root: r('web/src'),
  base: '/app/',
  plugins: [svelte()],
  build: {
    outDir: r('web/dist'),
    emptyOutDir: true,
    rollupOptions: {
      input: {
        dash: r('web/src/pages/dash/index.html'),
        inbox: r('web/src/pages/inbox/index.html'),
        studio: r('web/src/pages/studio/index.html'),
        fits: r('web/src/pages/fits/index.html'),
      },
    },
  },
});
