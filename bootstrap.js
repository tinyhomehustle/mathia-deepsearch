import { existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const root = dirname(fileURLToPath(import.meta.url));
const cacheDir = join(root, 'node_modules', '.cache', 'puppeteer');
// Keep the runtime and installer on one path, independent of Render environment settings.
process.env.PUPPETEER_CACHE_DIR = cacheDir;
mkdirSync(cacheDir, { recursive: true });

// Render must see a listening HTTP port before a potentially slow Chrome download.
await import('./server.js');
console.log('[DeepSearch] HTTP server initialized; checking Chromium in background.');

async function installChrome() {
  const { default: puppeteer } = await import('puppeteer');
  const executable = puppeteer.executablePath();
  if (existsSync(executable)) {
    console.log('[DeepSearch] Chrome ready:', executable);
    return;
  }
  console.log('[DeepSearch] Chrome missing; starting background installation:', executable);
  const cli = join(root, 'node_modules', '@puppeteer', 'browsers', 'lib', 'cjs', 'main-cli.js');
  await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cli, 'install', 'chrome', '--path', cacheDir], {
      cwd: root, env: process.env, stdio: 'inherit'
    });
    child.on('error', reject);
    child.on('close', code => code === 0 ? resolve() : reject(new Error(`Chrome installer exited ${code}`)));
  });
  if (!existsSync(executable)) throw new Error(`Chrome not found after installation: ${executable}`);
  console.log('[DeepSearch] Chrome installed and ready:', executable);
}

void installChrome().catch(error => {
  console.error('[DeepSearch] Chrome installation failed:', error.stack || error.message);
  console.error('[DeepSearch] HTTP server remains online; browser sessions may be unavailable.');
});
