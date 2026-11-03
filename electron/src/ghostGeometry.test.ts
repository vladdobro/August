import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  clampRectInto,
  coinExpandedRect,
  parseGhostWindowState,
  placementFromRect,
  rectFromPlacement,
  resolveGhostDisplay,
  snapRelease,
  type GhostDisplay,
} from './ghostGeometry.js';

const D1: GhostDisplay = { id: 1, workArea: { x: 0, y: 0, width: 1920, height: 1040 } };
const D2: GhostDisplay = { id: 2, workArea: { x: 1920, y: 0, width: 1440, height: 860 } };

test('clampRectInto keeps the rect inside the work area', () => {
  assert.deepEqual(clampRectInto({ x: -50, y: 2000, width: 100, height: 100 }, D1.workArea), { x: 0, y: 940, width: 100, height: 100 });
  assert.deepEqual(clampRectInto({ x: 10, y: 10, width: 100, height: 100 }, D1.workArea), { x: 10, y: 10, width: 100, height: 100 });
});

test('snapRelease snaps within the threshold using the margin', () => {
  const r = snapRelease({ x: 20, y: 400, width: 300, height: 100 }, D1.workArea, 24);
  assert.equal(r.x, 24);
  assert.equal(r.y, 400);
});

test('snapRelease leaves a rect 40 px from the edge alone', () => {
  const r = snapRelease({ x: 40, y: 400, width: 300, height: 100 }, D1.workArea, 24);
  assert.deepEqual(r, { x: 40, y: 400, width: 300, height: 100 });
});

test('snapRelease snaps to a corner when two edges are near', () => {
  const r = snapRelease({ x: 1920 - 56 - 10, y: 1040 - 56 - 20, width: 56, height: 56 }, D1.workArea, 16);
  assert.deepEqual(r, { x: 1920 - 56 - 16, y: 1040 - 56 - 16, width: 56, height: 56 });
});

test('snapRelease pulls a rect dragged half off the right edge fully inside, flush', () => {
  const r = snapRelease({ x: 1920 - 150, y: 400, width: 300, height: 100 }, D1.workArea, 24);
  assert.equal(r.x, 1920 - 300 - 24);
  assert.ok(r.x + r.width <= 1920);
});

test('snapRelease clamps a rect larger than the work area', () => {
  const r = snapRelease({ x: -100, y: -100, width: 5000, height: 5000 }, D1.workArea, 24);
  assert.equal(r.width, 1920);
  assert.equal(r.height, 1040);
  assert.equal(r.x, 0);
  assert.equal(r.y, 0);
});

test('placement round trip on the second display', () => {
  const rect = { x: 3360 - 56 - 16, y: 860 - 56 - 16, width: 56, height: 56 };
  const p = placementFromRect(rect, D2);
  assert.equal(p.displayId, 2);
  assert.equal(p.hAnchor, 'right');
  assert.equal(p.vAnchor, 'bottom');
  assert.equal(p.hOffset, 16);
  assert.equal(p.vOffset, 16);
  assert.deepEqual(rectFromPlacement(p, { width: 56, height: 56 }, D2.workArea), rect);
});

test('placement offsets are measured from the nearest edge', () => {
  const p = placementFromRect({ x: 1920 + 100, y: 30, width: 300, height: 100 }, D2);
  assert.equal(p.hAnchor, 'left');
  assert.equal(p.hOffset, 100);
  assert.equal(p.vAnchor, 'top');
  assert.equal(p.vOffset, 30);
});

test('rectFromPlacement clamps oversized offsets inside the work area', () => {
  const r = rectFromPlacement({ displayId: 1, hAnchor: 'right', hOffset: 99999, vAnchor: 'bottom', vOffset: 99999 }, { width: 300, height: 100 }, D1.workArea);
  assert.deepEqual(r, { x: 0, y: 0, width: 300, height: 100 });
});

test('resolveGhostDisplay: known id, unplugged id with fallback, no fallback', () => {
  const p = { displayId: 2, hAnchor: 'left', hOffset: 0, vAnchor: 'top', vOffset: 0 } as const;
  assert.equal(resolveGhostDisplay(p, [D1, D2], null).id, 2);
  const gone = { ...p, displayId: 99 };
  assert.equal(resolveGhostDisplay(gone, [D1, D2], D2.workArea).id, 2);
  assert.equal(resolveGhostDisplay(gone, [D1, D2], null).id, 1);
  assert.equal(resolveGhostDisplay(undefined, [D1, D2], null).id, 1);
});

test('parseGhostWindowState keeps valid records and drops malformed ones', () => {
  const ok = { displayId: 1, hAnchor: 'left', hOffset: 5, vAnchor: 'bottom', vOffset: 7 };
  assert.deepEqual(parseGhostWindowState({ caption: ok, coin: ok }), { caption: ok, coin: ok });
  const bad = { displayId: '1', hAnchor: 'middle', hOffset: -1, vAnchor: 'bottom', vOffset: 7 };
  assert.deepEqual(parseGhostWindowState({ caption: bad, coin: ok }), { coin: ok });
  assert.deepEqual(parseGhostWindowState(null), {});
  assert.deepEqual(parseGhostWindowState([ok]), {});
  assert.deepEqual(parseGhostWindowState('x'), {});
});

test('coinExpandedRect grows toward the screen middle and never moves the face', () => {
  const face = { x: 1920 - 56 - 16, y: 1040 - 56 - 16, width: 56, height: 56 };
  const a = coinExpandedRect(face, 372, D1.workArea);
  assert.equal(a.faceSide, 'right');
  assert.equal(a.rect.x, face.x + 56 - 372);

  const left = { x: 16, y: 500, width: 56, height: 56 };
  const b = coinExpandedRect(left, 372, D1.workArea);
  assert.equal(b.faceSide, 'left');
  assert.equal(b.rect.x, left.x);
});

test('coinExpandedRect flips when the preferred side has no room', () => {
  const wa = { x: 0, y: 0, width: 500, height: 800 };
  const nearLeft = { x: 100, y: 100, width: 56, height: 56 };
  const a = coinExpandedRect(nearLeft, 200, wa, 'right');
  assert.equal(a.faceSide, 'left');
  assert.equal(a.rect.x, nearLeft.x);

  const nearRight = { x: 350, y: 100, width: 56, height: 56 };
  const b = coinExpandedRect(nearRight, 200, wa, 'left');
  assert.equal(b.faceSide, 'right');
  assert.equal(b.rect.x, nearRight.x + nearRight.width - 200);
});
