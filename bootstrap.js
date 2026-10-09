import { existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = dirname(fileURLToPath(import.meta.url));
const cacheDir = join(root, 'node_modules', '.cache', 'puppeteer');
// Keep the browser inside node_modules so Render includes it with deployed dependencies.
process.env.PUPPETEER_CACHE_DIR = cacheDir;
mkdirSync(cacheDir, { recursive: true });
const { default: puppeteer } = await import('puppeteer');

function browserInstalled() {
  try { return existsSync(puppeteer.executablePath()); } catch { return false; }
}

if (!browserInstalled()) {
  console.log('[DeepSearch] Chrome missing at runtime; installing in deployment directory...');
  const cli = join(root, 'node_modules', '@puppeteer', 'browsers', 'lib', 'cjs', 'main-cli.js');
  const result = spawnSync(process.execPath, [cli, 'install', 'chrome', '--path', cacheDir], {
    cwd: root, env: process.env, stdio: 'inherit', timeout: 180_000
  });
  if (result.error || result.status !== 0) {
    console.error('[DeepSearch] Chrome install failed:', result.error?.message || `exit ${result.status}`);
    process.exit(1);
  }
}
if (!browserInstalled()) {
  console.error('[DeepSearch] Chrome still missing after install. Expected:', puppeteer.executablePath());
  process.exit(1);
}
console.log('[DeepSearch] Chrome found:', puppeteer.executablePath());
await import('./server.js');
