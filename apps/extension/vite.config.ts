import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
export default defineConfig({
  plugins:[react()],
  build:{
    rollupOptions:{
      input:{sidepanel:'sidepanel.html',background:'src/background/index.ts',offscreen:'offscreen.html'},
      output:{entryFileNames:(chunk)=>chunk.name==='background'?'background.js':'assets/[name]-[hash].js'}
    },
    outDir:'dist',emptyOutDir:true
  }
});
