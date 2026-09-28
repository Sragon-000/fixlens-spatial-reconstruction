import { createServer } from 'node:http';
import { execFile, execFileSync } from 'node:child_process';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { randomBytes } from 'node:crypto';

const execFileAsync = promisify(execFile);
const ROOT = resolve(fileURLToPath(new URL('../', import.meta.url)));
const UI_ROOT = resolve(ROOT, 'manager');
const RUN_DIR = resolve(ROOT, '.run');
const PORT = Number(process.env.FIXLENS_MANAGER_PORT || 4174);
const HOST = '127.0.0.1';
const WEB_URL = 'http://127.0.0.1:4173';
const OLLAMA_URL = 'http://127.0.0.1:11434';
const MODEL = process.env.OLLAMA_MODEL || 'qwen3.5:4b';
const SCRIPT = resolve(ROOT, 'scripts/manage-server.sh');
const QR_SCRIPT = resolve(ROOT, 'scripts/generate-qr.mjs');
const QR_IMAGE = resolve(RUN_DIR, 'phone-access-qr.png');
const TOKEN_PATH = resolve(RUN_DIR, 'manager.token');
const PID_FILES = {
  web: resolve(RUN_DIR, 'web.pid'),
  ollama: resolve(RUN_DIR, 'ollama.pid'),
  tunnel: resolve(RUN_DIR, 'tunnel.pid'),
  manager: resolve(RUN_DIR, 'manager.pid'),
};
const LOG_FILES = {
  web: resolve(RUN_DIR, 'web.log'),
  ollama: resolve(RUN_DIR, 'ollama.log'),
  tunnel: resolve(RUN_DIR, 'tunnel.log'),
};
const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8' };
const ACTIONS = new Set(['start', 'stop', 'web-start', 'web-stop', 'ollama-start', 'ollama-stop', 'tunnel-start', 'tunnel-stop']);
await mkdir(RUN_DIR, { recursive: true });
let MANAGER_TOKEN;
try { MANAGER_TOKEN = (await readFile(TOKEN_PATH, 'utf8')).trim(); } catch {}
if (!MANAGER_TOKEN) {
  MANAGER_TOKEN = randomBytes(32).toString('hex');
  await writeFile(TOKEN_PATH, MANAGER_TOKEN, { mode: 0o600 });
}

function json(response, status, data) {
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
  });
  response.end(JSON.stringify(data));
}

function allowedLocalRequest(request) {
  const host = String(request.headers.host || '').toLowerCase();
  if (host !== `127.0.0.1:${PORT}` && host !== `localhost:${PORT}`) return false;
  const remote = request.socket.remoteAddress || '';
  if (remote !== '127.0.0.1' && remote !== '::1' && remote !== '::ffff:127.0.0.1') return false;
  const origin = request.headers.origin;
  return !origin || origin === `http://${host}`;
}

async function fetchJson(url, timeoutMs = 1800, headers = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { signal: controller.signal, cache: 'no-store', headers });
    if (!response.ok) return null;
    return await response.json();
  } catch { return null; }
  finally { clearTimeout(timer); }
}

async function managedProcess(name, needle) {
  try {
    const rawPid = (await readFile(PID_FILES[name], 'utf8')).trim();
    if (!/^\d+$/.test(rawPid)) return false;
    const pid = Number(rawPid);
    process.kill(pid, 0);
    const { stdout } = await execFileAsync('/bin/ps', ['-p', rawPid, '-o', 'command='], { timeout: 1200, maxBuffer: 4096 });
    return stdout.includes(needle);
  } catch { return false; }
}

async function status() {
  const [web, ollama, webManaged, ollamaManaged, tunnelManaged, tunnelLog, presence] = await Promise.all([
    fetchJson(`${WEB_URL}/api/health`), fetchJson(`${OLLAMA_URL}/api/tags`),
    managedProcess('web', 'server/local.mjs'), managedProcess('ollama', 'ollama serve'),
    managedProcess('tunnel', 'cloudflared tunnel --url http://127.0.0.1:4173'),
    readFile(LOG_FILES.tunnel, 'utf8').catch(() => ''),
    fetchJson(`${WEB_URL}/api/admin/presence`, 1800, { 'x-fixlens-manager-token': MANAGER_TOKEN }),
  ]);
  const models = Array.isArray(ollama?.models) ? ollama.models : [];
  const installed = models.some((item) => item.name === MODEL || item.model === MODEL);
  const candidateUrl = tunnelLog.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/i)?.[0] || '';
  return {
    checkedAt: new Date().toISOString(), model: MODEL,
    web: { running: Boolean(web?.status === 'ok'), managed: webManaged, modelAvailable: Boolean(web?.modelAvailable) },
    ollama: { running: Boolean(ollama), managed: ollamaManaged, modelAvailable: installed, model: MODEL },
    tunnel: { running: tunnelManaged, url: tunnelManaged ? candidateUrl : '' },
    clients: Array.isArray(presence?.clients) ? presence.clients : [],
  };
}

async function readRequestBody(request, limit = 4096) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > limit) throw new Error('요청 데이터가 너무 큽니다.');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

async function runAction(action) {
  const { stdout = '', stderr = '' } = await execFileAsync('/bin/bash', [SCRIPT, action], {
    cwd: ROOT,
    env: { ...process.env, FIXLENS_OPEN_QR: '0' },
    timeout: 150_000,
    maxBuffer: 256 * 1024,
  });
  return `${stdout}${stderr ? `\n${stderr}` : ''}`.trim();
}

async function serveStatic(request, response, pathname) {
  if (request.method !== 'GET' && request.method !== 'HEAD') return json(response, 405, { message: 'GET 요청만 받을 수 있습니다.' });
  const relative = pathname === '/' ? 'index.html' : decodeURIComponent(pathname.slice(1));
  const path = resolve(UI_ROOT, relative);
  if (path !== UI_ROOT && !path.startsWith(UI_ROOT + sep)) return json(response, 404, { message: '페이지를 찾지 못했습니다.' });
  try {
    const info = await stat(path);
    if (!info.isFile()) return json(response, 404, { message: '페이지를 찾지 못했습니다.' });
    const body = await readFile(path);
    response.writeHead(200, {
      'content-type': MIME[extname(path).toLowerCase()] || 'application/octet-stream',
      'cache-control': 'no-store', 'x-content-type-options': 'nosniff',
      'referrer-policy': 'no-referrer',
      'content-security-policy': "default-src 'self'; img-src 'self' data:; connect-src 'self'; style-src 'self'; script-src 'self'; base-uri 'none'; frame-ancestors 'none'",
    });
    response.end(request.method === 'HEAD' ? undefined : body);
  } catch { json(response, 404, { message: '페이지를 찾지 못했습니다.' }); }
}

const server = createServer(async (request, response) => {
  if (!allowedLocalRequest(request)) return json(response, 403, { message: 'Mac에서만 사용할 수 있는 관리 화면입니다.' });
  const url = new URL(request.url || '/', `http://${request.headers.host}`);
  if (url.pathname === '/api/status' && request.method === 'GET') return json(response, 200, await status());
  if (url.pathname === '/api/action' && request.method === 'POST') {
    if (String(request.headers['content-type'] || '').split(';')[0] !== 'application/json') {
      return json(response, 415, { message: '요청 형식이 올바르지 않습니다.' });
    }
    let payload;
    try { payload = JSON.parse(await readRequestBody(request)); }
    catch (error) { return json(response, 400, { message: error.message || '요청을 읽지 못했습니다.' }); }
    if (!ACTIONS.has(payload?.action)) return json(response, 400, { message: '지원하지 않는 관리 작업입니다.' });
    try {
      const output = await runAction(payload.action);
      return json(response, 200, { ok: true, output });
    } catch (error) {
      return json(response, 500, { ok: false, output: String(error.stdout || ''), message: String(error.stderr || error.message || '관리 작업에 실패했습니다.') });
    }
  }
  if (url.pathname === '/api/qr' && request.method === 'GET') {
    const current = await status();
    if (!current.tunnel.running || !current.tunnel.url) return json(response, 409, { message: 'HTTPS 터널을 먼저 시작해 주세요.' });
    try {
      await execFileAsync(process.execPath, [QR_SCRIPT, current.tunnel.url, QR_IMAGE], { timeout: 6000, maxBuffer: 4096 });
      const image = await readFile(QR_IMAGE);
      response.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
      return response.end(image);
    } catch { return json(response, 500, { message: 'QR을 생성하지 못했습니다.' }); }
  }
  if (url.pathname === '/api/logs' && request.method === 'GET') {
    const logs = {};
    for (const [key, path] of Object.entries(LOG_FILES)) {
      const text = await readFile(path, 'utf8').catch(() => '');
      logs[key] = text.split('\n').slice(-45).join('\n').trim();
    }
    return json(response, 200, { logs });
  }
  return serveStatic(request, response, url.pathname);
});

server.listen(PORT, HOST, () => console.log(`FixLens local manager listening on http://${HOST}:${PORT}`));

function shutdown() {
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000).unref();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
