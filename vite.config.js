import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// base './' + HashRouter make the build portable to any GitHub Pages path
export default defineConfig({
  plugins: [react()],
  base: './',
})
