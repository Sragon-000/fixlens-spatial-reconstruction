const PREFIX = 'fixlens.layout.v1:';
const MAX_ITEMS = 30;

function label(value) {
  return String(value || '').trim().toLocaleLowerCase();
}

function validBox(box) {
  return box && ['x', 'y', 'w', 'h'].every((key) => Number.isFinite(box[key]))
    && box.x >= 0 && box.y >= 0 && box.w > 0 && box.h > 0
    && box.x + box.w <= 1.001 && box.y + box.h <= 1.001;
}

function validRegion(region) {
  return validBox(region) && region.w >= .01 && region.h >= .01;
}

function relativeBox(box, region) {
  const w = Math.min(1, box.w / region.w);
  const h = Math.min(1, box.h / region.h);
  const x = (box.x - region.x) / region.w;
  const y = (box.y - region.y) / region.h;
  return {
    x: Math.max(0, Math.min(1 - w, x)),
    y: Math.max(0, Math.min(1 - h, y)),
    w, h,
  };
}

function uniqueItems(items) {
  const names = new Set();
  for (const item of items) {
    const name = label(item.name);
    if (!name || names.has(name)) return false;
    names.add(name);
  }
  return true;
}

export function layoutStorageKey(zoneName) {
  const zone = label(zoneName).slice(0, 40);
  if (!zone) throw new Error('공간 이름을 입력해 주세요.');
  return `${PREFIX}${zone}`;
}

export function createSavedLayout(zoneName, region, candidates, now = Date.now()) {
  if (!validRegion(region)) throw new Error('스캔 영역을 확인해 주세요.');
  const items = candidates.filter((item) => item.keep && String(item.name || '').trim());
  if (!items.length || items.length > MAX_ITEMS) throw new Error('저장할 물건을 1~30개 확인해 주세요.');
  if (!uniqueItems(items)) throw new Error('같은 이름의 물건은 각각 다른 이름으로 바꿔 주세요.');
  const savedItems = items.map((item) => {
    if (!validBox(item.box)) throw new Error('물건 위치를 확인한 뒤 다시 스캔해 주세요.');
    return { name: String(item.name).trim().slice(0, 48), box: relativeBox(item.box, region) };
  });
  return { version: 1, zoneName: String(zoneName).trim().slice(0, 40), savedAt: now, items: savedItems };
}

export function isSavedLayout(value) {
  return value?.version === 1 && typeof value.zoneName === 'string' && value.zoneName.trim()
    && Number.isFinite(value.savedAt) && Array.isArray(value.items)
    && value.items.length > 0 && value.items.length <= MAX_ITEMS && uniqueItems(value.items)
    && value.items.every((item) => typeof item.name === 'string' && item.name.trim() && validBox(item.box));
}

export function readSavedLayout(storage, zoneName) {
  try {
    const raw = storage.getItem(layoutStorageKey(zoneName));
    if (!raw) return null;
    const saved = JSON.parse(raw);
    return isSavedLayout(saved) ? saved : null;
  } catch { return null; }
}

export function writeSavedLayout(storage, zoneName, saved) {
  if (!isSavedLayout(saved)) throw new Error('저장할 배치가 올바르지 않아요.');
  storage.setItem(layoutStorageKey(zoneName), JSON.stringify(saved));
}

export function deleteSavedLayout(storage, zoneName) {
  storage.removeItem(layoutStorageKey(zoneName));
}

export function createManualRestoreArrangement(saved, region) {
  if (!isSavedLayout(saved) || !validRegion(region)) throw new Error('저장된 배치를 읽을 수 없어요.');
  return saved.items.map((item, index) => {
    const w = Math.min(region.w, item.box.w * region.w);
    const h = Math.min(region.h, item.box.h * region.h);
    return {
      name: item.name, sourceName: item.name, detectorName: null, trackId: null, source: null,
      target: {
        x: Math.min(region.x + region.w - w, region.x + item.box.x * region.w),
        y: Math.min(region.y + region.h - h, region.y + item.box.y * region.h), w, h,
      },
      index, reason: '저장한 책상 위치에 직접 놓고 확인',
    };
  });
}
