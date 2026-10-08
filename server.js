import http from 'node:http';
import dns from 'node:dns/promises';
import net from 'node:net';
import { readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import puppeteer from 'puppeteer';
import { WebSocketServer, WebSocket } from 'ws';

const ROOT = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 10000);
const MAX_SESSIONS = Math.max(1, Math.min(3, Number(process.env.MAX_BROWSER_SESSIONS || 1)));
const SESSION_IDLE_MS = 4 * 60_000;
const MAX_JSON_BYTES = 8_192;
const MAX_FETCH_BYTES = 1_500_000;
const NAV_TIMEOUT_MS = 19_000;
const FETCH_TIMEOUT_MS = 12_000;
const RATE_WINDOW_MS = 60_000;
const MAX_REQUESTS = 100;
const ALLOWED_ORIGINS = new Set([
  'https://mathia.online', 'https://www.mathia.online',
  'https://mathiagang.netlify.app', 'https://deepsearch.mathia.online',
  'http://localhost:3000', 'http://127.0.0.1:3000'
]);
const clients = new Map();
const sessions = new Map();
const hostCache = new Map();
let browserPromise = null;
let browserInstance = null;
let fetchRunning = 0;
let sessionStarting = 0;

function json(res, status, data, headers = {}) {
  const body = Buffer.from(JSON.stringify(data));
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8',
    'content-length': body.length, 'cache-control': 'no-store',
    'x-content-type-options': 'nosniff', ...headers });
  res.end(body);
}
function cors(req) {
  const origin = req.headers.origin;
  return origin && ALLOWED_ORIGINS.has(origin)
    ? { 'access-control-allow-origin': origin, 'vary': 'Origin',
        'access-control-allow-methods': 'GET, POST, DELETE, OPTIONS',
        'access-control-allow-headers': 'Content-Type, X-DeepSearch-Token' } : {};
}
function ipOf(req) {
  // Render is expected to overwrite X-Forwarded-For with its trusted client IP.
  // This is a resource limit, not an authentication identity.
  return (String(req.headers['x-forwarded-for'] || '').split(',')[0].trim()
    || req.socket.remoteAddress || 'unknown').slice(0, 100);
}
function rate(req) {
  const now = Date.now(); const ip = ipOf(req);
  let value = clients.get(ip);
  if (!value || now - value.since >= RATE_WINDOW_MS) value = { since: now, n: 0 };
  value.n++; clients.set(ip, value);
  return value.n <= MAX_REQUESTS;
}
function blockedIp(ip) {
  const v = net.isIP(ip);
  if (v === 4) {
    const [a,b,c] = ip.split('.').map(Number);
    return a === 0 || a === 10 || a === 127 || a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && (b === 0 || b === 168 || (b === 88 && c === 99))) ||
      (a === 198 && (b === 18 || b === 19)) ||
      (a === 192 && b === 0 && c === 2) ||
      (a === 198 && b === 51 && c === 100) ||
      (a === 203 && b === 0 && c === 113);
  }
  if (v === 6) {
    const s = ip.toLowerCase().replace(/\[|\]/g, '');
    if (s.startsWith('::ffff:')) {
      const mapped = s.slice(7);
      if (net.isIP(mapped) === 4) return blockedIp(mapped);
    }
    return s === '::' || s === '::1' || s.startsWith('fc') || s.startsWith('fd') ||
      /^fe[89ab]/.test(s) || s.startsWith('ff') ||
      s.startsWith('2001:db8:') || !/^[23]/.test(s);
  }
  return true;
}
async function assertPublicUrl(raw) {
  let u;
  try { u = new URL(String(raw)); } catch { throw new Error('Enter a valid web address.'); }
  if (!['http:', 'https:'].includes(u.protocol) || u.username || u.password)
    throw new Error('Only public HTTP/HTTPS addresses are allowed.');
  const hostname = u.hostname.toLowerCase().replace(/\.$/, '');
  if (hostname === 'localhost' || hostname.endsWith('.localhost') ||
    hostname.endsWith('.local') || hostname.endsWith('.internal') ||
    hostname.endsWith('.onion') || hostname.endsWith('.test'))
    throw new Error('That address is not public.');
  if (net.isIP(hostname)) {
    if (blockedIp(hostname)) throw new Error('Private or reserved addresses are blocked.');
  } else {
    let cached = hostCache.get(hostname);
    if (!cached || cached.until < Date.now()) {
      const addresses = await dns.lookup(hostname, { all: true, verbatim: true });
      if (!addresses.length || addresses.some(a => blockedIp(a.address)))
        throw new Error('Private or reserved addresses are blocked.');
      cached = { until: Date.now() + 12_000 };
      if (hostCache.size > 1000) hostCache.clear();
      hostCache.set(hostname, cached);
    }
  }
  return u.href;
}
function decodeText(s = '') {
  return String(s).replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"').replace(/&#39;|&#x27;/g, "'")
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/\s+/g, ' ').trim();
}
function searchUrl(q) { return `https://www.google.com/search?q=${encodeURIComponent(q)}`; }
async function searchWeb(query) {
  if (query.length > 180) throw new Error('Search is too long.');
  const response = await fetch('https://html.duckduckgo.com/html/?q=' + encodeURIComponent(query), {
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    headers: { 'user-agent': 'Mozilla/5.0 (compatible; MATHIA-DeepSearch/0.3)', 'accept': 'text/html' }
  });
  if (!response.ok) throw new Error('Search provider temporarily unavailable.');
  const html = (await response.text()).slice(0, 800_000);
  const blocks = html.split(/<div[^>]*class="[^"]*result\s/gi).slice(1, 16);
  const results = [];
  for (const block of blocks) {
    const m = block.match(/<a[^>]*class="[^"]*result__a[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i)
      || block.match(/<a[^>]*href="([^"]+)"[^>]*class="[^"]*result__a[^"]*"[^>]*>([\s\S]*?)<\/a>/i);
    if (!m) continue;
    let dest = m[1].replace(/&amp;/g, '&');
    try {
      const u = new URL(dest, 'https://duckduckgo.com');
      dest = u.searchParams.get('uddg') || u.href;
      if (!['https:', 'http:'].includes(new URL(dest).protocol)) continue;
    } catch { continue; }
    const snippet = block.match(/<a[^>]*class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/a>/i)
      || block.match(/<div[^>]*class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/div>/i);
    results.push({ title: decodeText(m[2]), url: dest,
      displayUrl: new URL(dest).hostname, snippet: decodeText(snippet?.[1] || '') });
    if (results.length === 10) break;
  }
  if (!results.length) throw new Error('Search returned no results. Try the browser search instead.');
  return { query, provider: 'DuckDuckGo', results };
}
async function ensureBrowser() {
  if (browserInstance?.connected) return browserInstance;
  if (!browserPromise) {
    browserPromise = puppeteer.launch({
      headless: true,
      executablePath: process.env.CHROME_EXECUTABLE_PATH || undefined,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage',
        '--no-first-run', '--no-default-browser-check', '--disable-extensions',
        '--disable-background-networking', '--disable-sync', '--mute-audio',
        '--disable-gpu', '--renderer-process-limit=2', '--disable-features=Translate']
    }).then(b => {
      browserInstance = b;
      b.on('disconnected', () => { browserInstance = null; browserPromise = null; });
      return b;
    }).catch(e => { browserPromise = null; throw new Error('Chrome could not start: ' + e.message); });
  }
  return browserPromise;
}
async function configurePage(page, session) {
  page.setDefaultNavigationTimeout(NAV_TIMEOUT_MS);
  page.setDefaultTimeout(8_000);
  await page.setViewport({ width: 1160, height: 710, deviceScaleFactor: 1 });
  await page.setRequestInterception(true);
  page.on('request', request => {
    const url = request.url();
    if (/^(data:image\/|blob:)/i.test(url)) return request.continue().catch(() => {});
    assertPublicUrl(url).then(() => request.continue()).catch(() => request.abort('blockedbyclient'));
  });
  page.on('dialog', d => d.dismiss().catch(() => {}));
  page.on('popup', popup => popup.close().catch(() => {}));
  page.on('framenavigated', frame => {
    if (frame === page.mainFrame()) sendState(session);
  });
  page.on('load', () => { sendState(session); requestFrame(session); });
  page.on('domcontentloaded', () => { sendState(session); requestFrame(session); });
}
function send(session, message) {
  if (!session) return;
  for (const socket of session.sockets) {
    if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
  }
}
function sendState(s) {
  if (!s || s.closed) return;
  send(s, { type: 'state', url: s.page.url(), title: s.title || '', busy: s.busy });
  s.page.title().then(title => { s.title = title; send(s, { type: 'state', url: s.page.url(), title, busy: s.busy }); }).catch(() => {});
}
async function takeFrame(s) {
  if (!s || s.closed || s.frameBusy) return;
  s.frameBusy = true;
  try {
    const jpg = await s.page.screenshot({ type: 'jpeg', quality: 62, optimizeForSpeed: true });
    send(s, { type: 'frame', data: Buffer.from(jpg).toString('base64'),
      width: s.width, height: s.height });
  } catch {} finally { s.frameBusy = false; }
}
function requestFrame(s) {
  if (!s || s.closed || s.frameRequested) return;
  s.frameRequested = true;
  setTimeout(() => { s.frameRequested = false; void takeFrame(s); }, 130);
}
async function navigate(s, raw) {
  const url = await assertPublicUrl(raw);
  s.busy = true; sendState(s);
  try {
    await s.page.goto(url, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT_MS });
    await new Promise(resolve => setTimeout(resolve, 500));
  } catch (e) {
    // Slow sites may still render usefully after a navigation timeout.
    if (!/Timeout|timed out/i.test(e.message)) throw e;
  } finally {
    s.busy = false; sendState(s); requestFrame(s);
  }
}
async function closeSession(s) {
  if (!s || s.closed) return;
  s.closed = true; clearInterval(s.loop); sessions.delete(s.id);
  for (const ws of s.sockets) ws.close(1000, 'Session closed');
  try { await s.context.close(); } catch {}
}
async function newSession(ip) {
  for (const s of sessions.values()) if (!s.closed && s.ip === ip)
    throw Object.assign(new Error('You already have an active DeepSearch browser session.'), { status: 429 });
  if (sessions.size + sessionStarting >= MAX_SESSIONS)
    throw Object.assign(new Error('DeepSearch browser is busy. Try again shortly.'), { status: 503 });
  sessionStarting++;
  let context;
  try {
    const browser = await ensureBrowser();
    context = await browser.createBrowserContext();
    const page = await context.newPage();
    const id = randomBytes(12).toString('hex'), token = randomBytes(32).toString('hex');
    const s = { id, token, ip, context, page, sockets: new Set(), closed: false,
      busy: false, width: 1160, height: 710, frameBusy: false, frameRequested: false,
      lastUse: Date.now(), title: '', loop: null };
    await configurePage(page, s);
    sessions.set(id, s);
    s.loop = setInterval(() => { if (s.sockets.size) void takeFrame(s); }, 1100);
    return s;
  } catch (e) { await context?.close().catch(() => {}); throw e; }
  finally { sessionStarting--; }
}
function constantToken(expected, supplied) {
  if (typeof supplied !== 'string' || supplied.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(expected), Buffer.from(supplied));
}
function getSession(req, id, token) {
  const s = sessions.get(id);
  if (!s || s.closed || !constantToken(s.token, token))
    throw Object.assign(new Error('Browser session expired. Start a new session.'), { status: 404 });
  if (s.ip !== ipOf(req)) throw Object.assign(new Error('Session not authorized.'), { status: 403 });
  s.lastUse = Date.now();
  return s;
}
async function readJson(req) {
  let bytes = 0, chunks = [];
  for await (const chunk of req) {
    bytes += chunk.length;
    if (bytes > MAX_JSON_BYTES) throw Object.assign(new Error('Request is too large.'), { status: 413 });
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString() || '{}'); }
  catch { throw Object.assign(new Error('Invalid JSON.'), { status: 400 }); }
}
function number(v, fallback, min, max) {
  return Number.isFinite(Number(v)) ? Math.max(min, Math.min(max, Number(v))) : fallback;
}
async function doAction(s, input) {
  const a = String(input.type || '');
  const x = number(input.x, 500, 0, s.width - 1);
  const y = number(input.y, 300, 0, s.height - 1);
  if (a === 'click') await s.page.mouse.click(x, y);
  else if (a === 'move') await s.page.mouse.move(x, y);
  else if (a === 'wheel') await s.page.mouse.wheel({ deltaX: number(input.deltaX, 0, -1500, 1500), deltaY: number(input.deltaY, 0, -1500, 1500) });
  else if (a === 'insertText') await s.page.keyboard.type(String(input.text || '').slice(0, 1024), { delay: 6 });
  else if (a === 'press') {
    const key = String(input.key || '').slice(0, 40);
    if (!/^[\w+ .-]{1,40}$/.test(key)) throw new Error('Invalid key.');
    await s.page.keyboard.press(key);
  }
  else if (a === 'navigate') await navigate(s, String(input.url || ''));
  else if (a === 'back') await s.page.goBack({ waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT_MS }).catch(() => {});
  else if (a === 'forward') await s.page.goForward({ waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT_MS }).catch(() => {});
  else if (a === 'reload') await s.page.reload({ waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT_MS }).catch(() => {});
  else if (a === 'viewport') {
    const width = number(input.width, s.width, 480, 1600);
    const height = number(input.height, s.height, 320, 950);
    s.width = width; s.height = height;
    await s.page.setViewport({ width, height, deviceScaleFactor: 1 });
  }
  else if (a !== 'heartbeat') throw new Error('Unknown browser action.');
  sendState(s); requestFrame(s);
}

const server = http.createServer(async (req, res) => {
  const headers = cors(req);
  if (req.method === 'OPTIONS') { res.writeHead(204, headers); return res.end(); }
  if (!rate(req)) return json(res, 429, { error: 'Too many requests. Try again in a minute.' }, headers);
  if (['POST', 'DELETE'].includes(req.method) && req.headers.origin && !ALLOWED_ORIGINS.has(req.headers.origin))
    return json(res, 403, { error: 'Origin not allowed.' }, headers);
  let u;
  try { u = new URL(req.url || '/', 'http://local.invalid'); }
  catch { return json(res, 400, { error: 'Invalid request.' }, headers); }
  const pathname = u.pathname;
  try {
    if (req.method === 'GET' && (pathname === '/' || pathname === '/browser')) {
      const html = await readFile(join(ROOT, 'index.html'));
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8',
        'cache-control': 'no-store', 'x-content-type-options': 'nosniff',
        'content-security-policy': "default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self' ws: wss:; frame-ancestors https://mathia.online https://www.mathia.online https://mathiagang.netlify.app; base-uri 'none'; object-src 'none'" });
      return res.end(html);
    }
    if (req.method === 'GET' && pathname === '/health') return json(res, 200, {
      ok: true, name: 'MATHIA DeepSearch', version: '0.3.0', engine: 'Chromium / Puppeteer',
      chromeRunning: !!browserInstance?.connected, sessions: sessions.size,
      capacity: MAX_SESSIONS, browserInterface: '/' }, headers);
    if (req.method === 'GET' && pathname === '/api/search') {
      const query = String(u.searchParams.get('q') || '').trim();
      if (!query) return json(res, 400, { error: 'Search query required.' }, headers);
      return json(res, 200, await searchWeb(query), headers);
    }
    if (req.method === 'GET' && pathname === '/api/fetch') {
      const raw = u.searchParams.get('url');
      if (!raw) return json(res, 400, { error: 'Missing url parameter.' }, headers);
      if (fetchRunning > 0 || sessions.size + sessionStarting >= MAX_SESSIONS)
        return json(res, 503, { error: 'Browser is busy. Try again in a moment.' }, headers);
      fetchRunning++;
      let context;
      try {
        const url = await assertPublicUrl(raw);
        context = await (await ensureBrowser()).createBrowserContext();
        const page = await context.newPage();
        await configurePage(page, null);
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT_MS });
        await new Promise(resolve => setTimeout(resolve, 900));
        const body = await page.content();
        if (Buffer.byteLength(body) > MAX_FETCH_BYTES) throw new Error('Page is too large for DeepSearch.');
        return json(res, 200, { requestedUrl: raw, finalUrl: page.url(), status: 200,
          ok: true, contentType: 'text/html', body }, headers);
      } finally { fetchRunning--; await context?.close().catch(() => {}); }
    }
    if (req.method === 'POST' && pathname === '/api/browser/session') {
      if (fetchRunning) return json(res, 503, { error: 'Browser is busy.' }, headers);
      const s = await newSession(ipOf(req));
      return json(res, 201, { id: s.id, token: s.token, wsPath: '/api/browser/ws',
        width: s.width, height: s.height, idleSeconds: SESSION_IDLE_MS / 1000 }, headers);
    }
    const m = pathname.match(/^\/api\/browser\/([a-f0-9]{24})(?:\/(navigate|back|forward|reload|action|viewport|frame))?$/);
    if (m) {
      const s = getSession(req, m[1], req.headers['x-deepsearch-token']);
      if (req.method === 'DELETE' && !m[2]) { await closeSession(s); return json(res, 200, { ok: true }, headers); }
      if (req.method === 'GET' && m[2] === 'frame') {
        const jpg = await s.page.screenshot({ type: 'jpeg', quality: 62 });
        res.writeHead(200, { 'content-type': 'image/jpeg', 'cache-control': 'no-store', ...headers });
        return res.end(jpg);
      }
      if (req.method === 'POST' && m[2] && m[2] !== 'frame') {
        const body = await readJson(req);
        await doAction(s, { ...body, type: m[2] === 'action' ? body.type : m[2] });
        return json(res, 200, { ok: true, url: s.page.url() }, headers);
      }
    }
    return json(res, 404, { error: 'Not found.' }, headers);
  } catch (e) {
    console.error('[DeepSearch]', e.message);
    return json(res, e.status || (/too large/i.test(e.message) ? 413 : 400),
      { error: String(e.message || 'DeepSearch request failed.').slice(0, 280) }, headers);
  }
});

const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_JSON_BYTES });
server.on('upgrade', async (req, socket, head) => {
  try {
    const origin = req.headers.origin;
    if (!origin || !ALLOWED_ORIGINS.has(origin)) throw new Error('Origin not allowed.');
    const u = new URL(req.url || '/', 'http://local.invalid');
    if (u.pathname !== '/api/browser/ws') throw new Error('Not found.');
    const s = getSession(req, u.searchParams.get('session'), u.searchParams.get('token'));
    wss.handleUpgrade(req, socket, head, ws => wss.emit('connection', ws, req, s));
  } catch { socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'); socket.destroy(); }
});
wss.on('connection', (ws, req, s) => {
  s.sockets.add(ws); s.lastUse = Date.now();
  ws.send(JSON.stringify({ type: 'ready', width: s.width, height: s.height, url: s.page.url() }));
  sendState(s); requestFrame(s);
  let chain = Promise.resolve();
  ws.on('message', raw => {
    let input;
    try { input = JSON.parse(String(raw)); } catch { return; }
    s.lastUse = Date.now();
    chain = chain.then(() => doAction(s, input)).catch(e => {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'error', error: String(e.message).slice(0, 250) }));
    });
  });
  ws.on('close', () => s.sockets.delete(ws));
});
setInterval(() => {
  const now = Date.now();
  for (const s of sessions.values()) if (now - s.lastUse > SESSION_IDLE_MS) void closeSession(s);
  for (const [ip, v] of clients) if (now - v.since > 2 * RATE_WINDOW_MS) clients.delete(ip);
}, 30_000).unref();

server.listen(PORT, '0.0.0.0', () => console.log(`MATHIA DeepSearch v0.3 listening on ${PORT}`));
process.on('SIGTERM', async () => {
  for (const s of [...sessions.values()]) await closeSession(s);
  await browserInstance?.close().catch(() => {});
  server.close();
});
