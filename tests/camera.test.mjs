import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('scan results stay visible and lead into a style plan and guided move', async () => {
  const html = await readFile(new URL('../dist/index.html', import.meta.url), 'utf8');
  const elements = new Map([...html.matchAll(/id="([^"]+)"/g)].map(([, id]) => [id, new FakeElement(id)]));
  Object.assign(elements.get('video'), { videoWidth: 1280, videoHeight: 720, play: async () => {} });
  const frames = [];
  let worker;
  let stopped = 0;
  let resolveScan;

  globalThis.document = {
    activeElement: { tagName: 'BODY' },
    getElementById: (id) => { assert.ok(elements.has(id), `Missing #${id}`); return elements.get(id); },
    createElement: (tag) => tag === 'canvas' ? new FakeCanvas() : new FakeElement(tag),
  };
  globalThis.window = { isSecureContext: true, devicePixelRatio: 1, addEventListener() {} };
  globalThis.requestAnimationFrame = (callback) => { frames.push(callback); return frames.length; };
  globalThis.setTimeout = () => 1;
  globalThis.clearTimeout = () => {};
  globalThis.fetch = async (url) => {
    if (url === '/api/health') return jsonResponse({ status: 'ok', modelAvailable: true });
    if (url === '/api/scan') return new Promise((resolve) => { resolveScan = resolve; });
    throw new Error(`Unexpected fetch ${url}`);
  };
  globalThis.Worker = class {
    constructor() { worker = this; }
    postMessage(message) {
      if (message.type === 'load') queueMicrotask(() => this.onmessage({ data: { type: 'ready', backend: 'wasm' } }));
      if (message.type === 'scan') queueMicrotask(() => {
        this.onmessage({ data: { type: 'scan-tile-start', id: message.id, index: 0, total: 9 } });
        this.onmessage({ data: {
          type: 'scan-tile-result', id: message.id, index: 0,
          results: [{ class: 'cup', score: 0.92, bbox: [0.25, 0.2, 0.18, 0.2] }],
        } });
        this.onmessage({ data: { type: 'scan-done', id: message.id, indices: [0], ms: 10 } });
      });
    }
    terminate() {}
  };
  const track = { stop() { stopped++; }, addEventListener() {} };
  const stream = { getTracks: () => [track], getVideoTracks: () => [track] };
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true, value: { mediaDevices: { getUserMedia: async () => stream } },
  });

  await import(`../dist/app.mjs?camera-test=${Date.now()}`);
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(worker);
  assert.equal(elements.get('scanButton').disabled, true, 'scan waits for a camera stream');

  await elements.get('startCamera').click();
  assert.equal(elements.get('video').srcObject, stream);
  assert.equal(elements.get('cameraEmpty').hidden, true);
  assert.equal(elements.get('scanButton').disabled, false);

  await elements.get('scanButton').click();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(elements.get('candidateSection').hidden, false, 'candidate section is selected by the candidates view');
  assert.equal(elements.get('drawerBody').hidden, false, 'results drawer opens as soon as scan completes');
  assert.equal(elements.get('candidates').children.length, 1, 'locally detected objects appear in the list');
  assert.equal(elements.get('candidateCount').textContent, '1');
  assert.equal(elements.get('continueStyleButton').disabled, true, 'style selection waits for Mac AI review');
  assert.equal(typeof resolveScan, 'function');

  resolveScan(jsonResponse({ detections: [{
    label: '책', score: 0.91, box: { x: 0.62, y: 0.24, w: 0.14, h: 0.2 },
  }] }));
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(elements.get('candidateCount').textContent, '2', 'server detections are merged into the list');
  assert.equal(elements.get('continueStyleButton').disabled, false, 'the next step unlocks after AI review');

  await elements.get('continueStyleButton').click();
  assert.equal(elements.get('candidateSection').hidden, true);
  assert.equal(elements.get('styleSection').hidden, false, 'style selection is reachable');
  await elements.get('makePlanButton').click();
  assert.equal(elements.get('styleSection').hidden, true);
  assert.equal(elements.get('planSection').hidden, false, 'a placement plan is generated');
  assert.equal(elements.get('planSteps').children.length, 2);
  await elements.get('startGuideButton').click();
  assert.equal(elements.get('planSection').hidden, true);
  assert.equal(elements.get('guideSection').hidden, false, 'guided movement is reachable');
  assert.equal(elements.get('guideObjectName').textContent, '컵');
  assert.equal(elements.get('guideProgressText').textContent, '진행 0 / 2');
  await elements.get('confirmMoveButton').click();
  assert.equal(elements.get('guideObjectName').textContent, '책');
  assert.equal(elements.get('guideProgressText').textContent, '진행 1 / 2');
  await elements.get('skipMoveButton').click();
  assert.equal(elements.get('guideStepCount').textContent, '안내 완료 · 1개 건너뜀');
  assert.equal(elements.get('finishGuideButton').textContent, '안내 종료');
  assert.equal(elements.get('guideProgressTrack').attributes.get('aria-valuenow'), '100');

  await elements.get('stopCamera').click();
  assert.equal(stopped, 1);
  assert.equal(elements.get('video').srcObject, null);
  assert.equal(elements.get('scanButton').disabled, true);
});

class FakeElement {
  constructor(id) {
    this.id = id;
    this.tagName = String(id).toUpperCase();
    this.hidden = false;
    this.disabled = false;
    this.value = id === 'facing' ? 'environment' : '';
    this.textContent = '';
    this.style = {};
    this.listeners = new Map();
    this.children = [];
    this.attributes = new Map();
    this.className = '';
    this.scrollTop = 0;
    this.classList = {
      values: new Set(),
      add: (name) => this.classList.values.add(name),
      remove: (name) => this.classList.values.delete(name),
      contains: (name) => this.classList.values.has(name),
      toggle: (name, force) => {
        const next = force ?? !this.classList.contains(name);
        if (next) this.classList.add(name); else this.classList.remove(name);
        return next;
      },
    };
    this.context = makeContext();
  }
  addEventListener(type, callback) { this.listeners.set(type, callback); }
  async click() { return this.listeners.get('click')?.({ target: this }); }
  setAttribute(name, value) { this.attributes.set(name, value); }
  querySelector(selector) {
    if (selector === 'span:last-child') return this.label = this.label || new FakeElement('button-label');
    if (selector === '.roi-label') return this.roiLabel = this.roiLabel || new FakeElement('roi-label');
    if (selector === 'strong') return this.strong = this.strong || Object.assign(new FakeElement('strong'), { tagName: 'STRONG' });
    return null;
  }
  querySelectorAll() { return []; }
  getBoundingClientRect() { return { width: 1280, height: 720, left: 0, top: 0 }; }
  setPointerCapture() {}
  getContext() { return this.context; }
  append(...items) { this.children.push(...items); }
  replaceChildren(...items) { this.children = items; }
  set innerHTML(value) {
    this._innerHTML = value;
    if (value.includes('<strong>')) this.querySelector('strong');
  }
}

class FakeCanvas extends FakeElement {
  constructor() {
    super('generated-canvas');
    this.width = 0;
    this.height = 0;
    this.context.drawImage = () => {};
    this.context.getImageData = (x, y, width, height) => ({ data: new Uint8ClampedArray(width * height * 4) });
  }
  toBlob(callback) { callback(new Blob(['frame'], { type: 'image/jpeg' })); }
}

function makeContext() {
  return {
    clearRect() {}, strokeRect() {}, fillRect() {}, fillText() {},
    measureText(text) { return { width: String(text).length * 8 }; },
    drawImage() {}, setLineDash() {}, save() {}, restore() {}, beginPath() {}, moveTo() {},
    quadraticCurveTo() {}, lineTo() {}, closePath() {}, fill() {}, stroke() {},
  };
}

function jsonResponse(value) {
  return { ok: true, json: async () => value };
}
