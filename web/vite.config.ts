import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  server: {
    host: '127.0.0.1',
    port: 5173,
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:4399',
        changeOrigin: false,
      },
    },
  },
  build: {
    // 构建产物直接落到后端 public/，由后端同源伺服
    outDir: '../public',
    emptyOutDir: true,
    // 后端 CSP 为 default-src 'self'：禁止 data: 内联，字体等一律走文件
    assetsInlineLimit: 0,
  },
})
