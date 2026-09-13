import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';

// Exercise the real capability-resource listener with file events, without
// mounting Tauri. Reads should remain visible as activity, not editor tabs.
const source = readFileSync(new URL('../apps/desktop/src/App.tsx', import.meta.url), 'utf8');
const start = source.indexOf('      (event) => {', source.indexOf('void listen<ProviderCapabilityResourceEvent>'));
const end = source.indexOf('\n    ).then((unlisten)', start);
assert.ok(start > 0 && end > start);
const callback = source.slice(start, end).trim().replace(/,$/, '');
const js = ts.transpile(`const handler = ${callback};`, { target: ts.ScriptTarget.ES2022 });
const actions = [];
const modelFollowRef = { current: 'peek' };
const deps = {
  isMounted: true,
  liveCapabilityResourceIdsRef: { current: new Set() },
  setCapabilityResourceDataByCallId: () => {},
  activeSessionIdRef: { current: 'active' },
  modelFollowRef,
  dispatchWorkbench: action => actions.push(action),
  recordFromUnknown: value => value,
  stringFromRecord: (value, key) => typeof value?.[key] === 'string' ? value[key] : undefined,
  workspaceName: path => path.split('/').pop(),
  setEditorRevealTarget: target => actions.push({ type: 'reveal', target }),
  setSelectedFile: path => actions.push({ type: 'select', path }),
};
const handler = new Function(...Object.keys(deps), `${js}\nreturn handler;`)(...Object.values(deps));
function read(sessionId, index) {
  handler({ payload: { sessionId, callId: `read-${index}`, resource: { id: `file-${index}`, kind: 'ide', label: `src/file-${index}.ts` }, data: { path: `src/file-${index}.ts`, line: 12 } } });
}
for (const mode of ['peek', 'follow', 'off']) {
  modelFollowRef.current = mode;
  for (const sessionId of ['active', 'background']) {
    actions.length = 0;
    for (let i = 0; i < 25; i++) read(sessionId, i);
    if (mode === 'follow' && sessionId === 'active') {
      assert.equal(actions.filter(action => action.type === 'ide-open-tab').length, 25);
      assert.equal(actions.filter(action => action.type === 'reveal' && action.target.lineNumber === 12).length, 25);
      assert.equal(actions.filter(action => action.type === 'select-workspace-layout' && action.layout === 'code').length, 25);
    } else {
      assert.equal(actions.length, 25);
      assert.ok(actions.every(action => action.type === 'set-model-focus'),
        `${mode}: file reads must not open tabs, select files, reveal lines, or change layouts`);
    }
  }
}
console.log('model file visibility: passed (25 reads per mode and session, only active Follow opens files)');
