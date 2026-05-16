import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { createRequire } from 'module'

const require = createRequire(import.meta.url)
const katexVersion: string = require('katex/package.json').version

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  base: './',
  build: {
    outDir: 'dist',
  },
  define: {
    // KaTeX ESM 包依赖构建工具注入此变量
    __VERSION__: JSON.stringify(katexVersion),
  },
})
