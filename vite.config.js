import { defineConfig } from 'vite';
import basicSsl from '@vitejs/plugin-basic-ssl';

// HTTPS для теста на телефоне по Wi-Fi (иначе часть API браузера ограничена).
// Сертификат self-signed генерируется плагином basic-ssl;
// на телефоне браузер покажет предупреждение — нужно нажать «Продолжить».
// Отключить: HTTPS=0 npm run dev
const useHttps = process.env.HTTPS !== '0';

// Конфигурация Vite для Shoot'n'cats 3D
// base: './' — чтобы сборка работала и в корне домена, и в подпапке GitHub Pages
export default defineConfig({
  base: './',
  plugins: useHttps ? [basicSsl()] : [],
  server: {
    host: true,          // слушать все интерфейсы — нужно для теста с телефона по Wi-Fi
    port: 5173,
    strictPort: false,
    https: useHttps
  },
  preview: {
    host: true,
    port: 4173,
    https: useHttps
  },
  build: {
    outDir: 'dist',
    assetsDir: 'assets',
    sourcemap: false,
    chunkSizeWarningLimit: 2000,
    rollupOptions: {
      output: {
        // Отдельные чанки — чтобы браузер кешировал three/rapier отдельно от игрового кода
        manualChunks(id) {
          if (id.includes('node_modules/three')) return 'three';
          if (id.includes('rapier3d')) return 'rapier';
          return undefined;
        }
      }
    }
  }
});
