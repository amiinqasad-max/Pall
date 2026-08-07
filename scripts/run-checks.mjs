/**
 * Bundles and runs the projection regression checks.
 *
 * They live in TypeScript alongside the game so they import the real config,
 * generator and projector — a copy of the maths would drift from the code it is
 * meant to guard.
 */
import { build } from 'esbuild';
import { fileURLToPath, URL } from 'node:url';
import { execFileSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const out = join(mkdtempSync(join(tmpdir(), 'tartan-checks-')), 'checks.mjs');

await build({
  entryPoints: ['scripts/check-projection.ts'],
  bundle: true,
  platform: 'node',
  format: 'esm',
  outfile: out,
  alias: { '@': fileURLToPath(new URL('../src', import.meta.url)) },
  logLevel: 'error',
});

execFileSync(process.execPath, [out], { stdio: 'inherit' });
