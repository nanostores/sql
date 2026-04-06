import sqlocal from 'sqlocal/vite'
import { defineConfig } from 'vite'

export default defineConfig({
  appType: 'spa',
  plugins: [sqlocal()]
})
