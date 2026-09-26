import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('camera opens, local worker draws live detections, and stop releases the stream', async () => {
  const html = await readFile(new URL('../dist/index.html', import.meta.url), 'utf8');
  const elements = new Map([...html.matchAll(/id="([^"]+)"/g)].map(([, id]) => [id, new FakeElement(id)]));
  Object.assign(elements.get('video'), { videoWidth: 1280, videoHeight: 720, play: async () => {} });
  const frames = [];
  let worker;
  let stopped = 0;
  let scanRequest;

  globalThis.document = {
    activeElement: { tagName: 'BODY' },
    getElementById: (id) => { assert.ok(elements.has(id), `Missing #${id}`); return elements.get(id); },
    createElement: (tag) => tag === 'canvas' ? new FakeCanvas() : new FakeElement(tag),
  };
  globalThis.window = { isSecureContext: true, addEventListener() {} };
  globalThis.requestAnimationFrame = (callback) => { frames.push(callback); return frames.length; };
  globalThis.setTimeout = () => 1;
  globalThis.clearTimeout = () => {};
  globalThis.fetch = async (url) => {
    if (url === '/api/health') return jsonResponse({ status: 'ok', modelAvailable: true });
    if (url === '/api/scan') return new Promise((resolve) => { scanRequest = () => resolve(jsonResponse({ detections: [] })); });
    throw new Error(`Unexpected fetch ${url}`);
  };
  globalThis.Worker = class {
    constructor() { worker = this; }
    postMessage(message) {
      if (message.type === 'load') queueMicrotask(() => this.onmessage({ data: { type: 'ready', backend: 'wasm' } }));
      if (message.type === 'detect') queueMicrotask(() => this.onmessage({ data: {
        type: 'result', id: message.id,
        results: [{ class: 'cup', score: 0.92, bbox: [100, 80, 120, 100] }],
      } }));
    }
    terminate() {}
  };
  const track = { stop() { stopped++; }, addEventListener() {} };
  const stream = { getTracks: () => [track], getVideoTracks: () => [track] };
  const mediaDevices = { getUserMedia: async () => stream };
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { mediaDevices } });

  await import(`../dist/app.mjs?camera-test=${Date.now()}`);
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(worker);
  assert.equal(elements.get('scanButton').disabled, true, 'camera action waits for a stream');

  await elements.get('startCamera').click();
  assert.equal(elements.get('video').srcObject, stream);
  assert.equal(elements.get('cameraEmpty').hidden, true);
  assert.equal(elements.get('scanButton').disabled, false);

  await elements.get('scanButton').click();
  const frame = frames.shift();
  assert.equal(typeof frame, 'function');
  frame(1000);
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(elements.get('canvas').context.strokeCount > 0, 'a detected object gets a visible box');
  assert.equal(elements.get('drawerLabel').textContent, '공간 요소 · 1개');

  await elements.get('stopCamera').click();
  assert.equal(stopped, 1);
  assert.equal(elements.get('video').srcObject, null);
  assert.equal(elements.get('scanButton').disabled, true);
  scanRequest?.();
});

class FakeElement {
  constructor(id) {
    this.id = id; this.hidden = false; this.disabled = false; this.value = id === 'facing' ? 'environment' : '';
    this.textContent = ''; this.style = {}; this.listeners = new Map(); this.children = [];
    this.attributes = new Map(); this.className = '';
    this.classList = {
      values: new Set(),
      add: (name) => this.classList.values.add(name),
      remove: (name) => this.classList.values.delete(name),
      contains: (name) => this.classList.values.has(name),
      toggle: (name, force) => { const next = force ?? !this.classList.contains(name); if (next) this.classList.add(name); else this.classList.remove(name); return next; },
    };
    this.context = makeContext();
  }
  addEventListener(type, callback) { this.listeners.set(type, callback); }
  async click() { return this.listeners.get('click')?.({ target: this }); }
  setAttribute(name, value) { this.attributes.set(name, value); }
  querySelector(selector) { if (selector === 'span:last-child') return this.label = this.label || new FakeElement('button-label'); return null; }
  getContext() { return this.context; }
  append(...items) { this.children.push(...items); }
  replaceChildren(...items) { this.children = items; }
}

class FakeCanvas extends FakeElement {
  constructor() {
    super('generated-canvas');
    this.width = 0; this.height = 0;
    this.context.drawImage = () => {};
    this.context.getImageData = (x, y, width, height) => ({ data: new Uint8ClampedArray(width * height * 4) });
  }
  toBlob(callback) { callback(new Blob(['frame'], { type: 'image/jpeg' })); }
}

function makeContext() {
  return {
    strokeCount: 0,
    clearRect() {},
    strokeRect() { this.strokeCount++; },
    fillRect() {},
    fillText() {},
    measureText(text) { return { width: String(text).length * 8 }; },
    drawImage() {},
  };
}

function jsonResponse(value) {
  return { ok: true, json: async () => value };
}
