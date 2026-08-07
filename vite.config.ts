import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath, URL } from 'node:url';
import { readFileSync, writeFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

/**
 * Emits dist/sw.js with a precache manifest of everything the build produced,
 * so the game boots offline on the first repeat visit. Written by hand instead
 * of pulling in a Workbox toolchain — the whole policy is 120 readable lines.
 */
function tartanServiceWorker(): Plugin {
  let outDir = 'dist';
  return {
    name: 'tartan-service-worker',
    apply: 'build',
    configResolved(config) {
      outDir = config.build.outDir;
    },
    closeBundle() {
      const root = resolve(outDir);
      // A failed build never writes the directory; don't mask the real error.
      if (!existsSync(root)) return;
      const files: string[] = [];
      const walk = (dir: string) => {
        for (const entry of readdirSync(dir)) {
          const full = join(dir, entry);
          if (statSync(full).isDirectory()) walk(full);
          else files.push('/' + relative(root, full).split(/[\\/]/).join('/'));
        }
      };
      walk(root);

      const precache = files
        .filter((f) => !f.endsWith('.map') && f !== '/sw.js')
        // Icons beyond the two the manifest needs at install time are fetched
        // lazily; precaching every size wastes quota on low-storage devices.
        .filter((f) => !/\/icons\/(icon-512|maskable-512|social)\./.test(f));

      const template = readFileSync(resolve('scripts/sw-template.js'), 'utf8');
      const sw = template
        .replace('__VERSION__', String(Date.now()))
        .replace('__PRECACHE__', JSON.stringify(precache, null, 2));
      writeFileSync(join(root, 'sw.js'), sw);
      // eslint-disable-next-line no-console
      console.log(`\n  service worker: precaching ${precache.length} files`);
    },
  };
}

export default defineConfig({
  plugins: [react(), tartanServiceWorker()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  build: {
    target: 'es2019',
    minify: 'terser',
    terserOptions: {
      compress: { passes: 2, drop_console: true, drop_debugger: true },
    },
    cssCodeSplit: false,
    chunkSizeWarningLimit: 1400,
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes('node_modules/phaser')) return 'phaser';
          if (id.includes('node_modules/@supabase')) return 'supabase';
          if (id.includes('node_modules/react') || id.includes('node_modules/scheduler')) return 'react';
          return undefined;
        },
      },
    },
  },
  server: {
    host: true,
    port: 5173,
  },
});
