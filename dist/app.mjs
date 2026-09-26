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
const SCAN_DURATION_MS = 12_000;
const LOCAL_MAX_WIDTH = 480;
const SERVER_MAX_WIDTH = 960;

let stream = null;
let modelReady = false;
let detectorReady = false;
let recognitionActive = false;
let candidates = [];
let semanticCandidates = [];
let activeView = 'candidates';
let toastTimer = null;
let serverScanActive = false;
let serverLoopGeneration = 0;
let inferenceWorker = null;
let workflowStage = 'idle';
let scanStartedAt = 0;
let selectedStyle = 'minimal';
let arrangement = [];
let guideIndex = 0;
let targetObservedSince = 0;
let targetDetected = false;

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
  for (const section of ['candidateSection', 'styleSection', 'planSection', 'guideSection']) {
    $(section).hidden = section !== `${view}Section`;
  }
  const names = { candidates: '스캔한 물건', style: '정리 스타일', plan: '정리 배치안', guide: '정리 안내' };
  $('drawerLabel').textContent = `${$('zoneName').value.trim() || '공간'} · ${names[view] || '정리'}`;
}

function normalizedLabel(label) {
  const trimmed = String(label || '').trim().slice(0, 48);
  return LABELS[trimmed.toLowerCase()] || trimmed;
}

function updateActionButton() {
  const button = $('scanButton');
  button.disabled = !stream || !detectorReady;
  const liveStage = workflowStage === 'scanning' || workflowStage === 'guiding';
  button.setAttribute('aria-pressed', String(liveStage));
  button.classList.toggle('is-live', liveStage);
  const label = workflowStage === 'scanning' ? '스캔 완료' : workflowStage === 'idle' ? '공간 스캔 시작' : '다시 스캔';
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
  serverLoopGeneration++;
  semanticCandidates = [];
  detectionState.clear();
  if (clearResults) updateCandidates(performance.now());
  updateActionButton();
}

function stopCamera(message = '카메라가 꺼져 있어요.') {
  stopRecognition();
  workflowStage = 'idle';
  $('scanProgress').hidden = true;
  setView('candidates');
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
    name: normalizedLabel(item.name), sourceName: normalizedLabel(item.name), score: item.score,
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
      candidates.push({ name: normalizedLabel(item.name), sourceName: normalizedLabel(item.name), score: item.score, box: item.box, keep: true, source: 'server' });
    }
  });
  candidates = candidates.slice(0, 30);
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
  $('candidateCount').textContent = String(count);
  $('continueStyleButton').disabled = count === 0 || workflowStage !== 'scanned';
  const names = { candidates: '스캔한 물건', style: '정리 스타일', plan: '정리 배치안', guide: '정리 안내' };
  $('drawerLabel').textContent = `${$('zoneName').value.trim() || '공간'} · ${names[activeView] || '정리'}`;
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

function updateScanProgress(now) {
  if (workflowStage !== 'scanning') return;
  const elapsed = Math.max(0, now - scanStartedAt);
  const progress = Math.min(100, Math.round(elapsed / SCAN_DURATION_MS * 100));
  $('scanProgressValue').textContent = `${progress}%`;
  $('scanProgressBar').style.width = `${progress}%`;
  const count = candidates.filter((item) => item.keep).length;
  $('scanProgressHint').textContent = count
    ? `물건 ${count}개를 찾았어요 · 카메라를 움직이지 말고 잠시 기다려주세요.`
    : '책상 전체가 보이도록 두고 물체를 가리지 말아주세요.';
  if (progress >= 100) finishScan();
}

function finishScan() {
  if (workflowStage !== 'scanning') return;
  recognitionActive = false;
  serverLoopGeneration++;
  semanticCandidates = [];
  detectionState.clear();
  workflowStage = 'scanned';
  $('scanProgress').hidden = true;
  const count = candidates.filter((item) => item.keep).length;
  $('scanSummary').textContent = count
    ? `화면에서 물건 ${count}개를 찾았어요. 이름과 포함할 물건을 확인해 주세요.`
    : '물건을 찾지 못했어요. 책상과 조명이 화면에 잘 보이는지 확인한 뒤 다시 스캔해 주세요.';
  renderCandidates();
  setView('candidates');
  setDrawerOpen(true);
  updateActionButton();
  setToast('스캔이 끝났어요. 물건 목록을 확인한 다음 정리 스타일을 골라주세요.', true);
}

function startScan() {
  if (!stream || !detectorReady) return;
  candidates = [];
  semanticCandidates = [];
  arrangement = [];
  guideIndex = 0;
  detectionState.clear();
  workflowStage = 'scanning';
  recognitionActive = true;
  scanStartedAt = performance.now();
  $('scanProgress').hidden = false;
  $('scanProgressValue').textContent = '0%';
  $('scanProgressBar').style.width = '0%';
  setDrawerOpen(false);
  setToast('');
  updateActionButton();
  serverEnrichmentLoop(++serverLoopGeneration);
}

const STYLE_DETAILS = {
  minimal: { label: '미니멀', description: '물건을 가장자리로 모아 가운데 여백을 만드는 배치예요.' },
  focus: { label: '작업 효율', description: '작업 공간을 비우고 물건을 손 닿기 쉬운 쪽에 모아요.' },
  cozy: { label: '아늑하게', description: '물건을 작은 그룹으로 모아 편안한 느낌을 만들어요.' },
};

function targetCenter(index, count) {
  if (selectedStyle === 'minimal') {
    const slots = [[.18,.18],[.5,.16],[.82,.18],[.12,.5],[.88,.5],[.18,.82],[.5,.84],[.82,.82]];
    return slots[index % slots.length];
  }
  if (selectedStyle === 'focus') {
    const slots = [[.5,.68],[.32,.34],[.68,.34],[.22,.68],[.78,.68],[.4,.18],[.6,.18],[.5,.43]];
    return slots[index % slots.length];
  }
  const slots = [[.25,.28],[.42,.28],[.25,.48],[.42,.48],[.67,.28],[.84,.28],[.67,.48],[.84,.48],[.5,.75]];
  return slots[index % slots.length];
}

function makePlan() {
  const items = candidates.filter((item) => item.keep && item.name.trim());
  if (!items.length) return;
  arrangement = items.map((item, index) => {
    let [cx, cy] = targetCenter(index, items.length);
    const sourceX = item.box.x + item.box.w / 2;
    const sourceY = item.box.y + item.box.h / 2;
    for (let offset = 0; offset < 8; offset++) {
      const candidate = targetCenter(index + offset, items.length);
      if (Math.hypot(candidate[0] - sourceX, candidate[1] - sourceY) > .22) { [cx, cy] = candidate; break; }
    }
    const w = Math.min(.22, Math.max(.075, item.box.w));
    const h = Math.min(.20, Math.max(.07, item.box.h));
    const x = Math.max(.02, Math.min(.98 - w, cx - w / 2));
    const y = Math.max(.04, Math.min(.96 - h, cy - h / 2));
    return { name: item.name.trim(), sourceName: item.sourceName || item.name.trim(), source: { ...item.box }, target: { x, y, w, h }, index };
  });
  workflowStage = 'planning';
  const detail = STYLE_DETAILS[selectedStyle];
  $('planTitle').textContent = `${detail.label} 배치안 · ${arrangement.length}개 물건`;
  $('planCopy').textContent = `${detail.description} 카메라 화면의 점선 위치로 한 개씩 옮겨보세요.`;
  const list = $('planSteps');
  list.replaceChildren();
  arrangement.forEach((step, index) => {
    const row = document.createElement('li');
    row.innerHTML = `<span class="step-number">${index + 1}</span><span><strong></strong><small>화면의 점선 위치로 옮기기</small></span>`;
    row.querySelector('strong').textContent = step.name;
    list.append(row);
  });
  setView('plan');
  setDrawerOpen(true);
  updateActionButton();
  draw();
}

function startGuide() {
  if (!arrangement.length) return;
  workflowStage = 'guiding';
  recognitionActive = true;
  detectionState.clear();
  guideIndex = 0;
  targetObservedSince = 0;
  targetDetected = false;
  setView('guide');
  setDrawerOpen(true);
  showGuideStep();
  updateActionButton();
  draw();
}

function showGuideStep() {
  const step = arrangement[guideIndex];
  const complete = !step;
  $('guideStepCount').textContent = complete ? '모든 물건을 옮겼어요' : `${guideIndex + 1} / ${arrangement.length}번째 물건`;
  $('guideObjectName').textContent = complete ? '정리 완료!' : step.name;
  $('guideInstruction').textContent = complete
    ? '선택한 스타일에 맞춰 정리했어요. 화면에서 결과를 확인해 주세요.'
    : '카메라의 노란 테두리 물건을 점선 위치까지 옮겨주세요. 카메라와 책상은 고정해 둡니다.';
  $('moveStatus').textContent = complete ? '정리 과정을 마쳤습니다.' : targetDetected ? '새 위치에서 물건을 감지했어요. 이동을 확인해 주세요.' : '이동을 감지하는 중이에요. 옮긴 뒤 잠시 기다려주세요.';
  $('confirmMoveButton').hidden = complete;
  $('skipMoveButton').hidden = complete;
  $('finishGuideButton').hidden = !complete;
  $('confirmMoveButton').textContent = targetDetected ? '감지된 위치 확인' : '이동 완료 확인';
}

function observeCurrentMove(now) {
  const step = arrangement[guideIndex];
  if (!step || workflowStage !== 'guiding') return;
  const matches = candidates.filter((item) => item.keep && String(item.sourceName || item.name).trim().toLowerCase() === step.sourceName.toLowerCase());
  const target = step.target;
  const inTarget = matches.some((item) => {
    const cx = item.box.x + item.box.w / 2; const cy = item.box.y + item.box.h / 2;
    const sx = step.source.x + step.source.w / 2; const sy = step.source.y + step.source.h / 2;
    return Math.hypot(cx - sx, cy - sy) > .10
      && cx >= target.x - .04 && cx <= target.x + target.w + .04
      && cy >= target.y - .04 && cy <= target.y + target.h + .04;
  });
  if (inTarget) {
    if (!targetObservedSince) targetObservedSince = now;
    if (now - targetObservedSince >= 800) targetDetected = true;
  } else {
    targetObservedSince = 0;
    targetDetected = false;
  }
  showGuideStep();
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

function toggleRecognition() {
  if (workflowStage === 'scanning') finishScan();
  else startScan();
}

function animate(now) {
  if (recognitionActive) runLocalDetectorFrame(now);
  updateScanProgress(now);
  requestAnimationFrame(animate);
}

function initializeDetector() {
  try {
    inferenceWorker = new Worker(new URL('./inference-worker.js', import.meta.url));
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
$('continueStyleButton').addEventListener('click', () => { setView('style'); setDrawerOpen(true); });
$('makePlanButton').addEventListener('click', makePlan);
$('startGuideButton').addEventListener('click', startGuide);
$('editStyleButton').addEventListener('click', () => { workflowStage = 'scanned'; setView('style'); draw(); });
$('confirmMoveButton').addEventListener('click', () => { guideIndex++; targetObservedSince = 0; targetDetected = false; showGuideStep(); draw(); });
$('skipMoveButton').addEventListener('click', () => { guideIndex++; targetObservedSince = 0; targetDetected = false; showGuideStep(); draw(); });
$('finishGuideButton').addEventListener('click', () => { workflowStage = 'completed'; setView('candidates'); setDrawerOpen(false); updateActionButton(); setToast('정리가 끝났어요. 다시 스캔해 다른 배치도 만들어볼 수 있습니다.'); });
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
video.addEventListener('loadedmetadata', () => { resizeCanvas(); draw(); });
window.addEventListener('pagehide', () => {
  if (stream) stream.getTracks().forEach((track) => track.stop());
  if (inferenceWorker) inferenceWorker.terminate();
});

initializeDetector();
checkHealth();
requestAnimationFrame(animate);
