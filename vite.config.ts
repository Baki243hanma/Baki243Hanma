import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { readdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Après le build, remplace les marqueurs du service worker par la liste exacte des fichiers
 * de l'application (précache) et un identifiant de version. Ainsi, un nouveau déploiement
 * invalide l'ancien cache et l'application reste utilisable hors ligne après une première visite.
 */
function serviceWorkerManifest(): Plugin {
  return {
    name: 'shopflow-sw-manifest',
    apply: 'build',
    closeBundle() {
      const dist = join(process.cwd(), 'dist');
      const swPath = join(dist, 'sw.js');
      if (!existsSync(swPath)) return;
      const assetsDir = join(dist, 'assets');
      const assets = existsSync(assetsDir)
        ? readdirSync(assetsDir).map((f) => `/assets/${f}`)
        : [];
      const shell = ['/', '/index.html', '/manifest.webmanifest', '/icons/icon-192.png', '/icons/icon-512.png', '/icons/apple-touch-icon.png'];
      const version = `${Date.now().toString(36)}`;
      const source = readFileSync(swPath, 'utf-8')
        .replace('__SW_VERSION__', version)
        .replace('__PRECACHE_ASSETS__', JSON.stringify([...shell, ...assets]));
      writeFileSync(swPath, source);
    },
  };
}

export default defineConfig({
  plugins: [react(), tailwindcss(), serviceWorkerManifest()],
  server: {
    host: '0.0.0.0',
    port: 5173,
    allowedHosts: true,
    proxy: {
      '/api': { target: 'http://localhost:3000', changeOrigin: true },
    },
  },
  preview: {
    host: '0.0.0.0',
    allowedHosts: true,
  },
  build: {
    target: 'es2020',
    sourcemap: false,
    chunkSizeWarningLimit: 900,
  },
});
