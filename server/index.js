const MODEL = "@cf/facebook/detr-resnet-50";
const MAX_IMAGE_BYTES = 2_000_000;
const MAX_REQUESTS_PER_MINUTE = 24;
const requestWindows = new Map();

const json = (body, status = 200, headers = {}) => new Response(JSON.stringify(body), {
  status,
  headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...headers },
});

function normalizeBox(raw, width, height) {
  const box = raw?.box ?? raw?.bbox ?? raw;
  if (!box) return null;
  const x1 = Number(box.xmin ?? box.x_min ?? box.left ?? box.x ?? box[0]);
  const y1 = Number(box.ymin ?? box.y_min ?? box.top ?? box.y ?? box[1]);
  const x2 = Number(box.xmax ?? box.x_max ?? box.right ?? box[2]);
  const y2 = Number(box.ymax ?? box.y_max ?? box.bottom ?? box[3]);
  if (![x1, y1, x2, y2].every(Number.isFinite)) return null;
  const scale = Math.max(Math.abs(x1), Math.abs(y1), Math.abs(x2), Math.abs(y2)) <= 1 ? 1 : 0;
  const coords = scale ? [x1, y1, x2, y2] : [x1 / width, y1 / height, x2 / width, y2 / height];
  const [left, top, right, bottom] = coords.map(value => Math.max(0, Math.min(1, value)));
  if (right <= left || bottom <= top) return null;
  return { x: left, y: top, w: right - left, h: bottom - top };
}

function normalizeDetections(output, width, height) {
  const rows = Array.isArray(output) ? output : output?.detections ?? output?.results ?? output?.result ?? [];
  return rows.slice(0, 50).flatMap((row, index) => {
    const label = String(row.label ?? row.class ?? row.name ?? "").trim();
    const score = Number(row.score ?? row.confidence ?? 0);
    const box = normalizeBox(row, width, height);
    if (!label || !box || !Number.isFinite(score)) return [];
    return [{ id: `${index}-${label}`, label: label.slice(0, 80), score: Math.max(0, Math.min(1, score)), box }];
  });
}

function allowedOrigin(request, env) {
  const origin = request.headers.get("origin");
  const configured = env.APP_ORIGIN;
  if (configured) return origin === configured;
  return origin === new URL(request.url).origin;
}

function rateLimited(request) {
  const ip = request.headers.get("cf-connecting-ip") ?? "unknown";
  const now = Date.now();
  const current = requestWindows.get(ip);
  if (!current || now - current.startedAt >= 60_000) {
    requestWindows.set(ip, { startedAt: now, count: 1 });
    if (requestWindows.size > 2_000) {
      for (const [key, value] of requestWindows) if (now - value.startedAt > 60_000) requestWindows.delete(key);
    }
    return false;
  }
  current.count += 1;
  return current.count > MAX_REQUESTS_PER_MINUTE;
}

async function scan(request, env) {
  if (request.method !== "POST") return json({ error: "method_not_allowed" }, 405, { allow: "POST" });
  if (!allowedOrigin(request, env)) return json({ error: "origin_not_allowed" }, 403);
  if (rateLimited(request)) return json({ error: "rate_limited", retryAfterSeconds: 60 }, 429, { "retry-after": "60" });
  const contentType = request.headers.get("content-type") ?? "";
  if (!/^image\/(jpeg|png|webp)$/.test(contentType.split(";")[0])) return json({ error: "image_required" }, 415);
  const declaredLength = Number(request.headers.get("content-length") ?? 0);
  if (declaredLength > MAX_IMAGE_BYTES) return json({ error: "image_too_large" }, 413);
  const image = await request.arrayBuffer();
  if (!image.byteLength || image.byteLength > MAX_IMAGE_BYTES) return json({ error: "image_too_large" }, 413);
  const width = Number(request.headers.get("x-image-width"));
  const height = Number(request.headers.get("x-image-height"));
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || width > 960 || height > 720) {
    return json({ error: "invalid_dimensions" }, 400);
  }
  if (!env.AI?.run) return json({ error: "server_ai_not_configured" }, 503);

  try {
    const startedAt = Date.now();
    const output = await env.AI.run(MODEL, { image: [...new Uint8Array(image)] });
    return json({ detections: normalizeDetections(output, width, height), elapsedMs: Date.now() - startedAt, model: MODEL });
  } catch {
    return json({ error: "inference_failed" }, 502);
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/api/health") return json({ status: "ok", serverInference: Boolean(env.AI?.run) });
    if (url.pathname === "/api/scan") return scan(request, env);
    if (env.ASSETS?.fetch) return env.ASSETS.fetch(request);
    return json({ error: "not_found" }, 404);
  },
};
