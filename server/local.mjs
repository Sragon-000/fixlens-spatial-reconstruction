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
const PRESENCE_TTL_MS = 60_000;
const PRESENCE_STAGES = new Set(['idle', 'ready', 'scanning', 'scanned', 'planning', 'guiding', 'completed']);
const windows = new Map();
const presenceByClient = new Map();
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
const PLAN_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['summary', 'placements'],
  properties: {
    summary: { type: 'string' },
    placements: { type: 'array', minItems: 1, maxItems: 30, items: {
      type: 'object', additionalProperties: false, required: ['id', 'center', 'order', 'reason'],
      properties: {
        id: { type: 'integer', minimum: 0, maximum: 29 },
        center: { type: 'object', additionalProperties: false, required: ['x', 'y'], properties: {
          x: { type: 'number', minimum: 0, maximum: 1 }, y: { type: 'number', minimum: 0, maximum: 1 },
        } },
        order: { type: 'integer', minimum: 0, maximum: 29 }, reason: { type: 'string' },
      },
    } },
  },
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

async function readBody(request, maxBytes = MAX_IMAGE_BYTES) {
  const declared = Number(request.headers['content-length'] || 0);
  if (declared > maxBytes) throw Object.assign(new Error('요청 데이터가 너무 큽니다.'), { statusCode: 413 });
  const chunks = [];
  let total = 0;
  for await (const chunk of request) {
    total += chunk.length;
    if (total > maxBytes) throw Object.assign(new Error('요청 데이터가 너무 큽니다.'), { statusCode: 413 });
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, total);
}

async function updatePresence(request, response) {
  if (request.method !== 'POST') return fail(response, 405, 'method_not_allowed', 'POST 요청만 받을 수 있습니다.');
  const origin = request.headers.origin;
  if (origin && origin !== `https://${request.headers.host}` && origin !== `http://${request.headers.host}`) {
    return fail(response, 403, 'origin_not_allowed', 'FixLens 페이지에서 다시 시도해 주세요.');
  }
  let payload;
  try { payload = JSON.parse((await readBody(request, 4096)).toString('utf8')); }
  catch (error) { return fail(response, error.statusCode || 400, 'invalid_presence', '접속 상태를 저장하지 못했습니다.'); }
  const clientId = String(payload?.clientId || '');
  if (!/^[A-Za-z0-9_-]{8,80}$/.test(clientId)) return fail(response, 400, 'invalid_presence', '접속 식별자가 올바르지 않습니다.');
  if (payload.online === false) {
    presenceByClient.delete(clientId);
    json(response, 200);
    return response.end('{"ok":true}');
  }
  const now = Date.now();
  for (const [id, client] of presenceByClient) if (now - client.lastSeenAt > PRESENCE_TTL_MS) presenceByClient.delete(id);
  if (presenceByClient.size >= 50 && !presenceByClient.has(clientId)) return fail(response, 429, 'presence_full', '활성 접속 기기가 너무 많습니다.');
  const requestedStage = String(payload.stage || 'idle');
  const progress = payload.progress && typeof payload.progress === 'object' ? payload.progress : null;
  const done = Number(progress?.done); const total = Number(progress?.total);
  const userAgent = String(request.headers['user-agent'] || '');
  let device = /iPad/i.test(userAgent) ? 'iPad' : /iPhone|iPod/i.test(userAgent) ? 'iPhone' : /Android/i.test(userAgent) ? 'Android' : /Macintosh|Mac OS/i.test(userAgent) ? 'Mac' : /Windows/i.test(userAgent) ? 'Windows PC' : '웹 브라우저';
  let browser = /Edg\//i.test(userAgent) ? 'Edge' : /CriOS|Chrome\//i.test(userAgent) ? 'Chrome' : /FxiOS|Firefox\//i.test(userAgent) ? 'Firefox' : /Safari\//i.test(userAgent) ? 'Safari' : '브라우저';
  presenceByClient.set(clientId, {
    clientId, device, browser, phone: ['iPad', 'iPhone', 'Android'].includes(device),
    camera: payload.camera === true, stage: PRESENCE_STAGES.has(requestedStage) ? requestedStage : 'idle',
    count: Math.max(0, Math.min(30, Number.isFinite(Number(payload.count)) ? Math.trunc(Number(payload.count)) : 0)),
    progress: progress && Number.isInteger(done) && Number.isInteger(total) && total > 0
      ? { done: Math.max(0, Math.min(total, done)), total: Math.min(100, total) } : null,
    lastSeenAt: now,
  });
  json(response, 200);
  response.end('{"ok":true}');
}

async function adminPresence(request, response) {
  const remoteAddress = request.socket.remoteAddress || '';
  const isLoopback = remoteAddress === '127.0.0.1' || remoteAddress === '::1' || remoteAddress === '::ffff:127.0.0.1';
  if (!isLoopback || request.headers.host !== `127.0.0.1:${PORT}`) return fail(response, 404, 'not_found', '경로를 찾지 못했습니다.');
  let token = '';
  try { token = (await readFile(resolve(ROOT, '../.run/manager.token'), 'utf8')).trim(); } catch {}
  if (!token || request.headers['x-fixlens-manager-token'] !== token) return fail(response, 403, 'forbidden', '관리 화면에서만 볼 수 있습니다.');
  const now = Date.now();
  for (const [id, client] of presenceByClient) if (now - client.lastSeenAt > PRESENCE_TTL_MS) presenceByClient.delete(id);
  json(response, 200);
  response.end(JSON.stringify({ clients: [...presenceByClient.values()].map((client) => ({ ...client, lastSeenAt: undefined, lastSeenSeconds: Math.floor((now - client.lastSeenAt) / 1000) })) }));
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

async function plan(request, response) {
  if (request.method !== 'POST') return fail(response, 405, 'method_not_allowed', 'POST 요청만 받을 수 있습니다.');
  const origin = request.headers.origin;
  if (origin && origin !== `https://${request.headers.host}` && origin !== `http://${request.headers.host}`) {
    return fail(response, 403, 'origin_not_allowed', 'FixLens 페이지에서 다시 시도해 주세요.');
  }
  if (rateLimited(request)) return fail(response, 429, 'rate_limited', '잠시 기다린 뒤 다시 배치안을 요청해 주세요.');
  if (activeScan) return fail(response, 429, 'scan_in_progress', '이전 AI 분석이 끝난 뒤 다시 시도해 주세요.');
  if (String(request.headers['content-type'] || '').split(';')[0] !== 'application/json') {
    return fail(response, 415, 'json_required', '배치안 요청 형식이 올바르지 않습니다.');
  }

  let payload;
  try {
    const body = await readBody(request, 3_000_000);
    payload = JSON.parse(body.toString('utf8'));
  } catch (error) {
    return fail(response, error.statusCode || 400, 'invalid_request', error.statusCode ? error.message : '배치안 요청을 읽지 못했습니다.');
  }
  const allowedStyles = ['minimal', 'focus', 'cozy'];
  if (!allowedStyles.includes(payload?.style) || !Array.isArray(payload?.items) || !payload.items.length || payload.items.length > 30) {
    return fail(response, 400, 'invalid_plan_input', '정리 스타일과 물건 목록을 확인해 주세요.');
  }
  const width = Number(payload.width); const height = Number(payload.height);
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || width > 960 || height > 720) {
    return fail(response, 400, 'invalid_dimensions', '분석 이미지 크기가 올바르지 않습니다.');
  }
  if (typeof payload.image !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/.test(payload.image)) {
    return fail(response, 400, 'invalid_image', '배치안을 만들 카메라 이미지가 없습니다.');
  }
  const image = Buffer.from(payload.image, 'base64');
  if (!image.length || image.length > MAX_IMAGE_BYTES) return fail(response, 413, 'invalid_image', '분석 이미지는 2MB 이하로 보내주세요.');
  const ids = new Set();
  const items = payload.items.flatMap((item) => {
    const box = item?.box;
    const id = Number(item?.id);
    const name = String(item?.name || '').trim().slice(0, 48);
    const values = [box?.x, box?.y, box?.w, box?.h].map(Number);
    if (!Number.isInteger(id) || id < 0 || id >= payload.items.length || ids.has(id) || !name
      || !values.every(Number.isFinite) || values[0] < 0 || values[1] < 0 || values[2] <= 0 || values[3] <= 0
      || values[0] + values[2] > 1.02 || values[1] + values[3] > 1.02) return [];
    ids.add(id);
    return [{ id, name, box: { x: values[0], y: values[1], w: values[2], h: values[3] } }];
  });
  if (items.length !== payload.items.length) return fail(response, 400, 'invalid_plan_items', '물건 이름과 위치 정보를 확인해 주세요.');

  activeScan = true;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 120_000);
    let result;
    try {
      result = await fetch(`${OLLAMA_URL}/api/chat`, {
        method: 'POST', signal: controller.signal,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model: MODEL, stream: false, think: false, format: PLAN_SCHEMA,
          options: { temperature: 0.15, num_ctx: 8192 },
          messages: [{ role: 'user', images: [payload.image], content: `사진은 고정 카메라로 촬영한 책상 또는 작은 작업 공간입니다. 사진을 실제로 보고, 보이는 작업 면 안에서만 물건을 재배치하세요. 이미지의 객체 상자와 아래 목록을 함께 참고해 id가 가리키는 물건별 목표 중심 좌표(center x,y)를 정하세요. 좌표는 이 이미지 안의 0~1 정규화 좌표입니다. 사진에 보이지 않는 공간이나 물건을 상상하지 마세요. 현재 위치에서 충분히 이동할 수 있고 물건끼리 겹치지 않으며, 책상 경계·화면·키보드·사용자의 작업 공간을 침범하지 않도록 하세요. 각 물건의 크기는 프런트엔드가 현재 감지 상자 크기를 유지해 그리므로 좌표는 중심만 지정하세요. style=minimal은 가운데 작업 면을 넓게 비우고 주변에 배치, focus는 키보드/노트북 앞 작업 면을 비우고 자주 쓰는 작은 물건은 가까이 배치, cozy는 용도가 비슷한 물건을 작은 그룹으로 모으는 배치입니다. 이동 순서는 큰 물건이나 먼저 치워야 공간이 나는 물건을 앞에 두세요. 모든 id를 정확히 한 번씩 반환하고 order는 0부터 중복 없는 연속 정수로 지정하세요. reason에는 그 물건을 그 위치에 둔 사진 기반의 짧은 이유를 한국어로 쓰세요. summary에는 이 사진과 스타일에 맞는 전체 배치 의도를 한 문장으로 쓰세요. 물건 목록: ${JSON.stringify({ style: payload.style, items })}` }],
        }),
      });
    } finally { clearTimeout(timer); }
    if (!result.ok) {
      if (result.status === 404) return fail(response, 503, 'model_not_available', `Ollama에서 ${MODEL} 모델을 사용할 수 없습니다.`);
      return fail(response, 502, 'planning_failed', '로컬 AI가 배치안을 만들지 못했습니다. 다시 시도해 주세요.');
    }
    const completion = await result.json();
    const text = completion.message?.content;
    if (typeof text !== 'string') return fail(response, 502, 'invalid_model_response', 'AI 배치안 응답을 읽지 못했습니다.');
    let parsed;
    try { parsed = JSON.parse(text); }
    catch {
      const first = text.indexOf('{'); const last = text.lastIndexOf('}');
      if (first < 0 || last <= first) return fail(response, 502, 'invalid_model_response', 'AI 배치안 응답을 읽지 못했습니다.');
      try { parsed = JSON.parse(text.slice(first, last + 1)); }
      catch { return fail(response, 502, 'invalid_model_response', 'AI 배치안 응답을 읽지 못했습니다.'); }
    }
    const placements = Array.isArray(parsed.placements) ? parsed.placements : [];
    const seenIds = new Set(); const seenOrders = new Set();
    const valid = placements.flatMap((placement) => {
      const id = Number(placement?.id); const order = Number(placement?.order);
      const x = Number(placement?.center?.x); const y = Number(placement?.center?.y);
      const reason = String(placement?.reason || '').trim().slice(0, 100);
      if (!ids.has(id) || seenIds.has(id) || !Number.isInteger(order) || order < 0 || order >= items.length || seenOrders.has(order)
        || !Number.isFinite(x) || !Number.isFinite(y) || x < 0 || x > 1 || y < 0 || y > 1 || !reason) return [];
      seenIds.add(id); seenOrders.add(order);
      return [{ id, center: { x, y }, order, reason }];
    });
    if (valid.length !== items.length || seenIds.size !== items.length || seenOrders.size !== items.length) {
      return fail(response, 502, 'invalid_plan', 'AI 배치안에서 물건 위치가 빠지거나 겹쳤습니다. 다시 요청해 주세요.');
    }
    json(response, 200);
    response.end(JSON.stringify({ summary: String(parsed.summary || '').trim().slice(0, 180), placements: valid }));
  } catch (error) {
    const message = error.name === 'AbortError' ? 'AI 배치 계산이 오래 걸렸습니다. 물건 수를 줄여 다시 시도해 주세요.' : 'Ollama 로컬 서버에 연결하지 못했습니다. 서버 상태를 확인해 주세요.';
    return fail(response, error.name === 'AbortError' ? 504 : 502, 'planning_failed', message);
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
  if (url.pathname === '/api/presence') return updatePresence(request, response);
  if (url.pathname === '/api/admin/presence') return adminPresence(request, response);
  if (url.pathname === '/api/scan') {
    const startedAt = Date.now();
    const declaredBytes = Number(request.headers['content-length'] || 0);
    response.once('finish', () => {
      const imageBytes = Number.isFinite(declaredBytes) ? declaredBytes : 0;
      console.log(`[scan] ${new Date().toISOString()} status=${response.statusCode} elapsedMs=${Date.now() - startedAt} imageBytes=${imageBytes}`);
    });
    return scan(request, response);
  }
  if (url.pathname === '/api/plan') return plan(request, response);
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
