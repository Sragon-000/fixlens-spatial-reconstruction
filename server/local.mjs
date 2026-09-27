import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('../dist/', import.meta.url)));
const HOST = process.env.FIXLENS_HOST || '127.0.0.1';
const PORT = Number(process.env.PORT || 4173);
const OLLAMA_URL = (process.env.OLLAMA_URL || 'http://127.0.0.1:11434').replace(/\/$/, '');
const MODEL = process.env.OLLAMA_MODEL || 'qwen3.5:4b';
const MAX_IMAGE_BYTES = 2_000_000;
const MAX_REQUESTS_PER_MINUTE = 15;
const windows = new Map();
let activeScan = false;

const MIME = {
  '.html': 'text/html; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.webp': 'image/webp', '.ico': 'image/x-icon',
};

const SCHEMA = {
  type: 'object', additionalProperties: false, required: ['detections'],
  properties: { detections: {
    type: 'array', maxItems: 12, items: {
      type: 'object', additionalProperties: false, required: ['label', 'score', 'box'],
      properties: {
        label: { type: 'string' }, score: { type: 'number', minimum: 0, maximum: 1 },
        box: { type: 'object', additionalProperties: false, required: ['x', 'y', 'w', 'h'], properties: {
          x: { type: 'number', minimum: 0, maximum: 1 }, y: { type: 'number', minimum: 0, maximum: 1 },
          w: { type: 'number', minimum: 0, maximum: 1 }, h: { type: 'number', minimum: 0, maximum: 1 },
        } },
      },
    },
  } },
};

function json(response, status = 200, extraHeaders = {}) {
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store',
    'x-content-type-options': 'nosniff', ...extraHeaders,
  });
}

function fail(response, status, error, message) {
  json(response, status); response.end(JSON.stringify({ error, message }));
}

function rateLimited(request) {
  const forwardedIp = request.headers['cf-connecting-ip'];
  const ip = typeof forwardedIp === 'string' ? forwardedIp : request.socket.remoteAddress || 'unknown';
  const now = Date.now();
  let window = windows.get(ip);
  if (!window || now - window.startedAt >= 60_000) {
    window = { startedAt: now, count: 0 };
    windows.set(ip, window);
  }
  window.count += 1;
  if (windows.size > 1_000) {
    for (const [key, value] of windows) if (now - value.startedAt > 60_000) windows.delete(key);
  }
  return window.count > MAX_REQUESTS_PER_MINUTE;
}

async function readBody(request) {
  const declared = Number(request.headers['content-length'] || 0);
  if (declared > MAX_IMAGE_BYTES) throw Object.assign(new Error('이미지 파일은 2MB 이하로 보내주세요.'), { statusCode: 413 });
  const chunks = [];
  let total = 0;
  for await (const chunk of request) {
    total += chunk.length;
    if (total > MAX_IMAGE_BYTES) throw Object.assign(new Error('이미지 파일은 2MB 이하로 보내주세요.'), { statusCode: 413 });
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, total);
}

function validateDetections(parsed) {
  if (!parsed || !Array.isArray(parsed.detections)) throw new Error('모델 응답에서 물체 후보를 읽지 못했습니다.');
  return parsed.detections.slice(0, 12).flatMap((entry) => {
    const label = String(entry?.label || '').trim().slice(0, 48);
    const score = Number(entry?.score);
    const box = entry?.box;
    if (!label || !Number.isFinite(score) || !box) return [];
    const x = Number(box.x); const y = Number(box.y); const w = Number(box.w); const h = Number(box.h);
    if (![x, y, w, h].every(Number.isFinite) || w <= 0 || h <= 0 || x >= 1 || y >= 1) return [];
    const left = Math.max(0, Math.min(1, x)); const top = Math.max(0, Math.min(1, y));
    const right = Math.max(left, Math.min(1, x + w)); const bottom = Math.max(top, Math.min(1, y + h));
    if (right <= left || bottom <= top) return [];
    return [{ label, score: Math.max(0, Math.min(1, score)), box: { x: left, y: top, w: right - left, h: bottom - top } }];
  });
}

async function health(response) {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 2_500);
    const result = await fetch(`${OLLAMA_URL}/api/tags`, { signal: controller.signal });
    clearTimeout(timer);
    if (!result.ok) throw new Error('Ollama server unavailable');
    const body = await result.json();
    const model = body.models?.find((item) => item.name === MODEL || item.model === MODEL);
    const available = Boolean(model && (model.capabilities?.includes('vision') || MODEL.startsWith('qwen3.5')));
    json(response, 200);
    response.end(JSON.stringify({ status: 'ok', modelAvailable: available, model: MODEL }));
  } catch {
    json(response, 200);
    response.end(JSON.stringify({ status: 'ok', modelAvailable: false, model: MODEL }));
  }
}

async function scan(request, response) {
  if (request.method !== 'POST') return fail(response, 405, 'method_not_allowed', 'POST 요청만 받을 수 있습니다.');
  const origin = request.headers.origin;
  if (origin && origin !== `https://${request.headers.host}` && origin !== `http://${request.headers.host}`) {
    return fail(response, 403, 'origin_not_allowed', 'FixLens 페이지에서 다시 시도해 주세요.');
  }
  if (rateLimited(request)) return fail(response, 429, 'rate_limited', '잠시 기다린 뒤 다시 스캔해 주세요.');
  const contentType = String(request.headers['content-type'] || '').split(';')[0];
  if (!['image/jpeg', 'image/png', 'image/webp'].includes(contentType)) return fail(response, 415, 'image_required', 'JPEG, PNG 또는 WebP 이미지만 분석할 수 있습니다.');
  if (activeScan) return fail(response, 429, 'scan_in_progress', '이전 스캔이 끝난 뒤 다시 시도해 주세요.');
  const width = Number(request.headers['x-image-width']);
  const height = Number(request.headers['x-image-height']);
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || width > 960 || height > 720) {
    return fail(response, 400, 'invalid_dimensions', '이미지 크기 정보가 올바르지 않습니다.');
  }

  let image;
  try { image = await readBody(request); }
  catch (error) { return fail(response, error.statusCode || 400, 'invalid_image', error.message); }
  if (!image.length) return fail(response, 400, 'empty_image', '분석할 이미지가 없습니다.');

  activeScan = true;
  try {
    const started = Date.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 120_000);
    let result;
    try {
      result = await fetch(`${OLLAMA_URL}/api/chat`, {
        method: 'POST', signal: controller.signal,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model: MODEL, stream: false, think: false, format: SCHEMA,
            options: { temperature: 0.05, num_ctx: 8192 },
            messages: [{
              role: 'user', images: [image.toString('base64')],
            content: `이 장면은 정리 안내를 만들기 위한 물건 목록입니다. 이미지를 전체와 작은 구역 순서로 꼼꼼히 살펴보고, 실제로 보이는 독립된 물건만 찾으세요. 먼저 물건의 종류와 개수를 세고, 마지막에 빠뜨린 물건·중복 항목·잘못된 상자를 다시 확인하세요. 물체마다 가장 구체적이면서도 확실한 짧은 한국어 이름을 쓰세요(예: 전자기기라고만 하지 말고 키보드처럼 구체적으로). 불확실하면 더 일반적인 이름을 쓰고, 일부만 보이거나 흐릿해 식별할 수 없는 것은 추측하지 마세요. 작은 부속품도 명확히 보이면 포함하되 그림자나 인쇄된 그림은 물건으로 세지 마세요. 각 물체의 상자 좌표는 이미지 전체 기준 0~1의 x(왼쪽), y(위쪽), w(너비), h(높이)입니다. 상자는 물체 외곽에 가깝게 잡고, 같은 물체를 중복 반환하지 마세요. 최대 12개까지만 반환하세요. score는 확신도이며, 낮은 확신의 후보는 생략하세요. JSON 외의 텍스트를 반환하지 마세요. 이미지 크기는 ${width}×${height}입니다.`,
          }],
        }),
      });
    } finally { clearTimeout(timer); }
    if (!result.ok) {
      if (result.status === 404) return fail(response, 503, 'model_not_available', `Ollama에서 ${MODEL} 모델을 사용할 수 없습니다.`);
      return fail(response, 502, 'inference_failed', '로컬 AI 분석에 실패했습니다. 다시 시도해 주세요.');
    }
    const completion = await result.json();
    const text = completion.message?.content;
    if (typeof text !== 'string') return fail(response, 502, 'invalid_model_response', 'AI 응답을 읽지 못했습니다.');
    let parsed;
    try { parsed = JSON.parse(text); }
    catch {
      const first = text.indexOf('{'); const last = text.lastIndexOf('}');
      if (first < 0 || last <= first) return fail(response, 502, 'invalid_model_response', 'AI 응답에서 결과를 읽지 못했습니다.');
      try { parsed = JSON.parse(text.slice(first, last + 1)); }
      catch { return fail(response, 502, 'invalid_model_response', 'AI 응답에서 결과를 읽지 못했습니다.'); }
    }
    const detections = validateDetections(parsed);
    json(response, 200);
    response.end(JSON.stringify({ detections, elapsedMs: Date.now() - started, model: MODEL }));
  } catch (error) {
    const message = error.name === 'AbortError' ? 'AI 분석 시간이 길어졌습니다. 물체 수를 줄여 다시 스캔해 주세요.' : 'Ollama 로컬 서버에 연결하지 못했습니다. 서버가 실행 중인지 확인해 주세요.';
    return fail(response, error.name === 'AbortError' ? 504 : 502, 'inference_failed', message);
  } finally { activeScan = false; }
}

async function serveStatic(request, response, pathname) {
  if (request.method !== 'GET' && request.method !== 'HEAD') return fail(response, 405, 'method_not_allowed', 'GET 요청만 받을 수 있습니다.');
  const relative = pathname === '/' ? 'index.html' : decodeURIComponent(pathname.slice(1));
  const path = resolve(ROOT, relative);
  if (path !== ROOT && !path.startsWith(ROOT + sep)) return fail(response, 404, 'not_found', '페이지를 찾지 못했습니다.');
  try {
    const info = await stat(path);
    if (!info.isFile()) return fail(response, 404, 'not_found', '페이지를 찾지 못했습니다.');
    const body = await readFile(path);
    response.writeHead(200, {
      'content-type': MIME[extname(path).toLowerCase()] || 'application/octet-stream',
      'cache-control': pathname === '/' || ['.mjs', '.css'].includes(extname(path).toLowerCase()) ? 'no-cache' : 'public, max-age=300',
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'no-referrer',
      'content-security-policy': "default-src 'self'; img-src 'self' blob: data:; media-src 'self' blob:; connect-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self' 'wasm-unsafe-eval'; worker-src 'self'; base-uri 'none'; frame-ancestors 'none'",
      'permissions-policy': 'camera=(self), microphone=(), geolocation=()',
    });
    response.end(request.method === 'HEAD' ? undefined : body);
  } catch { fail(response, 404, 'not_found', '페이지를 찾지 못했습니다.'); }
}

const server = createServer((request, response) => {
  const url = new URL(request.url || '/', `http://${request.headers.host || 'localhost'}`);
  if (url.pathname === '/api/health') return health(response);
  if (url.pathname === '/api/scan') {
    const startedAt = Date.now();
    const declaredBytes = Number(request.headers['content-length'] || 0);
    response.once('finish', () => {
      const imageBytes = Number.isFinite(declaredBytes) ? declaredBytes : 0;
      console.log(`[scan] ${new Date().toISOString()} status=${response.statusCode} elapsedMs=${Date.now() - startedAt} imageBytes=${imageBytes}`);
    });
    return scan(request, response);
  }
  return serveStatic(request, response, url.pathname);
});

server.listen(PORT, HOST, () => {
  console.log(`FixLens local web server listening on http://${HOST}:${PORT}`);
  console.log(`Ollama endpoint: ${OLLAMA_URL} · model: ${MODEL}`);
});

function shutdown() {
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3_000).unref();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
