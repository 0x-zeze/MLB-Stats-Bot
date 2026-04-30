import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const apiPort = process.env.DASHBOARD_API_PORT || '8010';
const webPort = Number(process.env.DASHBOARD_WEB_PORT || 5173);

export default defineConfig({
  plugins: [react()],
  build: {
    chunkSizeWarningLimit: 650,
    rollupOptions: {
      output: {
        manualChunks: {
          charts: ['recharts'],
          vendor: ['react', 'react-dom'],
        },
      },
    },
  },
  server: {
    host: '0.0.0.0',
    port: webPort,
    proxy: {
      '/api': {
        target: `http://127.0.0.1:${apiPort}`,
        changeOrigin: true,
        configure: (proxy) => {
          proxy.on('proxyReq', (proxyReq, req) => {
            const authorization = req.headers.authorization;
            if (authorization) proxyReq.setHeader('authorization', authorization);
          });
        },
      },
      '/health': `http://127.0.0.1:${apiPort}`,
    },
  },
});
