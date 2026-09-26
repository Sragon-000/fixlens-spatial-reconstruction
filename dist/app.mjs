import { DetectionState } from './detection-state.mjs';

const $ = (id) => document.getElementById(id);
const video = $('video');
const canvas = $('canvas');
const ctx = canvas.getContext('2d');
const capture = document.createElement('canvas');
const captureCtx = capture.getContext('2d');
const localCapture = document.createElement('canvas');
const localCaptureCtx = localCapture.getContext('2d', { willReadFrequently: true });
const detectionState = new DetectionState();
const LABELS = {
  'cell phone': '휴대폰', phone: '휴대폰', cable: '케이블', charger: '충전기', adapter: '어댑터',
  'power strip': '멀티탭', key: '열쇠', keys: '열쇠', wallet: '지갑', glasses: '안경', book: '책', pen: '펜',
  'remote': '리모컨', 'mouse': '마우스', 'keyboard': '키보드', 'laptop': '노트북', 'bottle': '병', 'cup': '컵',
};
const ENRICHMENT_INTERVAL_MS = 5_000;
const LOCAL_MAX_WIDTH = 480;
const SERVER_MAX_WIDTH = 960;

let stream = null;
let modelReady = false;
let detectorReady = false;
let recognitionActive = false;
let candidates = [];
let semanticCandidates = [];
let activeView = 'elements';
let toastTimer = null;
let serverScanActive = false;
let serverLoopGeneration = 0;
let inferenceWorker = null;

function setToast(message, persistent = false) {
  const toast = $('scanToast');
  toast.textContent = message;
  toast.hidden = !message;
  clearTimeout(toastTimer);
  if (message && !persistent) toastTimer = setTimeout(() => { toast.hidden = true; }, 4500);
}

function setDrawerOpen(open) {
  $('drawer').classList.toggle('open', open);
  $('drawerHandle').setAttribute('aria-expanded', String(open));
  $('drawerBody').hidden = !open;
}

function setView(view) {
  activeView = view;
  const layout = view === 'layout';
  $('candidateSection').hidden = layout;
  $('layoutSection').hidden = !layout;
  $('drawerLabel').textContent = layout
    ? `${$('zoneName').value.trim() || '공간'} · 2D 배치도`
    : `공간 요소 · ${candidates.length}개`;
}

function normalizedLabel(label) {
  const trimmed = String(label || '').trim().slice(0, 48);
  return LABELS[trimmed.toLowerCase()] || trimmed;
}

function updateActionButton() {
  const button = $('scanButton');
  button.disabled = !stream || !detectorReady;
  button.setAttribute('aria-pressed', String(recognitionActive));
  button.classList.toggle('is-live', recognitionActive);
  button.querySelector('span:last-child').textContent = recognitionActive ? '실시간 감지 중지' : '실시간 감지 시작';
}

async function checkHealth() {
  try {
    const response = await fetch('/api/health', { cache: 'no-store' });
    const data = await response.json();
    modelReady = response.ok && data.status === 'ok' && data.modelAvailable;
  } catch { modelReady = false; }
  if (!modelReady && recognitionActive) {
    setToast('실시간 윤곽 감지는 작동 중이에요. Mac AI 연결 후 물체 이름을 보완합니다.', true);
  }
}

function stopRecognition() {
  recognitionActive = false;
  serverLoopGeneration++;
  semanticCandidates = [];
  detectionState.clear();
  updateCandidates(performance.now());
  updateActionButton();
}

function stopCamera(message = '카메라가 꺼져 있어요.') {
  stopRecognition();
  if (stream) stream.getTracks().forEach((track) => track.stop());
  stream = null;
  video.srcObject = null;
  $('cameraEmpty').hidden = false;
  $('emptyTitle').textContent = '공간을 비춰주세요';
  $('cameraMessage').textContent = message;
  $('startCamera').disabled = false;
  $('stopCamera').disabled = true;
  updateActionButton();
  ctx.clearRect(0, 0, canvas.width, canvas.height);
}

async function startCamera() {
  if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
    $('cameraMessage').textContent = '카메라를 사용하려면 HTTPS 주소로 열어주세요.';
    return;
  }
  $('startCamera').disabled = true;
  try {
    const acquired = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: { facingMode: { ideal: $('facing').value }, width: { ideal: 1280 }, height: { ideal: 720 } },
    });
    stream = acquired;
    video.srcObject = acquired;
    await video.play();
    $('cameraEmpty').hidden = true;
    $('stopCamera').disabled = false;
    updateActionButton();
    acquired.getVideoTracks().forEach((track) => track.addEventListener('ended', () => stopCamera('카메라 연결이 끝났어요.')));
    resizeCanvas();
    draw();
  } catch (error) {
    const messages = {
      NotAllowedError: '카메라 권한을 허용해 주세요.',
      NotFoundError: '카메라를 찾지 못했어요.',
      NotReadableError: '다른 앱이 카메라를 사용 중인지 확인해 주세요.',
    };
    $('cameraMessage').textContent = messages[error.name] || '카메라를 연결하지 못했어요.';
    $('startCamera').disabled = false;
  }
}

function resizeCanvas() {
  if (!video.videoWidth || !video.videoHeight) return;
  if (canvas.width !== video.videoWidth || canvas.height !== video.videoHeight) {
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
  }
}

function overlap(a, b) {
  const left = Math.max(a.x, b.x); const top = Math.max(a.y, b.y);
  const right = Math.min(a.x + a.w, b.x + b.w); const bottom = Math.min(a.y + a.h, b.y + b.h);
  const area = Math.max(0, right - left) * Math.max(0, bottom - top);
  return area / (a.w * a.h + b.w * b.h - area || 1);
}

function updateCandidates(now) {
  const local = detectionState.visible(now).map((item) => ({
    name: normalizedLabel(item.name), score: item.score,
    box: { x: item.x, y: item.y, w: item.w, h: item.h }, keep: true, source: 'device',
  }));
  const semantics = semanticCandidates.filter((item) => item.expiresAt > now);
  const matchedSemantic = new Set();
  candidates = local.map((item) => {
    let best = -1; let bestOverlap = 0.08;
    semantics.forEach((semantic, index) => {
      const score = overlap(item.box, semantic.box);
      if (score > bestOverlap) { best = index; bestOverlap = score; }
    });
    if (best < 0) return item;
    matchedSemantic.add(best);
    return { ...item, name: normalizedLabel(semantics[best].name), score: semantics[best].score, source: 'server' };
  });
  semantics.forEach((item, index) => {
    if (!matchedSemantic.has(index) && item.score >= 0.45) {
      candidates.push({ name: normalizedLabel(item.name), score: item.score, box: item.box, keep: true, source: 'server' });
    }
  });
  candidates = candidates.slice(0, 30);
  updateLayoutButton();
  if (recognitionActive && activeView === 'layout') buildLayout();
  draw();
}

function draw() {
  resizeCanvas();
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  const boxes = candidates.filter((item) => item.keep);
  const scale = canvas.width / 960;
  ctx.lineWidth = Math.max(2, 3 * scale);
  ctx.font = `${Math.max(13, 18 * scale)}px -apple-system, sans-serif`;
  for (const item of boxes) {
    const { x, y, w, h } = item.box;
    const bx = x * canvas.width; const by = y * canvas.height;
    const bw = w * canvas.width; const bh = h * canvas.height;
    ctx.strokeStyle = item.source === 'server' ? '#d6a65a' : '#849579';
    ctx.strokeRect(bx, by, bw, bh);
    const label = normalizedLabel(item.name);
    const textWidth = ctx.measureText(label).width;
    const labelY = Math.max(0, by - 28 * scale);
    ctx.fillStyle = item.source === 'server' ? '#f5e4bf' : '#f3efe3';
    ctx.fillRect(Math.max(0, bx), labelY, textWidth + 16 * scale, 25 * scale);
    ctx.fillStyle = '#303b31';
    ctx.fillText(label, Math.max(0, bx) + 8 * scale, labelY + 18 * scale);
  }
}

function updateLayoutButton() {
  const count = candidates.filter((item) => item.keep && item.name.trim()).length;
  $('candidateCount').textContent = String(count);
  $('createLayoutButton').disabled = count === 0;
  $('createLayoutButton').textContent = count ? `2D 배치도 만들기 · ${count}개` : '공간 요소를 먼저 확인해요';
  $('drawerLabel').textContent = activeView === 'layout'
    ? `${$('zoneName').value.trim() || '공간'} · 2D 배치도`
    : `공간 요소 · ${candidates.length}개`;
}

function renderCandidates() {
  const list = $('candidates');
  list.replaceChildren();
  if (!candidates.length) {
    const empty = document.createElement('li');
    empty.className = 'empty-result';
    empty.textContent = '카메라에 물체를 비추면 윤곽을 표시해요.';
    list.append(empty);
  }
  for (const item of candidates) {
    const row = document.createElement('li');
    row.className = 'candidate-row';
    const label = document.createElement('label');
    label.className = 'check-label';
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox'; checkbox.checked = item.keep;
    checkbox.setAttribute('aria-label', `${item.name} 배치도에 포함`);
    checkbox.addEventListener('change', () => { item.keep = checkbox.checked; updateLayoutButton(); draw(); });
    const name = document.createElement('input');
    name.className = 'candidate-name'; name.value = item.name; name.maxLength = 48;
    name.setAttribute('aria-label', '공간 요소 이름');
    name.addEventListener('input', () => { item.name = name.value; draw(); });
    label.append(checkbox, name);
    row.append(label);
    list.append(row);
  }
  updateLayoutButton();
}

function buildLayout() {
  const items = candidates.filter((item) => item.keep && item.name.trim());
  const map = $('layoutCanvas');
  map.replaceChildren();
  for (const item of items) {
    const node = document.createElement('span');
    node.className = 'map-object';
    node.textContent = item.name;
    node.style.left = `${Math.max(1, Math.min(88, item.box.x * 100))}%`;
    node.style.top = `${Math.max(2, Math.min(82, item.box.y * 100))}%`;
    node.style.width = `${Math.max(10, Math.min(38, item.box.w * 100))}%`;
    node.style.height = `${Math.max(11, Math.min(28, item.box.h * 100))}%`;
    map.append(node);
  }
  $('layoutCanvas').setAttribute('aria-label', `${$('zoneName').value.trim() || '공간'}의 현재 화면 기준 2D 배치도 초안`);
}

function createLayout() {
  buildLayout();
  setView('layout');
  setDrawerOpen(true);
}

function captureDimensions(maxWidth) {
  const ratio = Math.min(1, maxWidth / video.videoWidth, 720 / video.videoHeight);
  return { width: Math.max(1, Math.round(video.videoWidth * ratio)), height: Math.max(1, Math.round(video.videoHeight * ratio)) };
}

function runLocalDetectorFrame(now) {
  if (!recognitionActive || !stream || !detectorReady || !video.videoWidth || !video.videoHeight) return;
  if (detectionState.pending || now - (detectionState.capturedAt || 0) < 130) return;
  const { width, height } = captureDimensions(LOCAL_MAX_WIDTH);
  localCapture.width = width; localCapture.height = height;
  localCaptureCtx.drawImage(video, 0, 0, width, height);
  const pixels = localCaptureCtx.getImageData(0, 0, width, height);
  const job = detectionState.begin(now, width, height);
  if (job) inferenceWorker.postMessage({ type: 'detect', id: job.id, width, height, pixels: pixels.data.buffer }, [pixels.data.buffer]);
}

async function enrichWithServer(generation) {
  if (!modelReady || !recognitionActive || !stream || generation !== serverLoopGeneration || serverScanActive || !video.videoWidth) return;
  serverScanActive = true;
  try {
    const { width, height } = captureDimensions(SERVER_MAX_WIDTH);
    capture.width = width; capture.height = height;
    captureCtx.drawImage(video, 0, 0, width, height);
    const blob = await new Promise((resolve) => capture.toBlob(resolve, 'image/jpeg', 0.82));
    if (!blob || !recognitionActive || generation !== serverLoopGeneration) return;
    const response = await fetch('/api/scan', {
      method: 'POST',
      headers: { 'content-type': 'image/jpeg', 'x-image-width': String(width), 'x-image-height': String(height) },
      body: blob,
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.message || 'Mac AI가 장면 이름을 보완하지 못했어요.');
    if (!recognitionActive || generation !== serverLoopGeneration) return;
    semanticCandidates = (result.detections || []).map((item) => ({
      name: item.label,
      score: item.score,
      box: item.box,
      expiresAt: performance.now() + ENRICHMENT_INTERVAL_MS * 1.5,
    }));
    updateCandidates(performance.now());
    setToast('기기에서 윤곽을 추적하고 Mac AI가 이름을 보완 중이에요.');
  } catch (error) {
    if (recognitionActive && generation === serverLoopGeneration) setToast(error.message || 'Mac AI 서버 연결을 확인해 주세요.', true);
  } finally { serverScanActive = false; }
}

async function serverEnrichmentLoop(generation) {
  while (recognitionActive && stream && generation === serverLoopGeneration) {
    await enrichWithServer(generation);
    if (!recognitionActive || generation !== serverLoopGeneration) break;
    await new Promise((resolve) => setTimeout(resolve, ENRICHMENT_INTERVAL_MS));
  }
}

function startRecognition() {
  if (!stream || !detectorReady) return;
  recognitionActive = true;
  semanticCandidates = [];
  updateActionButton();
  setToast(modelReady
    ? '실시간 윤곽 감지를 시작했어요. 서버 AI가 물체 이름도 보완합니다.'
    : '실시간 윤곽 감지를 시작했어요. Mac AI 연결이 없어 이름 보완은 꺼져 있습니다.', true);
  serverEnrichmentLoop(++serverLoopGeneration);
}

function toggleRecognition() {
  if (recognitionActive) {
    stopRecognition();
    setToast('실시간 감지를 멈췄어요.');
  } else startRecognition();
}

function animate(now) {
  if (recognitionActive) runLocalDetectorFrame(now);
  requestAnimationFrame(animate);
}

function initializeDetector() {
  try {
    inferenceWorker = new Worker(new URL('./inference-worker.js', import.meta.url));
    inferenceWorker.onmessage = ({ data }) => {
      if (data.type === 'ready') {
        detectorReady = true;
        updateActionButton();
        $('cameraMessage').textContent = '감지 모델 준비 완료 · 카메라를 켜고 실시간 감지를 시작하세요.';
        return;
      }
      if (data.type === 'load-error') {
        detectorReady = false;
        updateActionButton();
        $('cameraMessage').textContent = '기기 물체 감지 모델을 불러오지 못했어요.';
        setToast(`실시간 감지 모델 오류: ${data.message}`, true);
        return;
      }
      if (data.type === 'result') {
        detectionState.accept(data, performance.now());
        updateCandidates(performance.now());
      }
      if (data.type === 'inference-error' && detectionState.pending?.id === data.id) {
        detectionState.accept({ id: data.id, results: [] }, performance.now());
        updateCandidates(performance.now());
      }
    };
    inferenceWorker.onerror = () => {
      detectorReady = false;
      stopRecognition();
      setToast('실시간 감지 워커를 실행하지 못했어요.', true);
    };
    inferenceWorker.postMessage({ type: 'load' });
  } catch (error) {
    detectorReady = false;
    setToast(`실시간 감지를 시작하지 못했어요: ${error.message}`, true);
  }
}

$('startCamera').addEventListener('click', startCamera);
$('stopCamera').addEventListener('click', () => stopCamera());
$('scanButton').addEventListener('click', toggleRecognition);
$('createLayoutButton').addEventListener('click', createLayout);
$('rescanButton').addEventListener('click', () => { semanticCandidates = []; setView('elements'); renderCandidates(); draw(); });
$('drawerHandle').addEventListener('click', () => {
  if ($('drawer').classList.contains('open')) setDrawerOpen(false);
  else { setView(activeView); renderCandidates(); setDrawerOpen(true); }
});
$('facing').addEventListener('change', () => { if (stream) { const wasActive = recognitionActive; stopCamera(); startCamera().then(() => { if (wasActive && stream) startRecognition(); }); } });
video.addEventListener('loadedmetadata', () => { resizeCanvas(); draw(); });
window.addEventListener('pagehide', () => {
  if (stream) stream.getTracks().forEach((track) => track.stop());
  if (inferenceWorker) inferenceWorker.terminate();
});

initializeDetector();
checkHealth();
requestAnimationFrame(animate);
