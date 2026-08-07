/**
 * Builds TARTAN as one self-contained HTML fragment.
 *
 * Everything — CSS, the app, React, Phaser — is inlined into a single file with
 * no external requests, so it can be dropped anywhere (an artifact host, a
 * file:// URL, an email attachment) and still run. The normal `npm run build`
 * remains the real deployment path; this exists purely for sharing a playable
 * build without a server.
 */
import { build } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath, URL } from 'node:url';
import { readFileSync, writeFileSync, mkdtempSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

const outDir = mkdtempSync(join(tmpdir(), 'tartan-standalone-'));
const target = process.argv[2] ?? resolve('tartan-standalone.html');

await build({
  configFile: false,
  root: resolve('.'),
  plugins: [react()],
  resolve: {
    alias: { '@': fileURLToPath(new URL('../src', import.meta.url)) },
  },
  define: {
    // No server, so no service worker to register.
    __TARTAN_STANDALONE__: 'true',
  },
  build: {
    outDir,
    emptyOutDir: true,
    target: 'es2019',
    minify: 'terser',
    terserOptions: { compress: { passes: 2, drop_console: true } },
    cssCodeSplit: false,
    assetsInlineLimit: 100_000_000,
    rollupOptions: {
      // One chunk: dynamic imports are resolved at build time so the page needs
      // no network at all.
      output: { inlineDynamicImports: true, entryFileNames: 'app.js' },
    },
  },
});

const produced = [];
const walk = (dir) => {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walk(full);
    else produced.push(full);
  }
};
walk(outDir);

const jsFile = produced.find((f) => f.endsWith('.js'));
const cssFile = produced.find((f) => f.endsWith('.css'));
if (!jsFile) throw new Error(`no js bundle produced; got: ${produced.join(', ')}`);

const js = readFileSync(jsFile, 'utf8');
const css = cssFile ? readFileSync(cssFile, 'utf8') : '';

// The host wraps this in <!doctype html><head></head><body>, so emit page
// content only — no <html>, <head> or <body> tags of our own.
const html = `<title>TARTAN — Endless Arcade Runner</title>
<style>
:root { color-scheme: dark; }
* { box-sizing: border-box; }
html, body {
  margin: 0; padding: 0; height: 100%; overflow: hidden;
  background: #08131a; color: #f8fafc;
  font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
  -webkit-font-smoothing: antialiased; -webkit-tap-highlight-color: transparent;
  overscroll-behavior: none; touch-action: none;
}
#root { height: 100%; width: 100%; }
#boot {
  position: fixed; inset: 0; display: flex; flex-direction: column;
  align-items: center; justify-content: center; gap: 22px;
  background: radial-gradient(120% 80% at 50% 0%, #0f766e33 0%, transparent 60%), #08131a;
  z-index: 999; transition: opacity .45s ease;
}
#boot.gone { opacity: 0; pointer-events: none; }
#boot .mark {
  font-size: 13vw; font-weight: 800; letter-spacing: .32em; text-indent: .32em;
  background: linear-gradient(180deg,#fff 0%,#99f6e4 55%,#0f766e 100%);
  -webkit-background-clip: text; background-clip: text; color: transparent;
}
@media (min-width: 520px) { #boot .mark { font-size: 68px; } }
#boot .bar { width: 148px; height: 3px; border-radius: 99px; background: #ffffff1a; overflow: hidden; }
#boot .bar i {
  display: block; height: 100%; width: 40%; border-radius: 99px;
  background: linear-gradient(90deg,#0f766e,#f59e0b); animation: sweep 1.1s ease-in-out infinite;
}
@keyframes sweep { 0% { transform: translateX(-120%); } 100% { transform: translateX(320%); } }
${css}
</style>
<div id="root"></div>
<div id="boot"><div class="mark">TARTAN</div><div class="bar"><i></i></div></div>
<script type="module">
${js}
</script>
`;

writeFileSync(target, html);
const mb = (Buffer.byteLength(html) / 1048576).toFixed(2);
console.log(`\n  standalone build: ${target} (${mb} MB)`);
