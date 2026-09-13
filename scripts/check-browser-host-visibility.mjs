import assert from 'node:assert/strict';
import { createBrowserHostVisibility } from '../apps/desktop/src/browser-host-visibility.ts';

const bounds = { x: 20, y: 40, width: 380, height: 600 };
const calls = [];
let finishBounds;
const update = createBrowserHostVisibility(async (command, args) => {
  calls.push({ command, ...args });
  if (command === 'session_browser_set_bounds' && args.sessionId === 'left') {
    await new Promise(resolve => { finishBounds = resolve; });
  }
});
const showing = update('left', bounds);
await Promise.resolve();
assert.equal(typeof finishBounds, 'function');
// Closing a split pane while its native bounds request is still in flight.
const closing = update('left', null);
// A separate session can mount without waiting for the closing pane.
await update('right', bounds);
finishBounds();
await Promise.all([showing, closing]);
assert.deepEqual(calls.filter(c => c.sessionId === 'left'), [
  { command: 'session_browser_set_bounds', sessionId: 'left', bounds },
  { command: 'session_browser_set_visible', sessionId: 'left', visible: false },
]);
assert.equal(calls.find(c => c.sessionId === 'right' && c.visible === true)?.visible, true);

const reopenCalls = [];
let fail = true;
const reopen = createBrowserHostVisibility(async (command, args) => {
  if (fail) throw new Error('Child not created yet');
  reopenCalls.push({ command, ...args });
});
await reopen('solo', bounds);
fail = false;
await reopen('solo', null);
await reopen('solo', bounds);
assert.deepEqual(reopenCalls.map(c => c.visible ?? 'bounds'), [false, 'bounds', true]);
// Superseded mount reports must never show an already closed panel.
reopenCalls.length = 0;
await Promise.all([reopen('solo', bounds), reopen('solo', null)]);
assert.deepEqual(reopenCalls, [{ command: 'session_browser_set_visible', sessionId: 'solo', visible: false }]);
console.log('browser host visibility: passed');
