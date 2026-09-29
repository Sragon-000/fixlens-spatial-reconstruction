import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createSavedLayout, createManualRestoreArrangement,
  readSavedLayout, writeSavedLayout, deleteSavedLayout,
} from '../dist/layout-memory.mjs';

const region = { x: .1, y: .2, w: .8, h: .6 };
const items = [
  { name: '컵', sourceName: 'cup', box: { x: .18, y: .32, w: .08, h: .12 }, keep: true },
  { name: '책', sourceName: 'book', box: { x: .58, y: .38, w: .16, h: .2 }, keep: true },
];

test('saved positions restore into the current scan region', () => {
  const saved = createSavedLayout('책상 위', region, items, 1234);
  const nextRegion = { x: .05, y: .1, w: .9, h: .8 };
  const plan = createManualRestoreArrangement(saved, nextRegion);
  assert.equal(plan.length, 2);
  assert.equal(plan[0].source, null);
  assert.ok(Math.abs(plan[0].target.x - .14) < .0001);
  assert.ok(Math.abs(plan[0].target.y - .26) < .0001);
  assert.equal(plan[0].reason, '저장한 책상 위치에 직접 놓고 확인');
});

test('uncertain labels require correction instead of silently matching objects', () => {
  assert.throws(() => createSavedLayout('책상 위', region, [...items, { ...items[0] }]), /같은 이름/);
});

test('saved layout persists only through explicit storage action and can be removed', () => {
  const memory = new Map();
  const storage = { getItem: (key) => memory.get(key) ?? null, setItem: (key, value) => memory.set(key, value), removeItem: (key) => memory.delete(key) };
  const saved = createSavedLayout('책상 위', region, items, 1234);
  assert.equal(readSavedLayout(storage, '책상 위'), null);
  writeSavedLayout(storage, '책상 위', saved);
  assert.deepEqual(readSavedLayout(storage, '책상 위'), saved);
  assert.equal(readSavedLayout(storage, '다른 책상'), null);
  deleteSavedLayout(storage, '책상 위');
  assert.equal(readSavedLayout(storage, '책상 위'), null);
});

test('manual restoration works even after every object has been removed from the desk', () => {
  const saved = createSavedLayout('책상 위', region, items);
  const plan = createManualRestoreArrangement(saved, region);
  assert.equal(plan.length, 2);
  assert.equal(plan[0].source, null);
  assert.equal(plan[0].trackId, null);
  assert.ok(Math.abs(plan[1].target.x - items[1].box.x) < .0001);
});
