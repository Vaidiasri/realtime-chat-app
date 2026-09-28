import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

// Dev keeps one origin: the API and socket are proxied, so cookies behave as in production.
// Keep changeOrigin off: the auth Origin check compares Origin with the Host this proxy forwards.
// Use the object form: Vite's string shorthand turns changeOrigin on.
export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    proxy: {
      '/api': { target: 'http://localhost:3000' },
      '/socket.io': { target: 'http://localhost:3000', ws: true },
    },
  },
});
