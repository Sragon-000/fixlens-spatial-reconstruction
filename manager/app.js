const $ = (id) => document.getElementById(id);
const state = { tunnelUrl: '', busy: false };

function setBadge(id, label, tone) {
  const element = $(id);
  element.textContent = label;
  element.className = `status-badge ${tone}`;
}

function announce(message, error = false) {
  const notice = $('notice');
  notice.textContent = message;
  notice.classList.toggle('error', error);
  notice.hidden = !message;
  if (message) window.setTimeout(() => { if (notice.textContent === message) notice.hidden = true; }, 8000);
}

function describeTask(client) {
  const count = Number(client.count) || 0;
  const progress = client.progress;
  switch (client.stage) {
    case 'ready': return '공간 스캔 준비';
    case 'scanning': return `공간 스캔 ${progress ? `${progress.done}/${progress.total} 구역` : '진행 중'}`;
    case 'scanned': return `스캔 완료 · 물건 ${count}개`;
    case 'planning': return `AI 배치안 계산 · 물건 ${count}개`;
    case 'guiding': return `정리 안내 ${progress ? `${Math.min(progress.done + 1, progress.total)}/${progress.total}단계` : '진행 중'}`;
    case 'completed': return `정리 완료 · 물건 ${count}개`;
    default: return client.camera ? '카메라 사용 중 · 대기' : '페이지 접속 · 대기';
  }
}

function renderClients(clients) {
  const list = $('clientsList');
  list.replaceChildren();
  const entries = Array.isArray(clients) ? clients : [];
  $('clientCount').textContent = `${entries.length}대 접속`;
  if (!entries.length) {
    const empty = document.createElement('p');
    empty.className = 'clients-empty';
    empty.textContent = '현재 접속 중인 기기가 없습니다. 휴대폰에서 QR을 열고 FixLens 페이지를 띄워 두면 여기에 표시됩니다.';
    list.append(empty);
    return;
  }
  entries.sort((a, b) => Number(b.phone) - Number(a.phone) || Number(a.lastSeenSeconds) - Number(b.lastSeenSeconds));
  for (const client of entries) {
    const card = document.createElement('article');
    card.className = 'client-card';
    const icon = document.createElement('span');
    icon.className = 'client-icon';
    icon.setAttribute('aria-hidden', 'true');
    icon.textContent = client.phone ? '▯' : '▣';
    const info = document.createElement('div');
    info.className = 'client-info';
    const heading = document.createElement('div');
    heading.className = 'client-device';
    const name = document.createElement('strong');
    name.textContent = `${client.device || '웹 브라우저'} · ${client.browser || '브라우저'}`;
    const active = document.createElement('span');
    active.className = 'client-live';
    active.textContent = '접속 중';
    heading.append(name, active);
    const task = document.createElement('p');
    task.className = 'client-task';
    task.textContent = describeTask(client);
    info.append(heading, task);
    const meta = document.createElement('div');
    meta.className = 'client-meta';
    const camera = document.createElement('span');
    camera.className = client.camera ? 'camera-state on' : 'camera-state';
    camera.textContent = client.camera ? '카메라 켜짐' : '카메라 꺼짐';
    const seen = document.createElement('span');
    const seconds = Number(client.lastSeenSeconds) || 0;
    seen.textContent = seconds < 5 ? '방금 응답' : `${seconds}초 전 응답`;
    meta.append(camera, seen);
    card.append(icon, info, meta);
    list.append(card);
  }
}

function setButtonsDisabled(disabled) {
  state.busy = disabled;
  document.querySelectorAll('button').forEach((button) => {
    button.disabled = disabled || button.dataset.locked === 'true';
  });
}

function serviceBadge(service, badgeId, descriptionId) {
  if (service.running) {
    setBadge(badgeId, service.managed ? '실행 중' : '외부 실행', 'good');
    return;
  }
  setBadge(badgeId, '꺼짐', 'off');
  if (descriptionId === 'webDescription') $('webDescription').textContent = '카메라 화면과 분석 API를 제공합니다.';
}

async function refreshStatus() {
  try {
    const response = await fetch('/api/status', { cache: 'no-store' });
    if (!response.ok) throw new Error('관리 서버와 연결되지 않습니다. FixLens Server.command를 다시 실행해 주세요.');
    const data = await response.json();
    renderClients(data.clients);
    serviceBadge(data.web, 'webBadge', 'webDescription');
    $('webDescription').textContent = data.web.running
      ? data.web.managed ? '카메라 화면과 분석 API를 제공하고 있습니다.' : '다른 방식으로 실행 중입니다. 시작을 눌러 관리자에 연결할 수 있어요.'
      : '꺼져 있어요. 시작하면 Mac에서 카메라 페이지를 열 수 있습니다.';
    serviceBadge(data.ollama, 'ollamaBadge', 'ollamaDescription');
    $('ollamaDescription').textContent = data.ollama.running
      ? data.ollama.modelAvailable ? `${data.ollama.model} 모델을 사용할 수 있습니다.` : `${data.ollama.model} 모델이 설치되어 있지 않습니다.`
      : 'AI 물체 분석과 배치안 생성을 위한 로컬 모델 서버입니다.';
    if (data.tunnel.running) {
      setBadge('tunnelBadge', '실행 중', 'good');
      $('tunnelDescription').textContent = data.tunnel.url ? '휴대폰용 HTTPS 주소가 준비되었습니다.' : '주소를 확인하고 있습니다.';
    } else {
      setBadge('tunnelBadge', '꺼짐', 'off');
      $('tunnelDescription').textContent = '휴대폰에서 접속할 때만 시작하세요.';
    }

    const webStart = document.querySelector('[data-action="web-start"]');
    webStart.textContent = data.web.running && !data.web.managed ? '관리 연결' : data.web.running ? '실행 중' : '시작';
    webStart.dataset.locked = String(data.web.running && data.web.managed);
    const ollamaStart = document.querySelector('[data-action="ollama-start"]');
    ollamaStart.textContent = data.ollama.running ? '실행 중' : '시작';
    ollamaStart.dataset.locked = String(data.ollama.running);
    document.querySelectorAll('[data-stop-service="web"]').forEach((button) => {
      button.dataset.locked = String(!data.web.managed);
      button.title = data.web.running && !data.web.managed ? '관리자가 시작한 서버만 종료할 수 있습니다.' : '';
    });
    document.querySelectorAll('[data-stop-service="ollama"]').forEach((button) => {
      button.dataset.locked = String(!data.ollama.managed);
      button.title = data.ollama.running && !data.ollama.managed ? '다른 앱에서 실행한 Ollama는 종료하지 않습니다.' : '';
    });
    document.querySelectorAll('[data-action="tunnel-start"]').forEach((button) => {
      button.textContent = data.tunnel.running ? '연결 중' : '터널 시작';
      button.dataset.locked = String(data.tunnel.running);
    });
    document.querySelectorAll('[data-action="tunnel-stop"]').forEach((button) => {
      button.dataset.locked = String(!data.tunnel.running);
    });
    $('stopAllButton').dataset.locked = String(!data.web.managed && !data.ollama.managed && !data.tunnel.running);
    $('lastUpdated').textContent = `마지막 확인 ${new Date(data.checkedAt).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}`;
    updateQr(data.tunnel);
  } catch (error) {
    setBadge('webBadge', '관리 연결 끊김', 'bad');
    $('lastUpdated').textContent = '상태를 가져오지 못했어요';
    announce(error.message, true);
  } finally {
    if (!state.busy) document.querySelectorAll('button').forEach((button) => { button.disabled = button.dataset.locked === 'true'; });
  }
}

function updateQr(tunnel) {
  const image = $('qrImage');
  const url = tunnel.running ? tunnel.url : '';
  state.tunnelUrl = url;
  $('qrState').textContent = url ? '휴대폰으로 스캔하세요' : tunnel.running ? '주소 확인 중' : '터널을 시작해 주세요';
  $('qrPlaceholder').hidden = Boolean(url);
  image.hidden = !url;
  $('phoneUrl').hidden = !url;
  $('copyUrlButton').disabled = !url || state.busy;
  if (url) {
    $('phoneUrl').href = url;
    $('phoneUrl').textContent = url.replace('https://', '');
    if (image.dataset.url !== url) {
      image.dataset.url = url;
      image.src = `/api/qr?url=${encodeURIComponent(url)}`;
    }
  } else {
    image.removeAttribute('src');
    image.dataset.url = '';
    $('phoneUrl').removeAttribute('href');
  }
}

async function runAction(action) {
  if (state.busy) return;
  setButtonsDisabled(true);
  announce(action === 'stop' ? '관리 중인 서비스를 종료하고 있어요…' : '요청한 서비스를 준비하고 있어요.');
  try {
    const response = await fetch('/api/action', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action }),
    });
    const result = await response.json();
    if (!response.ok || !result.ok) throw new Error(result.message || result.output || '요청을 완료하지 못했어요.');
    announce(result.output || '작업을 완료했습니다.');
    await refreshLogs();
  } catch (error) { announce(error.message, true); }
  finally { setButtonsDisabled(false); await refreshStatus(); }
}

async function refreshLogs() {
  try {
    const response = await fetch('/api/logs', { cache: 'no-store' });
    if (!response.ok) return;
    const { logs } = await response.json();
    $('webLog').textContent = logs.web || '로그 없음';
    $('ollamaLog').textContent = logs.ollama || '로그 없음';
    $('tunnelLog').textContent = logs.tunnel || '로그 없음';
  } catch { /* 로그는 상태 화면을 막지 않습니다. */ }
}

document.querySelectorAll('[data-action]').forEach((button) => {
  button.addEventListener('click', () => runAction(button.dataset.action));
});
$('startAllButton').addEventListener('click', () => runAction('start'));
$('stopAllButton').addEventListener('click', () => runAction('stop'));
$('refreshButton').addEventListener('click', refreshStatus);
document.querySelector('.logs-panel').addEventListener('toggle', (event) => {
  if (event.currentTarget.open) void refreshLogs();
});
$('copyUrlButton').addEventListener('click', async () => {
  if (!state.tunnelUrl) return;
  try { await navigator.clipboard.writeText(state.tunnelUrl); announce('휴대폰 접속 주소를 복사했어요.'); }
  catch { announce('주소 복사에 실패했어요. QR을 사용해 주세요.', true); }
});

void refreshStatus();
window.setInterval(() => { if (!state.busy) void refreshStatus(); }, 6000);
