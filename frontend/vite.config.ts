import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// In development the browser talks to Vite only; Vite forwards /api to the API server.
// Same origin means the session cookie just works and no CORS setup is needed.
const API_TARGET = process.env.API_TARGET ?? 'http://localhost:4200';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5174,
    strictPort: true,
    proxy: { '/api': { target: API_TARGET, changeOrigin: false } },
  },
});
