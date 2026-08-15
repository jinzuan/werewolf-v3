import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tsconfigPaths from "vite-tsconfig-paths";

// https://vite.dev/config/
export default defineConfig({
  build: {
    sourcemap: 'hidden',
    chunkSizeWarningLimit: 500,
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (!id.includes('node_modules')) return undefined;
          if (id.includes('/react/') || id.includes('/react-dom/') || id.includes('/scheduler/')) return 'react-vendor';
          if (id.includes('/react-router') || id.includes('/@remix-run/')) return 'router-vendor';
          if (id.includes('/socket.io') || id.includes('/engine.io')) return 'socket-vendor';
          if (id.includes('/lucide-react/')) return 'icons-vendor';
          if (id.includes('/zustand/')) return 'state-vendor';
          return undefined;
        },
      },
    },
  },
  server: {
    proxy: {
      '/api/lm-studio': {
        target: 'http://localhost:1234',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api\/lm-studio/, ''),
      },
    },
  },
  plugins: [
    react({
      babel: {
        plugins: [
          'react-dev-locator',
        ],
      },
    }),
    tsconfigPaths()
  ],
})
