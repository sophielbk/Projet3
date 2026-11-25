import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// L'app est servie à la racine par le gateway, qui proxifie /api/* vers les services.
export default defineConfig({
  plugins: [react()],
  base: '/',
  build: { outDir: 'dist' },
});
