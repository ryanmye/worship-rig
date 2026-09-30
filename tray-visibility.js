'use strict';
// L-30 (docs/menubar-mode.md "Tray hidden"): is the macOS status item actually on screen?
// When the menu bar is full (notch MacBooks), macOS gives a new status item no slot and "parks" it: tray.getBounds()
// then reports a zero-size rect, a rect at the origin ({x:0,y:0,width:38,height:22} measured on macOS 26.4) or one
// below the display ({x:0,y:<display height>,…}). A placed item sits at the top of its display, in the right half.
// Plain CommonJS with no Electron dependency so node:test can load it (test/unit/shell/tray-visibility.test.mjs).

/**
 * @param {{x:number,y:number,width:number,height:number}|null|undefined} b  tray.getBounds()
 * @param {{bounds:{x:number,y:number,width:number,height:number}}|{x:number,y:number,width:number,height:number}|null} [display]
 *   the Electron Display the bounds belong to (screen.getDisplayMatching(b), else screen.getPrimaryDisplay()), or its
 *   bounds rect
 * @returns {boolean} true when the icon has no visible slot
 */
function trayIsHidden(b, display) {
  if (!b || !(b.width > 0) || !(b.height > 0)) return true;
  const d = display && display.bounds ? display.bounds : display;
  // parked at the origin: a real status item never sits at the left edge of the main display. On a display to the
  // left of / above the main one, x and y are legitimately ≤ 0, so it also has to be at that display's left edge.
  if (b.x <= 0 && b.y <= 0 && (!d || b.x <= d.x)) return true;
  if (!d) return false;
  return b.y >= d.y + d.height || b.x + b.width <= d.x;
}

/**
 * Popover position while the tray is hidden: the top-right corner of the active display's work area.
 * @param {{x:number,y:number,width:number,height:number}} workArea
 */
function fallbackPopoverBounds(workArea, w = 320, h = 440) {
  return { x: workArea.x + workArea.width - w - 12, y: workArea.y + 8, width: w, height: h };
}

module.exports = { trayIsHidden, fallbackPopoverBounds };
