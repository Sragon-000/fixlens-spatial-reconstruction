import { DetectionState } from './detection-state.mjs';
import { ArAnchorPreview } from './ar-anchor-preview.mjs';

const $ = (id) => document.getElementById(id);
const video = $('video');
const canvas = $('canvas');
const ctx = canvas.getContext('2d');
const capture = document.createElement('canvas');
const captureCtx = capture.getContext('2d');
const localCapture = document.createElement('canvas');
const localCaptureCtx = localCapture.getContext('2d', { willReadFrequently: true });
const detectionState = new DetectionState();
let webxrArSupported = false;
let guideCameraResumePromise = null;
const arAnchorPreview = new ArAnchorPreview({
  canvas: $('arCanvas'), overlay: $('arOverlay'), message: $('arOverlayMessage'), exitButton: $('arExitButton'),
  onEnd: () => { void restoreGuideCameraAfterAr(); },
});
const LABELS = {
  'cell phone': '휴대폰', phone: '휴대폰', cable: '케이블', charger: '충전기', adapter: '어댑터',
  'power strip': '멀티탭', key: '열쇠', keys: '열쇠', wallet: '지갑', glasses: '안경', book: '책', pen: '펜',
  'remote': '리모컨', 'mouse': '마우스', 'keyboard': '키보드', 'laptop': '노트북', 'bottle': '병', 'cup': '컵',
};
const LOCAL_MAX_WIDTH = 480;
const SERVER_MAX_WIDTH = 960;
const SCAN_COLUMNS = 3;
const SCAN_ROWS = 3;
const SCAN_TILE_COUNT = SCAN_COLUMNS * SCAN_ROWS;
const PRESENCE_CLIENT_ID = (() => {
  try {
    const key = 'fixlens.presence-client';
    const existing = sessionStorage.getItem(key);
    if (existing) return existing;
    const created = crypto.randomUUID?.() || `tab-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    sessionStorage.setItem(key, created);
    return created;
  } catch { return `tab-${Date.now()}-${Math.random().toString(36).slice(2)}`; }
})();

let stream = null;
let fullscreenRequestedByApp = false;
let modelReady = false;
let detectorReady = false;
let recognitionActive = false;
let candidates = [];
let activeView = 'candidates';
let toastTimer = null;
let inferenceWorker = null;
let workflowStage = 'idle';
let roiView = { x: .1, y: .16, w: .8, h: .68 };
let activeRoiVideo = null;
let roiPointer = null;
let scanJobId = 0;
let scanSessionId = 0;
let scanTileStates = Array(SCAN_TILE_COUNT).fill('pending');
let scanResultsByTile = Array(SCAN_TILE_COUNT).fill(null);
let scanRoiBlobPromise = null;
let scanSessionRoiVideo = null;
let scanRoiEnrichmentRequested = false;
let scanAiStatus = 'unavailable';
let candidateReviewTouched = false;
let selectedStyle = 'minimal';
let arrangement = [];
let guideIndex = 0;
let skippedGuideSteps = 0;
let targetDetected = false;
let movementEvidence = null;

function sendPresence(online = true) {
  const completedTiles = scanTileStates.filter((state) => state === 'done').length;
  const payload = {
    clientId: PRESENCE_CLIENT_ID, online, camera: Boolean(stream), stage: workflowStage,
    count: candidates.filter((item) => item.keep && item.name.trim()).length,
    progress: workflowStage === 'scanning'
      ? { done: completedTiles, total: SCAN_TILE_COUNT }
      : workflowStage === 'guiding' ? { done: guideIndex, total: arrangement.length } : null,
  };
  const body = JSON.stringify(payload);
  if (!online && navigator.sendBeacon) {
    navigator.sendBeacon('/api/presence', new Blob([body], { type: 'application/json' }));
    return;
  }
  void fetch('/api/presence', { method: 'POST', headers: { 'content-type': 'application/json' }, body, keepalive: true }).catch(() => {});
}

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
  const sectionByView = {
    candidates: 'candidateSection', style: 'styleSection', plan: 'planSection', guide: 'guideSection',
  };
  const activeSection = sectionByView[view] || sectionByView.candidates;
  for (const section of ['candidateSection', 'styleSection', 'planSection', 'guideSection']) {
    $(section).hidden = section !== activeSection;
  }
  const names = { candidates: '스캔한 물건', style: '정리 스타일', plan: '정리 배치안', guide: '정리 안내' };
  $('drawerLabel').textContent = `${$('zoneName').value.trim() || '공간'} · ${names[view] || '정리'}`;
  sendPresence();
}

function normalizedLabel(label) {
  const trimmed = String(label || '').trim().slice(0, 48);
  return LABELS[trimmed.toLowerCase()] || trimmed;
}

function updateActionButton() {
  const button = $('scanButton');
  button.disabled = !stream || !detectorReady || workflowStage === 'scanning';
  const liveStage = workflowStage === 'scanning' || workflowStage === 'guiding';
  button.setAttribute('aria-pressed', String(liveStage));
  button.classList.toggle('is-live', liveStage);
  const label = workflowStage === 'scanning' ? '분석 중' : workflowStage === 'idle' || workflowStage === 'ready' ? '공간 스캔 시작' : '다시 스캔';
  button.querySelector('span:last-child').textContent = label;
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

function stopRecognition(clearResults = true) {
  recognitionActive = false;
  detectionState.clear();
  if (clearResults) updateCandidates(performance.now());
  updateActionButton();
}

function stopCamera(message = '카메라가 꺼져 있어요.') {
  stopRecognition();
  workflowStage = 'idle';
  $('scanProgress').hidden = true;
  $('roiHint').hidden = true;
  $('roiSelection').hidden = true;
  setView('candidates');
  if (stream) stream.getTracks().forEach((track) => track.stop());
  stream = null;
  video.srcObject = null;
  $('cameraEmpty').hidden = false;
  $('arCapability').hidden = true;
  $('emptyTitle').textContent = '공간을 비춰주세요';
  $('cameraMessage').textContent = message;
  $('startCamera').disabled = false;
  $('stopCamera').disabled = true;
  document.body.classList.remove('camera-live');
  screen.orientation?.unlock?.();
  if (fullscreenRequestedByApp && document.fullscreenElement) void document.exitFullscreen().catch(() => {});
  fullscreenRequestedByApp = false;
  updateActionButton();
  ctx.clearRect(0, 0, canvas.width, canvas.height);
}

function requestCameraPresentation() {
  let fullscreen = Promise.resolve();
  if (!document.fullscreenElement && document.documentElement.requestFullscreen) {
    fullscreen = document.documentElement.requestFullscreen({ navigationUI: 'hide' })
      .then(() => { fullscreenRequestedByApp = Boolean(document.fullscreenElement); })
      .catch(() => {});
  }
  void fullscreen.then(() => screen.orientation?.lock?.('landscape').catch(() => {}));
}

async function startCamera() {
  if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
    $('cameraMessage').textContent = '카메라를 사용하려면 HTTPS 주소로 열어주세요.';
    return;
  }
  $('startCamera').disabled = true;
  requestCameraPresentation();
  try {
    const acquired = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: { facingMode: { ideal: $('facing').value }, width: { ideal: 1280 }, height: { ideal: 720 } },
    });
    stream = acquired;
    video.srcObject = acquired;
    await video.play();
    const returningToGuide = workflowStage === 'guiding';
    if (returningToGuide) {
      detectionState.clear();
      detectionState.seed(arrangement.map((step) => ({
        name: step.sourceName, sourceName: step.sourceName, detectorName: step.detectorName,
        trackId: step.trackId, box: step.source, score: 1,
      })));
      resetMovementEvidence();
      recognitionActive = true;
    } else {
      workflowStage = 'ready';
    }
    sendPresence();
    $('cameraEmpty').hidden = true;
    document.body.classList.add('camera-live');
    $('startCamera').textContent = '카메라 켜기';
    $('arCapability').hidden = false;
    $('arCapability').textContent = 'AR 세션 지원 확인 중';
    void updateArCapability();
    $('stopCamera').disabled = false;
    updateActionButton();
    acquired.getVideoTracks().forEach((track) => track.addEventListener('ended', () => stopCamera('카메라 연결이 끝났어요.')));
    resizeCanvas();
    updateRoiOverlay();
    draw();
  } catch (error) {
    const messages = {
      NotAllowedError: '카메라 권한을 허용해 주세요.',
      NotFoundError: '카메라를 찾지 못했어요.',
      NotReadableError: '다른 앱이 카메라를 사용 중인지 확인해 주세요.',
    };
    $('cameraMessage').textContent = messages[error.name] || '카메라를 연결하지 못했어요.';
    $('startCamera').disabled = false;
    if (fullscreenRequestedByApp && document.fullscreenElement) void document.exitFullscreen().catch(() => {});
    fullscreenRequestedByApp = false;
  }
}

async function updateArCapability() {
  const status = $('arCapability');
  if (!stream) { status.hidden = true; webxrArSupported = false; return; }
  if (!window.isSecureContext || !navigator.xr?.isSessionSupported) {
    webxrArSupported = false;
    status.textContent = '공간 고정 AR 미지원 · 화면 추적 모드';
    if (workflowStage === 'guiding') showGuideStep();
    return;
  }
  try {
    const supported = await navigator.xr.isSessionSupported('immersive-ar');
    if (!stream) return;
    webxrArSupported = supported;
    status.textContent = supported
      ? 'AR 세션 가능 · 시작 시 필수 기능 확인'
      : '공간 고정 AR 미지원 · 화면 추적 모드';
    if (workflowStage === 'guiding') showGuideStep();
  } catch {
    if (!stream) return;
    webxrArSupported = false;
    status.textContent = 'AR 지원을 확인할 수 없음 · 화면 추적 모드';
    if (workflowStage === 'guiding') showGuideStep();
  }
}

async function startArAnchorGuide() {
  if (!webxrArSupported || workflowStage !== 'guiding' || !stream) return;
  $('startArAnchorButton').disabled = true;
  recognitionActive = false;
  detectionState.clear();
  stream.getTracks().forEach((track) => track.stop());
  stream = null;
  video.srcObject = null;
  document.body.classList.remove('camera-live');
  $('arCapability').hidden = true;
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  updateActionButton();
  try {
    await arAnchorPreview.start();
  } catch (error) {
    const reason = error.name === 'NotSupportedError'
      ? '이 기기에서 표면 인식 또는 AR 화면 조작을 지원하지 않아요.'
      : error.message;
    setToast(`AR 위치 고정을 시작하지 못했어요: ${reason}`, true);
    await restoreGuideCameraAfterAr();
  } finally {
    $('startArAnchorButton').disabled = false;
  }
}

function restoreGuideCameraAfterAr() {
  if (stream) return Promise.resolve();
  if (guideCameraResumePromise) return guideCameraResumePromise;
  guideCameraResumePromise = (async () => {
    try {
      const acquired = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: { facingMode: { ideal: $('facing').value }, width: { ideal: 1280 }, height: { ideal: 720 } },
      });
      stream = acquired;
      video.srcObject = acquired;
      await video.play();
      workflowStage = 'guiding';
      detectionState.clear();
      detectionState.seed(arrangement.map((step) => ({
        name: step.sourceName, sourceName: step.sourceName, detectorName: step.detectorName,
        trackId: step.trackId, box: step.source, score: 1,
      })));
      resetMovementEvidence();
      recognitionActive = true;
      $('cameraEmpty').hidden = true;
      document.body.classList.add('camera-live');
      $('startCamera').textContent = '카메라 켜기';
      $('arCapability').hidden = false;
      $('arCapability').textContent = 'AR 세션 사용 후 · 화면 추적 모드';
      $('stopCamera').disabled = false;
      acquired.getVideoTracks().forEach((track) => track.addEventListener('ended', () => stopCamera('카메라 연결이 끝났어요.')));
      resizeCanvas();
      updateActionButton();
      if (arrangement[guideIndex]) setDrawerOpen(false);
      showGuideStep();
      draw();
    } catch (error) {
      stream = null;
      recognitionActive = false;
      $('cameraEmpty').hidden = false;
      document.body.classList.remove('camera-live');
      $('emptyTitle').textContent = '카메라를 다시 연결해 주세요';
      $('cameraMessage').textContent = 'AR 안내를 마쳤어요. 카메라를 다시 켜면 물체 추적을 이어갈 수 있어요.';
      $('startCamera').textContent = '카메라 다시 켜기';
      $('startCamera').disabled = false;
      setToast(`카메라를 다시 연결하지 못했어요: ${error.message}`, true);
      updateActionButton();
    } finally {
      guideCameraResumePromise = null;
    }
  })();
  return guideCameraResumePromise;
}

function resizeCanvas() {
  if (!video.videoWidth || !video.videoHeight) return;
  if (canvas.width !== video.videoWidth || canvas.height !== video.videoHeight) {
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
  }
}

function updateRoiOverlay() {
  const overlay = $('roiSelection');
  overlay.hidden = !stream;
  if (!stream) return;
  overlay.style.left = `${roiView.x * 100}%`;
  overlay.style.top = `${roiView.y * 100}%`;
  overlay.style.width = `${roiView.w * 100}%`;
  overlay.style.height = `${roiView.h * 100}%`;
  const editable = workflowStage === 'ready';
  overlay.classList.toggle('locked', !editable);
  $('roiHint').hidden = !editable;
  $('roiHint').textContent = editable
    ? '사각형 안쪽을 끌어 이동하고 모서리로 크기를 조절하세요.'
    : '선택한 영역을 분석하고 있어요.';
  $('roiSelection').querySelector('.roi-label').textContent = editable ? '스캔 영역' : '선택한 영역';
}

function videoRoiFromView() {
  const bounds = $('stage').getBoundingClientRect();
  if (!bounds.width || !bounds.height || !video.videoWidth || !video.videoHeight) return { x: 0, y: 0, w: 1, h: 1 };
  const scale = Math.max(bounds.width / video.videoWidth, bounds.height / video.videoHeight);
  const renderedWidth = video.videoWidth * scale;
  const renderedHeight = video.videoHeight * scale;
  const offsetX = (bounds.width - renderedWidth) / 2;
  const offsetY = (bounds.height - renderedHeight) / 2;
  const left = (roiView.x * bounds.width - offsetX) / renderedWidth;
  const top = (roiView.y * bounds.height - offsetY) / renderedHeight;
  const right = ((roiView.x + roiView.w) * bounds.width - offsetX) / renderedWidth;
  const bottom = ((roiView.y + roiView.h) * bounds.height - offsetY) / renderedHeight;
  const x = Math.max(0, Math.min(.99, left));
  const y = Math.max(0, Math.min(.99, top));
  const endX = Math.max(x + .01, Math.min(1, right));
  const endY = Math.max(y + .01, Math.min(1, bottom));
  return { x, y, w: endX - x, h: endY - y };
}

function beginRoiDrag(event) {
  if (workflowStage !== 'ready' || event.button !== undefined && event.button !== 0) return;
  event.preventDefault();
  const bounds = $('stage').getBoundingClientRect();
  const handle = event.target.closest('[data-handle]')?.dataset.handle || 'move';
  roiPointer = {
    id: event.pointerId,
    handle,
    startX: event.clientX,
    startY: event.clientY,
    bounds,
    origin: { ...roiView },
  };
  $('roiSelection').setPointerCapture?.(event.pointerId);
}

function moveRoiDrag(event) {
  if (!roiPointer || event.pointerId !== roiPointer.id) return;
  const dx = (event.clientX - roiPointer.startX) / roiPointer.bounds.width;
  const dy = (event.clientY - roiPointer.startY) / roiPointer.bounds.height;
  const { x, y, w, h } = roiPointer.origin;
  const minSize = .15;
  if (roiPointer.handle === 'move') {
    roiView = { ...roiPointer.origin, x: Math.max(0, Math.min(1 - w, x + dx)), y: Math.max(0, Math.min(1 - h, y + dy)) };
  } else {
    let left = x; let right = x + w; let top = y; let bottom = y + h;
    if (roiPointer.handle.includes('w')) left = Math.max(0, Math.min(right - minSize, left + dx));
    if (roiPointer.handle.includes('e')) right = Math.min(1, Math.max(left + minSize, right + dx));
    if (roiPointer.handle.includes('n')) top = Math.max(0, Math.min(bottom - minSize, top + dy));
    if (roiPointer.handle.includes('s')) bottom = Math.min(1, Math.max(top + minSize, bottom + dy));
    roiView = { x: left, y: top, w: right - left, h: bottom - top };
  }
  updateRoiOverlay();
}

function endRoiDrag(event) {
  if (!roiPointer || event.pointerId !== roiPointer.id) return;
  roiPointer = null;
}

function overlap(a, b) {
  const left = Math.max(a.x, b.x); const top = Math.max(a.y, b.y);
  const right = Math.min(a.x + a.w, b.x + b.w); const bottom = Math.min(a.y + a.h, b.y + b.h);
  const area = Math.max(0, right - left) * Math.max(0, bottom - top);
  return area / (a.w * a.h + b.w * b.h - area || 1);
}

function updateCandidates(now) {
  const withinRoi = (box) => !activeRoiVideo || (
    box.x + box.w / 2 >= activeRoiVideo.x && box.x + box.w / 2 <= activeRoiVideo.x + activeRoiVideo.w
    && box.y + box.h / 2 >= activeRoiVideo.y && box.y + box.h / 2 <= activeRoiVideo.y + activeRoiVideo.h
  );
  const local = detectionState.visible(now).map((item) => ({
    name: normalizedLabel(item.name), sourceName: normalizedLabel(item.name), detectorName: item.name, score: item.score,
    box: { x: item.x, y: item.y, w: item.w, h: item.h }, keep: true, source: 'device',
    trackId: item.trackId, trackConfidence: item.trackConfidence, trackAmbiguous: item.trackAmbiguous,
  })).filter((item) => withinRoi(item.box));
  candidates = local.slice(0, 30);
  updateLayoutButton();
  if (workflowStage === 'guiding') observeCurrentMove(now);
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
    const activeTrack = workflowStage === 'guiding' && arrangement[guideIndex]?.trackId === item.trackId;
    ctx.strokeStyle = activeTrack ? '#f4c66b' : item.source === 'server' ? '#d6a65a' : '#849579';
    ctx.lineWidth = activeTrack ? Math.max(3, 4 * scale) : Math.max(2, 3 * scale);
    ctx.strokeRect(bx, by, bw, bh);
    const label = normalizedLabel(item.name);
    const displayLabel = activeTrack
      ? item.trackAmbiguous ? `${label} · 확인 필요` : `${label} · 추적 중`
      : label;
    const textWidth = ctx.measureText(displayLabel).width;
    const labelY = Math.max(0, by - 28 * scale);
    ctx.fillStyle = activeTrack ? '#f4c66b' : item.source === 'server' ? '#f5e4bf' : '#f3efe3';
    ctx.fillRect(Math.max(0, bx), labelY, textWidth + 16 * scale, 25 * scale);
    ctx.fillStyle = '#303b31';
    ctx.fillText(displayLabel, Math.max(0, bx) + 8 * scale, labelY + 18 * scale);
  }
  if (workflowStage === 'planning' || workflowStage === 'guiding') {
    const visiblePlan = workflowStage === 'guiding' ? arrangement[guideIndex] ? [arrangement[guideIndex]] : [] : arrangement;
    visiblePlan.forEach((step, index) => {
      const { source, target } = step;
      const sx = source.x * canvas.width; const sy = source.y * canvas.height;
      const sw = source.w * canvas.width; const sh = source.h * canvas.height;
      const tx = target.x * canvas.width; const ty = target.y * canvas.height;
      const tw = target.w * canvas.width; const th = target.h * canvas.height;
      ctx.save();
      ctx.setLineDash([8 * scale, 5 * scale]);
      ctx.lineWidth = Math.max(2, 3 * scale);
      ctx.strokeStyle = workflowStage === 'guiding' ? '#f4c66b' : '#e6d1a8';
      ctx.fillStyle = '#f4c66b25';
      ctx.strokeRect(tx, ty, tw, th);
      ctx.fillRect(tx, ty, tw, th);
      ctx.setLineDash([5 * scale, 4 * scale]);
      ctx.strokeStyle = '#f4c66b';
      ctx.strokeRect(sx, sy, sw, sh);
      ctx.setLineDash([]);
      ctx.fillStyle = '#374235';
      ctx.fillRect(Math.max(0, sx), Math.max(0, sy - 24 * scale), 84 * scale, 21 * scale);
      ctx.fillStyle = '#fff8e8';
      ctx.font = `${Math.max(11, 13 * scale)}px -apple-system, sans-serif`;
      ctx.fillText(workflowStage === 'guiding' ? '옮길 물건' : '현재 위치', Math.max(4, sx + 4 * scale), Math.max(13, sy - 9 * scale));
      const startX = sx + sw / 2; const startY = sy + sh / 2;
      const endX = tx + tw / 2; const endY = ty + th / 2;
      const bend = Math.max(28 * scale, Math.min(75 * scale, Math.abs(endX - startX) * .18));
      const midX = (startX + endX) / 2;
      const midY = Math.min(startY, endY) - bend;
      ctx.beginPath(); ctx.moveTo(startX, startY); ctx.quadraticCurveTo(midX, midY, endX, endY);
      ctx.strokeStyle = workflowStage === 'guiding' ? '#f4c66b' : '#eee2c8';
      ctx.lineWidth = Math.max(3, 5 * scale); ctx.stroke();
      const angle = Math.atan2(endY - midY, endX - midX);
      const head = 12 * scale;
      ctx.beginPath(); ctx.moveTo(endX, endY);
      ctx.lineTo(endX - head * Math.cos(angle - Math.PI / 6), endY - head * Math.sin(angle - Math.PI / 6));
      ctx.lineTo(endX - head * Math.cos(angle + Math.PI / 6), endY - head * Math.sin(angle + Math.PI / 6));
      ctx.closePath(); ctx.fillStyle = workflowStage === 'guiding' ? '#f4c66b' : '#eee2c8'; ctx.fill();
      ctx.font = `${Math.max(12, 15 * scale)}px -apple-system, sans-serif`;
      ctx.fillStyle = '#f8f3e8';
      ctx.fillText(workflowStage === 'guiding' ? '여기에 놓기' : `${index + 1}. ${step.name}`, Math.max(4, tx), Math.max(18, ty - 7 * scale));
      ctx.restore();
    });
  }
}

function updateLayoutButton() {
  const count = candidates.filter((item) => item.keep && item.name.trim()).length;
  const continueButton = $('continueStyleButton');
  $('candidateCount').textContent = String(count);
  continueButton.disabled = count === 0 || workflowStage !== 'scanned' || scanAiStatus === 'pending';
  continueButton.textContent = scanAiStatus === 'pending'
    ? '물건을 다시 확인하고 있어요…'
    : scanAiStatus === 'failed'
      ? '목록을 직접 확인하고 스타일 고르기'
      : '물건 목록 확인 후 정리 스타일 고르기';
  const names = { candidates: '스캔한 물건', style: '정리 스타일', plan: '정리 배치안', guide: '정리 안내' };
  $('drawerLabel').textContent = `${$('zoneName').value.trim() || '공간'} · ${names[activeView] || '정리'}`;
}

function renderCandidates() {
  const list = $('candidates');
  list.replaceChildren();
  if (!candidates.length) {
    const empty = document.createElement('li');
    empty.className = 'empty-result';
    empty.textContent = workflowStage === 'scanning'
      ? '선택 영역을 분석 중이에요. 발견한 물건이 여기에 표시됩니다.'
      : '카메라에 물체를 비추면 윤곽을 표시해요.';
    list.append(empty);
  }
  for (const item of candidates) {
    const row = document.createElement('li');
    row.className = 'candidate-row';
    const label = document.createElement('label');
    label.className = 'check-label';
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox'; checkbox.checked = item.keep;
    checkbox.disabled = workflowStage === 'scanning';
    checkbox.setAttribute('aria-label', `${item.name} 배치도에 포함`);
    checkbox.addEventListener('change', () => { candidateReviewTouched = true; item.keep = checkbox.checked; updateLayoutButton(); draw(); });
    const name = document.createElement('input');
    name.className = 'candidate-name'; name.value = item.name; name.maxLength = 48;
    name.disabled = workflowStage === 'scanning';
    name.setAttribute('aria-label', '공간 요소 이름');
    name.addEventListener('input', () => { candidateReviewTouched = true; item.userEdited = true; item.name = name.value; draw(); });
    label.append(checkbox, name);
    row.append(label);
    list.append(row);
  }
  updateLayoutButton();
}

function tileCounts() {
  return {
    complete: scanTileStates.filter((state) => state === 'done').length,
    failed: scanTileStates.filter((state) => state === 'failed').length,
    active: scanTileStates.filter((state) => state === 'processing').length,
  };
}

function updateScanProgress() {
  const { complete, failed, active } = tileCounts();
  const percent = Math.round(complete / SCAN_TILE_COUNT * 100);
  $('scanProgressValue').textContent = `${complete} / ${SCAN_TILE_COUNT} 구역`;
  $('scanProgressBar').style.width = `${percent}%`;
  const count = collectScanCandidates().length;
  $('scanProgressHint').textContent = active
    ? `${complete}/${SCAN_TILE_COUNT} 구역 완료 · 후보 ${count}개${failed ? ` · 실패 ${failed}개` : ''}`
    : failed ? `${complete}/${SCAN_TILE_COUNT} 구역 완료 · 실패 ${failed}개`
      : `선택 영역 분석 중 · 후보 ${count}개`;
  renderTileSummary();
}

function renderTileSummary() {
  const summary = $('scanTileSummary');
  summary.replaceChildren();
  const labels = { done: '완료', failed: '실패', processing: '분석 중', pending: '대기' };
  scanTileStates.forEach((state, index) => {
    const chip = document.createElement('span');
    chip.className = `tile-chip ${state === 'done' ? 'done' : state === 'failed' ? 'failed' : ''}`;
    chip.textContent = `${index + 1} ${labels[state]}`;
    summary.append(chip);
  });
  summary.hidden = scanTileStates.every((state) => state === 'pending');
}

function collectScanCandidates() {
  const detections = scanResultsByTile.flatMap((results) => results || [])
    .sort((a, b) => b.score - a.score);
  const merged = [];
  for (const detection of detections) {
    const [x, y, w, h] = detection.bbox;
    const box = { x, y, w, h };
    if (merged.some((item) => item.sourceName === normalizedLabel(detection.class) && overlap(item.box, box) > .38)) continue;
    merged.push({
      name: normalizedLabel(detection.class), sourceName: normalizedLabel(detection.class),
      detectorName: detection.class, score: detection.score, box, keep: true, source: 'device', userEdited: false,
    });
  }
  return merged.slice(0, 30);
}

function finishScan(id) {
  if (workflowStage !== 'scanning' || id !== scanJobId) return;
  recognitionActive = false;
  detectionState.clear();
  const previous = candidates;
  candidates = collectScanCandidates().map((next) => {
    const prior = previous.find((item) => item.sourceName === next.sourceName && overlap(item.box, next.box) > .25);
    return prior ? { ...next, name: prior.name, keep: prior.keep, userEdited: prior.userEdited } : next;
  });
  workflowStage = 'scanned';
  scanAiStatus = modelReady && scanRoiBlobPromise && !scanRoiEnrichmentRequested
    ? 'pending'
    : scanRoiEnrichmentRequested ? (scanAiStatus === 'failed' ? 'failed' : 'complete') : 'unavailable';
  $('scanProgress').hidden = true;
  const { complete, failed } = tileCounts();
  $('scanSummary').textContent = failed
    ? `영역 ${complete}/${SCAN_TILE_COUNT}개 분석 완료 · ${failed}개 구역은 실패했어요. 실패 구역을 다시 분석할 수 있습니다.`
    : modelReady
      ? `선택 영역 분석 ${complete}/${SCAN_TILE_COUNT}개 완료 · Mac AI가 물건 종류와 빠진 물건을 다시 확인하고 있어요. 조금 걸릴 수 있습니다.`
      : `선택 영역 분석 ${complete}/${SCAN_TILE_COUNT}개 완료 · 물건 ${candidates.length}개 후보를 찾았어요. 목록을 확인해 주세요.`;
  $('retryTilesButton').hidden = failed === 0;
  $('editRegionButton').hidden = false;
  renderTileSummary();
  renderCandidates();
  setView('candidates');
  setDrawerOpen(true);
  updateActionButton();
  updateRoiOverlay();
  const waitingForAi = modelReady && !scanRoiEnrichmentRequested;
  if (!candidates.length && !waitingForAi) setToast('물체를 찾지 못했어요. 영역을 확인해 다시 스캔해 주세요.', true);
  else setToast(waitingForAi ? 'AI가 물체 이름을 확인 중이에요.' : '물체 후보를 확인해 주세요.');
  void enrichRoiWithServer(scanSessionId);
}

function runTileScan(tileIndices = null) {
  if (!stream || !detectorReady || !inferenceWorker) return;
  const bounds = videoRoiFromView();
  const { width, height } = captureDimensions(LOCAL_MAX_WIDTH);
  localCapture.width = width;
  localCapture.height = height;
  localCaptureCtx.drawImage(video, 0, 0, width, height);
  const pixels = localCaptureCtx.getImageData(0, 0, width, height);
  const roi = {
    x: Math.round(bounds.x * width), y: Math.round(bounds.y * height),
    w: Math.max(1, Math.round(bounds.w * width)), h: Math.max(1, Math.round(bounds.h * height)),
  };
  const id = ++scanJobId;
  workflowStage = 'scanning';
  recognitionActive = false;
  activeRoiVideo = bounds;
  detectionState.clear();
  $('scanProgress').hidden = false;
  $('scanProgressTitle').textContent = tileIndices ? '실패 구역 재분석' : '선택 영역 분석';
  $('scanSummary').textContent = tileIndices ? '실패한 구역을 다시 분석하고 있어요.' : '선택 영역 분석 중 · 물건 후보를 찾고 있어요.';
  setView('candidates');
  renderCandidates();
  setDrawerOpen(true);
  updateActionButton();
  updateRoiOverlay();
  const snapshotBlob = tileIndices ? scanRoiBlobPromise : captureRoiBlob(bounds);
  if (!tileIndices) {
    scanTileStates = Array(SCAN_TILE_COUNT).fill('pending');
    scanResultsByTile = Array(SCAN_TILE_COUNT).fill(null);
    candidateReviewTouched = false;
    scanRoiBlobPromise = snapshotBlob;
    scanSessionRoiVideo = bounds;
    scanRoiEnrichmentRequested = false;
    scanAiStatus = modelReady ? 'pending' : 'unavailable';
  } else {
    tileIndices.forEach((index) => { scanTileStates[index] = 'pending'; });
  }
  updateScanProgress();
  inferenceWorker.postMessage({
    type: 'scan', id, width, height, roi, tileIndices: tileIndices || undefined,
    pixels: pixels.data.buffer,
  }, [pixels.data.buffer]);
}

function startScan() {
  if (!stream || !detectorReady) return;
  candidates = [];
  arrangement = [];
  guideIndex = 0;
  activeRoiVideo = videoRoiFromView();
  scanSessionId++;
  scanTileStates = Array(SCAN_TILE_COUNT).fill('pending');
  scanResultsByTile = Array(SCAN_TILE_COUNT).fill(null);
  $('scanTileSummary').hidden = true;
  $('retryTilesButton').hidden = true;
  $('editRegionButton').hidden = true;
  setToast('');
  runTileScan();
}

async function captureRoiBlob(roi) {
  const sx = Math.max(0, Math.floor(roi.x * video.videoWidth));
  const sy = Math.max(0, Math.floor(roi.y * video.videoHeight));
  const sw = Math.max(1, Math.min(video.videoWidth - sx, Math.ceil(roi.w * video.videoWidth)));
  const sh = Math.max(1, Math.min(video.videoHeight - sy, Math.ceil(roi.h * video.videoHeight)));
  const ratio = Math.min(1, SERVER_MAX_WIDTH / sw, 720 / sh);
  capture.width = Math.max(1, Math.round(sw * ratio));
  capture.height = Math.max(1, Math.round(sh * ratio));
  captureCtx.drawImage(video, sx, sy, sw, sh, 0, 0, capture.width, capture.height);
  const width = capture.width; const height = capture.height;
  const blob = await new Promise((resolve) => capture.toBlob(resolve, 'image/jpeg', .82));
  return { blob, width, height };
}

function retryFailedTiles() {
  const failed = scanTileStates.flatMap((state, index) => state === 'failed' ? [index] : []);
  if (failed.length) runTileScan(failed);
}

function editScanRegion() {
  workflowStage = 'ready';
  sendPresence();
  candidates = [];
  arrangement = [];
  activeRoiVideo = null;
  $('scanTileSummary').hidden = true;
  $('retryTilesButton').hidden = true;
  $('editRegionButton').hidden = true;
  $('scanSummary').textContent = '사각형을 끌어 이동하고 모서리로 크기를 조절한 뒤 다시 스캔하세요.';
  renderCandidates();
  setDrawerOpen(false);
  updateRoiOverlay();
  updateActionButton();
  draw();
}

const STYLE_DETAILS = {
  minimal: { label: '미니멀', description: '물건을 가장자리로 모아 가운데 여백을 만드는 배치예요.' },
  focus: { label: '작업 효율', description: '작업 공간을 비우고 물건을 손 닿기 쉬운 쪽에 모아요.' },
  cozy: { label: '아늑하게', description: '물건을 작은 그룹으로 모아 편안한 느낌을 만들어요.' },
};

async function blobToBase64(blob) {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary);
}

async function makePlan() {
  const items = candidates.filter((item) => item.keep && item.name.trim());
  if (!items.length) return;
  workflowStage = 'planning';
  sendPresence();
  const region = activeRoiVideo || { x: 0, y: 0, w: 1, h: 1 };
  const button = $('makePlanButton');
  button.disabled = true;
  button.textContent = 'AI가 사진을 보고 배치 중…';
  setToast('사진의 빈 공간과 물건 위치를 살펴 배치안을 만들고 있어요.');
  try {
    const snapshot = await scanRoiBlobPromise;
    if (!snapshot?.blob) throw new Error('스캔 이미지를 찾지 못했어요. 공간을 다시 스캔해 주세요.');
    const image = await blobToBase64(snapshot.blob);
    const payloadItems = items.map((item, id) => {
      const left = Math.max(0, (item.box.x - region.x) / region.w);
      const top = Math.max(0, (item.box.y - region.y) / region.h);
      const right = Math.min(1, (item.box.x + item.box.w - region.x) / region.w);
      const bottom = Math.min(1, (item.box.y + item.box.h - region.y) / region.h);
      return { id, name: item.name.trim(), box: { x: left, y: top, w: Math.max(.001, right - left), h: Math.max(.001, bottom - top) } };
    });
    const response = await fetch('/api/plan', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ image, width: snapshot.width, height: snapshot.height, style: selectedStyle, items: payloadItems }),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.message || 'AI가 배치안을 만들지 못했어요. 서버와 모델 상태를 확인해 주세요.');
    const byId = new Map(items.map((item, id) => [id, item]));
    arrangement = result.placements.slice().sort((a, b) => a.order - b.order).map((placement, index) => {
      const item = byId.get(placement.id);
      if (!item) throw new Error('AI 배치안과 물건 목록이 일치하지 않아요. 다시 스캔해 주세요.');
      const w = Math.min(region.w * .22, Math.max(region.w * .075, item.box.w));
      const h = Math.min(region.h * .20, Math.max(region.h * .07, item.box.h));
      const cx = region.x + placement.center.x * region.w;
      const cy = region.y + placement.center.y * region.h;
      const x = Math.max(region.x, Math.min(region.x + region.w - w, cx - w / 2));
      const y = Math.max(region.y, Math.min(region.y + region.h - h, cy - h / 2));
      const trackId = item.trackId || `scan-${scanSessionId}-object-${placement.id + 1}`;
      item.trackId = trackId;
      return {
        name: item.name.trim(), sourceName: item.sourceName || item.name.trim(), detectorName: item.detectorName,
        trackId, source: { ...item.box }, target: { x, y, w, h }, index, reason: placement.reason,
      };
    });
    if (arrangement.length !== items.length) throw new Error('AI가 일부 물건의 위치를 정하지 못했어요. 다시 시도해 주세요.');
    workflowStage = 'planning';
    const detail = STYLE_DETAILS[selectedStyle];
    $('planTitle').textContent = `AI ${detail.label} 배치안 · ${arrangement.length}개 물건`;
    $('planCopy').textContent = `${result.summary || detail.description} 카메라와 책상을 고정한 상태에서 점선 위치로 옮겨보세요.`;
    const list = $('planSteps');
    list.replaceChildren();
    arrangement.forEach((step, index) => {
      const row = document.createElement('li');
      row.innerHTML = `<span class="step-number">${index + 1}</span><span><strong></strong><small></small></span>`;
      row.querySelector('strong').textContent = step.name;
      row.querySelector('small').textContent = step.reason;
      list.append(row);
    });
    setView('plan');
    setDrawerOpen(true);
    updateActionButton();
    draw();
  } catch (error) {
    workflowStage = 'scanned';
    sendPresence();
    setToast(error.message || 'AI 배치 계산에 실패했어요. 서버 상태를 확인해 주세요.', true);
  } finally {
    button.disabled = false;
    button.textContent = '이 스타일로 AI 배치안 만들기';
  }
}

function startGuide() {
  if (!arrangement.length) return;
  workflowStage = 'guiding';
  recognitionActive = true;
  detectionState.clear();
  detectionState.seed(arrangement.map((step) => ({
    name: step.sourceName, sourceName: step.sourceName, detectorName: step.detectorName,
    trackId: step.trackId, box: step.source, score: 1,
  })));
  guideIndex = 0;
  skippedGuideSteps = 0;
  resetMovementEvidence();
  setView('guide');
  setDrawerOpen(false);
  showGuideStep();
  updateActionButton();
  draw();
}

function showGuideStep() {
  const step = arrangement[guideIndex];
  const complete = !step;
  const progressed = Math.min(guideIndex, arrangement.length);
  const progress = arrangement.length ? Math.round(progressed / arrangement.length * 100) : 0;
  $('guideProgressTrack').setAttribute('aria-valuenow', String(progress));
  $('guideProgressBar').style.width = `${progress}%`;
  $('guideProgressText').textContent = `진행 ${progressed} / ${arrangement.length}`;
  $('guideStepCount').textContent = complete
    ? skippedGuideSteps ? `안내 완료 · ${skippedGuideSteps}개 건너뜀` : '모든 물건을 옮겼어요'
    : `${guideIndex + 1} / ${arrangement.length}번째 물건`;
  $('guideObjectName').textContent = complete ? skippedGuideSteps ? '안내가 끝났어요' : '정리 완료!' : step.name;
  $('guideInstruction').textContent = complete
    ? skippedGuideSteps
      ? '건너뛴 물건은 스캔 목록에서 다시 확인하고 배치안을 만들 수 있어요.'
      : '선택한 스타일에 맞춰 정리했어요. 화면에서 결과를 확인해 주세요.'
    : '카메라의 노란 테두리 물건을 점선 위치까지 옮겨주세요. 카메라와 책상은 고정해 둡니다.';
  $('moveStatus').textContent = complete ? '정리 과정을 마쳤습니다.' : moveStatusText();
  $('confirmMoveButton').hidden = complete;
  $('skipMoveButton').hidden = complete;
  $('finishGuideButton').hidden = !complete;
  $('finishGuideButton').textContent = skippedGuideSteps ? '안내 종료' : '정리 완료';
  $('startArAnchorButton').hidden = !webxrArSupported || complete || !stream;
  $('confirmMoveButton').textContent = targetDetected ? '감지된 위치 확인' : '이동 완료 확인';
  $('drawerLabel').textContent = complete
    ? skippedGuideSteps ? `안내 완료 · ${skippedGuideSteps}개 건너뜀 · 결과 보기` : '정리 완료 · 결과 보기'
    : `${guideIndex + 1}/${arrangement.length} · ${step.name} 옮기는 중 · 안내 열기`;
}

function resetMovementEvidence() {
  targetDetected = false;
  movementEvidence = {
    targetFirstSeenAt: 0, targetLastSeenAt: 0, targetFrames: 0, targetBox: null,
    sourceMissingSince: 0, sourceMissingFrames: 0,
  };
}

function moveStatusText() {
  if (movementEvidence?.trackAmbiguous) return '비슷한 물건이 있어 추적 대상을 확정하지 못했어요. 이동 완료를 직접 확인해 주세요.';
  if (targetDetected) return '목표 위치에서 안정적으로 감지했어요. 확인을 누르면 다음 물건으로 넘어갑니다.';
  if (movementEvidence?.targetFrames >= 2 && movementEvidence.sourceMissingFrames < 2) {
    return '목표 위치에 물체가 보여요. 원래 위치의 물체가 사라졌는지 확인하는 중입니다.';
  }
  if (movementEvidence?.sourceMissingFrames > 0 && movementEvidence.targetFrames === 0) {
    return '원래 위치에서 물체가 보이지 않아요. 목표 위치로 옮긴 뒤 카메라를 잠시 고정해 주세요.';
  }
  return '노란 테두리 물건을 점선 위치로 옮겨주세요. 같은 종류의 물건이 있으면 직접 확인을 사용하세요.';
}

function observeCurrentMove(now) {
  const step = arrangement[guideIndex];
  if (!step || workflowStage !== 'guiding' || !movementEvidence) return;
  const matches = candidates.filter((item) => item.keep && (step.trackId
    ? item.trackId === step.trackId
    : String(item.sourceName || item.name).trim().toLowerCase() === step.sourceName.toLowerCase()));
  const target = step.target;
  const sourceX = step.source.x + step.source.w / 2;
  const sourceY = step.source.y + step.source.h / 2;
  const sourcePresent = matches.some((item) => {
    const cx = item.box.x + item.box.w / 2; const cy = item.box.y + item.box.h / 2;
    const radiusX = Math.max(.045, step.source.w * .65);
    const radiusY = Math.max(.045, step.source.h * .65);
    return Math.abs(cx - sourceX) <= radiusX && Math.abs(cy - sourceY) <= radiusY;
  });
  if (sourcePresent) {
    movementEvidence.sourceMissingSince = 0;
    movementEvidence.sourceMissingFrames = 0;
  } else {
    if (!movementEvidence.sourceMissingSince) movementEvidence.sourceMissingSince = now;
    movementEvidence.sourceMissingFrames++;
  }
  const targetMatches = matches.filter((item) => {
    const cx = item.box.x + item.box.w / 2; const cy = item.box.y + item.box.h / 2;
    return Math.hypot(cx - sourceX, cy - sourceY) > .10
      && cx >= target.x - .025 && cx <= target.x + target.w + .025
      && cy >= target.y - .04 && cy <= target.y + target.h + .04;
  });
  const targetCandidate = targetMatches.sort((a, b) => b.score - a.score)[0];
  movementEvidence.trackAmbiguous = Boolean(targetCandidate?.trackAmbiguous);
  if (targetCandidate) {
    const previousBox = movementEvidence.targetBox;
    const stable = previousBox && (overlap(previousBox, targetCandidate.box) >= .15
      || Math.hypot(previousBox.x + previousBox.w / 2 - targetCandidate.box.x - targetCandidate.box.w / 2,
        previousBox.y + previousBox.h / 2 - targetCandidate.box.y - targetCandidate.box.h / 2) <= .07);
    if (!stable || now - movementEvidence.targetLastSeenAt > 700) {
      movementEvidence.targetFirstSeenAt = now;
      movementEvidence.targetFrames = 1;
    } else {
      movementEvidence.targetFrames++;
    }
    movementEvidence.targetLastSeenAt = now;
    movementEvidence.targetBox = { ...targetCandidate.box };
  } else {
    if (now - movementEvidence.targetLastSeenAt > 700) {
      movementEvidence.targetFirstSeenAt = 0;
      movementEvidence.targetFrames = 0;
      movementEvidence.targetBox = null;
    }
  }
  const targetStable = movementEvidence.targetFrames >= 3 && now - movementEvidence.targetFirstSeenAt >= 1_000;
  const sourceGone = movementEvidence.sourceMissingFrames >= 2 && now - movementEvidence.sourceMissingSince >= 500;
  const wasTargetDetected = targetDetected;
  targetDetected = Boolean(targetStable && sourceGone && targetCandidate?.trackId === step.trackId
    && !targetCandidate.trackAmbiguous && targetCandidate.trackConfidence >= .35);
  if (targetDetected && !wasTargetDetected) setDrawerOpen(true);
  showGuideStep();
}

function captureDimensions(maxWidth) {
  const ratio = Math.min(1, maxWidth / video.videoWidth, 720 / video.videoHeight);
  return { width: Math.max(1, Math.round(video.videoWidth * ratio)), height: Math.max(1, Math.round(video.videoHeight * ratio)) };
}

function runLocalDetectorFrame(now) {
  if (workflowStage !== 'guiding' || !recognitionActive || !stream || !detectorReady || !video.videoWidth || !video.videoHeight) return;
  if (detectionState.pending || now - (detectionState.capturedAt || 0) < 130) return;
  const { width, height } = captureDimensions(LOCAL_MAX_WIDTH);
  localCapture.width = width; localCapture.height = height;
  localCaptureCtx.drawImage(video, 0, 0, width, height);
  const pixels = localCaptureCtx.getImageData(0, 0, width, height);
  const job = detectionState.begin(now, width, height);
  if (job) inferenceWorker.postMessage({ type: 'detect', id: job.id, width, height, pixels: pixels.data.buffer }, [pixels.data.buffer]);
}

async function enrichRoiWithServer(sessionId) {
  if (scanRoiEnrichmentRequested || !modelReady || !scanRoiBlobPromise) return;
  scanRoiEnrichmentRequested = true;
  scanAiStatus = 'pending';
  updateLayoutButton();
  try {
    const { blob, width, height } = await scanRoiBlobPromise;
    if (!blob || sessionId !== scanSessionId) return;
    const response = await fetch('/api/scan', {
      method: 'POST',
      headers: { 'content-type': 'image/jpeg', 'x-image-width': String(width), 'x-image-height': String(height) },
      body: blob,
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.message || 'Mac AI가 선택 영역을 분석하지 못했어요.');
    if (sessionId !== scanSessionId) return;
    if (candidateReviewTouched) {
      $('scanSummary').textContent = `분석 완료 · 직접 확인한 물건 ${candidates.length}개를 유지하고 있어요.`;
      scanAiStatus = 'reviewed';
      setView('candidates');
      setDrawerOpen(true);
      $('drawerBody').scrollTop = 0;
      renderCandidates();
      updateLayoutButton();
      return;
    }
    const roi = scanSessionRoiVideo;
    const aiDetections = (result.detections || []).map((item) => ({
      name: normalizedLabel(item.label), sourceName: normalizedLabel(item.label), score: item.score,
      box: { x: roi.x + item.box.x * roi.w, y: roi.y + item.box.y * roi.h, w: item.box.w * roi.w, h: item.box.h * roi.h },
      keep: true, source: 'server', userEdited: false,
    }));
    const merged = [...candidates];
    for (const ai of aiDetections) {
      const match = merged.find((item) => overlap(item.box, ai.box) > .12);
      if (match) {
        if (!match.userEdited && ai.score > match.score) {
          match.name = ai.name;
          match.score = ai.score;
          match.source = 'server';
        }
      } else if (ai.score >= .45) merged.push(ai);
    }
    candidates = merged.slice(0, 30);
    scanAiStatus = 'complete';
    const { complete, failed } = tileCounts();
    $('scanSummary').textContent = failed
      ? `영역 ${complete}/${SCAN_TILE_COUNT}개 분석 완료 · 실패 ${failed}개 · 물건 ${candidates.length}개 후보`
      : `선택 영역 분석 완료 · 물건 ${candidates.length}개 후보를 확인해 주세요.`;
    setView('candidates');
    setDrawerOpen(true);
    $('drawerBody').scrollTop = 0;
    renderCandidates();
    draw();
    if (!candidates.length) setToast('선택 영역에서 물체를 찾지 못했어요. 스캔 범위와 조명을 확인해 주세요.', true);
    else setToast(`물건 ${candidates.length}개를 찾았어요.`);
  } catch (error) {
    if (sessionId === scanSessionId) {
      scanAiStatus = 'failed';
      $('scanSummary').textContent = `브라우저 분석 완료 · 물건 ${candidates.length}개 후보 · Mac AI 이름 보완에 실패했어요.`;
      updateLayoutButton();
      setToast(error.message || 'Mac AI 서버 연결을 확인해 주세요.', true);
    }
  }
}

function toggleRecognition() {
  if (workflowStage !== 'scanning') startScan();
}

function animate(now) {
  if (workflowStage === 'guiding' && recognitionActive) runLocalDetectorFrame(now);
  requestAnimationFrame(animate);
}

function initializeDetector() {
  try {
    inferenceWorker = new Worker(new URL('./inference-worker.js?v=20260927-csp-fix', import.meta.url));
    inferenceWorker.onmessage = ({ data }) => {
      if (data.type === 'ready') {
        detectorReady = true;
        updateActionButton();
        $('cameraMessage').textContent = '감지 모델 준비 완료 · 카메라를 고정하고 공간 스캔을 시작하세요.';
        return;
      }
      if (data.type === 'load-error') {
        detectorReady = false;
        updateActionButton();
        $('cameraMessage').textContent = '기기 물체 감지 모델을 불러오지 못했어요.';
        setToast(`실시간 감지 모델 오류: ${data.message}`, true);
        return;
      }
      if (data.type.startsWith('scan-')) {
        if (data.id !== scanJobId) return;
        if (data.type === 'scan-tile-start') scanTileStates[data.index] = 'processing';
        if (data.type === 'scan-tile-result') {
          scanTileStates[data.index] = 'done';
          scanResultsByTile[data.index] = data.results || [];
          candidates = collectScanCandidates();
          if (candidates.length) {
            $('scanSummary').textContent = `분석 중 · ${tileCounts().complete}/${SCAN_TILE_COUNT}구역 완료 · 물건 ${candidates.length}개 후보`;
            setView('candidates');
            renderCandidates();
            setDrawerOpen(true);
            draw();
          }
        }
        if (data.type === 'scan-tile-error') scanTileStates[data.index] = 'failed';
        if (data.type === 'scan-error') {
          scanTileStates = scanTileStates.map((state) => state === 'pending' || state === 'processing' ? 'failed' : state);
          updateScanProgress();
          finishScan(data.id);
          setToast(`선택 영역 분석 중 오류가 발생했어요: ${data.message}`, true);
          return;
        }
        if (data.type === 'scan-done') {
          updateScanProgress();
          finishScan(data.id);
          return;
        }
        updateScanProgress();
        return;
      }
      if (data.type === 'result') {
        const now = performance.now();
        if (detectionState.accept(data, now) && recognitionActive) updateCandidates(now);
      }
      if (data.type === 'inference-error' && detectionState.pending?.id === data.id) {
        const now = performance.now();
        if (detectionState.accept({ id: data.id, results: [] }, now) && recognitionActive) updateCandidates(now);
      }
    };
    inferenceWorker.onerror = () => {
      detectorReady = false;
      if (workflowStage === 'scanning') {
        scanTileStates = scanTileStates.map((state) => state === 'pending' || state === 'processing' ? 'failed' : state);
        finishScan(scanJobId);
      }
      stopRecognition(false);
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
$('retryTilesButton').addEventListener('click', retryFailedTiles);
$('editRegionButton').addEventListener('click', editScanRegion);
$('roiSelection').addEventListener('pointerdown', beginRoiDrag);
window.addEventListener('pointermove', moveRoiDrag);
window.addEventListener('pointerup', endRoiDrag);
window.addEventListener('pointercancel', endRoiDrag);
$('continueStyleButton').addEventListener('click', () => { setView('style'); setDrawerOpen(true); });
$('makePlanButton').addEventListener('click', makePlan);
$('startGuideButton').addEventListener('click', startGuide);
$('startArAnchorButton').addEventListener('click', startArAnchorGuide);
$('editStyleButton').addEventListener('click', () => { workflowStage = 'scanned'; setView('style'); draw(); });
$('confirmMoveButton').addEventListener('click', () => {
  guideIndex++;
  resetMovementEvidence();
  showGuideStep();
  draw();
  if (arrangement[guideIndex]) setDrawerOpen(false);
});
$('skipMoveButton').addEventListener('click', () => {
  skippedGuideSteps++;
  guideIndex++;
  resetMovementEvidence();
  showGuideStep();
  draw();
  if (arrangement[guideIndex]) setDrawerOpen(false);
});
$('finishGuideButton').addEventListener('click', () => {
  workflowStage = 'completed'; recognitionActive = false; detectionState.clear(); setView('candidates'); setDrawerOpen(false); updateActionButton();
  setToast(skippedGuideSteps
    ? `안내를 종료했어요. ${skippedGuideSteps}개 물건을 건너뛰었습니다.`
    : '정리가 끝났어요. 다시 스캔해 다른 배치도 만들어볼 수 있습니다.');
});
$('styleSection').querySelectorAll('[data-style]').forEach((button) => button.addEventListener('click', () => {
  selectedStyle = button.dataset.style;
  $('styleSection').querySelectorAll('[data-style]').forEach((option) => {
    const selected = option === button;
    option.classList.toggle('selected', selected);
    option.setAttribute('aria-pressed', String(selected));
  });
}));
$('drawerHandle').addEventListener('click', () => {
  if ($('drawer').classList.contains('open')) setDrawerOpen(false);
  else { setView(activeView); renderCandidates(); setDrawerOpen(true); }
});
$('facing').addEventListener('change', () => { if (stream) { stopCamera(); startCamera(); } });
video.addEventListener('loadedmetadata', () => { resizeCanvas(); updateRoiOverlay(); draw(); });
document.addEventListener('visibilitychange', () => sendPresence());
window.setInterval(() => sendPresence(), 15_000);
window.addEventListener('pagehide', () => {
  sendPresence(false);
  if (stream) stream.getTracks().forEach((track) => track.stop());
  if (inferenceWorker) inferenceWorker.terminate();
});

sendPresence();
initializeDetector();
checkHealth();
requestAnimationFrame(animate);
