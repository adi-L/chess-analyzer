import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    // Default 3000, matching the server's own default. Overridable together with
    // the server's PORT so both sides stay in agreement on a machine where 3000
    // is already taken.
    proxy: { '/api': `http://localhost:${process.env.PORT || 3000}` },
  },
});
