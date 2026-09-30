// L-30: trayIsHidden() — is the macOS status item on screen? Bounds measured on macOS 26.4 (notch MacBook,
// 1512×982 display): the real app's parked item {x:0,y:0,width:38,height:22}, a test item parked below the display
// {x:0,y:982,width:99,height:22}, a placed item {x:905,y:0,width:38,height:22}.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { trayIsHidden, fallbackPopoverBounds } = require('../../../tray-visibility.js');

const MAIN = { bounds: { x: 0, y: 0, width: 1512, height: 982 } };
const LEFT = { bounds: { x: -1920, y: -98, width: 1920, height: 1080 } }; // external display left of the main one

test('a placed item (top of the display, right half) is visible', () => {
  assert.equal(trayIsHidden({ x: 905, y: 0, width: 38, height: 22 }, MAIN), false);
  assert.equal(trayIsHidden({ x: 905, y: 0, width: 38, height: 22 }, MAIN.bounds), false, 'a bare bounds rect works too');
});

test('no bounds or a zero-size rect is hidden', () => {
  assert.equal(trayIsHidden(null, MAIN), true);
  assert.equal(trayIsHidden(undefined, MAIN), true);
  assert.equal(trayIsHidden({ x: 905, y: 0, width: 0, height: 22 }, MAIN), true);
  assert.equal(trayIsHidden({ x: 905, y: 0, width: 38, height: 0 }, MAIN), true);
  assert.equal(trayIsHidden({ x: 0, y: 982, width: 0, height: 0 }, MAIN), true, 'the RIG_FAKE_TRAY_BOUNDS case');
});

test('parked at the origin (the real app on a full menu bar) is hidden', () => {
  assert.equal(trayIsHidden({ x: 0, y: 0, width: 38, height: 22 }, MAIN), true);
  assert.equal(trayIsHidden({ x: 0, y: 0, width: 38, height: 22 }, null), true, 'without a display too');
  assert.equal(trayIsHidden({ x: -5, y: -5, width: 38, height: 22 }, MAIN), true);
});

test('parked below the display is hidden', () => {
  assert.equal(trayIsHidden({ x: 0, y: 982, width: 99, height: 22 }, MAIN), true);
  assert.equal(trayIsHidden({ x: 905, y: 1000, width: 38, height: 22 }, MAIN), true);
});

test('entirely left of the display is hidden', () => {
  assert.equal(trayIsHidden({ x: -40, y: 10, width: 38, height: 22 }, MAIN), true);
  assert.equal(trayIsHidden({ x: -38, y: 10, width: 38, height: 22 }, MAIN), true, 'right edge on display.x');
});

test('a placed item on a display left of / above the main one (negative x, y) is visible', () => {
  assert.equal(trayIsHidden({ x: -400, y: -98, width: 38, height: 22 }, LEFT), false);
});

test('fallback popover position: top-right of the work area, 12 px from the right, 8 px from the top', () => {
  const wa = { x: 0, y: 38, width: 1512, height: 944 };
  assert.deepEqual(fallbackPopoverBounds(wa), { x: 1512 - 320 - 12, y: 46, width: 320, height: 440 });
  assert.deepEqual(fallbackPopoverBounds({ x: -1920, y: -60, width: 1920, height: 1055 }, 300, 400),
    { x: -312, y: -52, width: 300, height: 400 });
});
