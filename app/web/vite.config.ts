import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// CoolScaler React frontend. The release bundle goes to build/ and is served
// by the dashboard-api component, which also proxies /api/* to the recommender.
export default defineConfig({
  plugins: [react()],
  build: {
    outDir: 'build',
    assetsDir: 'static',
  },
  server: {
    port: 3000,
    host: true, // listen on IPv4+IPv6 so both localhost and 127.0.0.1 work
    proxy: {
      // Develop against a running backend: `kubectl port-forward svc/coolscaler-dashboards 8088:8080`.
      '/api': {
        target: 'http://localhost:8088',
        changeOrigin: true,
        secure: false,
      },
    },
  },
});
