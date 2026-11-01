import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
const root='/tmp/gyro-tester-preflight-20261014/frontend';
const profile=await mkdtemp(join(tmpdir(),'gyro-preflight-extra-'));
const browser=spawn(process.env.GYRO_CAPTURE_BROWSER,['--headless=new','--disable-gpu','--no-first-run',`--user-data-dir=${profile}`,'--remote-debugging-port=0','about:blank'],{stdio:'ignore'});
const pause=ms=>new Promise(r=>setTimeout(r,ms));
async function until(fn,label){const end=Date.now()+30000;while(Date.now()<end){try{const r=await fn();if(r)return r;}catch{}await pause(100);}throw Error(`Timed out ${label}`);}
let ws;
try{
 const port=await until(async()=>String(await readFile(join(profile,'DevToolsActivePort'),'utf8')).split('\n')[0],'browser');
 const pages=await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();ws=new WebSocket(pages.find(p=>p.type==='page').webSocketDebuggerUrl);
 await new Promise((r,j)=>{ws.onopen=r;ws.onerror=j;});let seq=0;const pending=new Map();
 ws.onmessage=({data})=>{const m=JSON.parse(String(data));const r=pending.get(m.id);if(r){pending.delete(m.id);m.error?r.reject(m.error):r.resolve(m.result);}};
 const call=(method,params={})=>new Promise((resolve,reject)=>{const id=++seq;pending.set(id,{resolve,reject});ws.send(JSON.stringify({id,method,params}));});
 const evaluate=async expression=>{const r=await call('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true});if(r.exceptionDetails)throw Error(JSON.stringify(r.exceptionDetails));return r.result.value;};
 const navigate=async page=>{await call('Page.navigate',{url:`http://127.0.0.1:1520/${page}`});await until(()=>evaluate('document.readyState === "complete" && !!document.querySelector("button")'),'page ready');await pause(200);};
 const click=async label=>{await evaluate(`(()=>{const b=[...document.querySelectorAll('button')].find(b=>b.textContent.trim()===${JSON.stringify(label)});if(!b)throw Error('Missing button '+${JSON.stringify(label)});b.click();})()`);await pause(120);};
 const capture=async name=>{const r=await call('Page.captureScreenshot',{format:'png'});await writeFile(join(root,name),Buffer.from(r.data,'base64'));};
 await call('Page.enable');await call('Runtime.enable');await call('Emulation.setDeviceMetricsOverride',{width:1280,height:900,deviceScaleFactor:1,mobile:false});

 await navigate('workspace-navigation-fixture.html');await until(()=>evaluate('!!window.__workspaceFixture && window.__workspaceFixture.monaco.editor.getEditors().length'),'editor');
 const me=`window.__workspaceFixture.monaco.editor.getEditors().find(e=>e.getDomNode()?.closest('.workspace-fixture-main'))`;
 const geom=()=>evaluate(`(()=>{const p=document.querySelector('.gyro-workspace-primary'),s=document.querySelector('.workspace-fixture-editors');const rect=n=>n?({x:n.getBoundingClientRect().x,y:n.getBoundingClientRect().y,width:n.getBoundingClientRect().width,height:n.getBoundingClientRect().height}):null;return {rows:getComputedStyle(p).gridTemplateRows,primary:rect(p),bar:rect(p.querySelector('.gyro-workspace-edit-bar')),editors:rect(s),monaco:rect(${me}.getDomNode()),file:window.__workspaceFixture.getState().main,dirty:Object.values(window.__workspaceFixture.getState().workbench?.ide?.buffers??{}).filter(b=>b.dirty).map(b=>b.path)};})()`);
 console.log('INITIAL',JSON.stringify(await geom()));
 await click('Split same file');await pause(300);await evaluate(`(()=>{const e=${me};e.setPosition({lineNumber:3,column:18});e.setScrollTop(0);e.focus();})()`);
 for(const type of ['keyDown','keyUp'])await call('Input.dispatchKeyEvent',{type,key:'F12',code:'F12',windowsVirtualKeyCode:123});
 await until(()=>evaluate('window.__workspaceFixture.getState().main === window.__workspaceFixture.targetPath'),'F12');await click('Open main.ts');await pause(500);
 const broken=await geom();console.log('AFTER_F12',JSON.stringify(broken));await capture('workspace-layout-broken.png');
 await evaluate(`(()=>{const s=document.createElement('style');s.textContent='.workspace-fixture > .gyro-workspace-primary:has(> .gyro-workspace-edit-bar) { grid-template-rows:auto minmax(0,1fr); }';document.head.append(s);})()`);await pause(500);const fixed=await geom();console.log('WITH_SPECIFICITY_FIX',JSON.stringify(fixed));await capture('workspace-layout-specificity-fix.png');
 assert.ok(broken.monaco.height<50);assert.ok(fixed.monaco.height>500);
 await evaluate(`(()=>{const e=${me};e.setPosition({lineNumber:3,column:18});e.setScrollTop(0);e.focus();})()`);await pause(250);
 const point=await evaluate(`(()=>{const e=${me},p=e.getScrolledVisiblePosition({lineNumber:3,column:18}),b=e.getDomNode().getBoundingClientRect();return {x:b.x+p.left+3,y:b.y+p.top+p.height/2};})()`);
 await call('Input.dispatchKeyEvent',{type:'keyDown',key:'Meta',code:'MetaLeft',windowsVirtualKeyCode:91,modifiers:4});await call('Input.dispatchMouseEvent',{type:'mouseMoved',...point,modifiers:4});await pause(400);
 for(const type of ['mousePressed','mouseReleased'])await call('Input.dispatchMouseEvent',{type,...point,button:'left',clickCount:1,modifiers:4});await call('Input.dispatchKeyEvent',{type:'keyUp',key:'Meta',code:'MetaLeft',windowsVirtualKeyCode:91});
 await until(()=>evaluate('window.__workspaceFixture.getState().main === window.__workspaceFixture.targetPath'),'Cmd-click after specificity fix');console.log('PASS Cmd-click after specificity fix');
 await writeFile(join(root,'workspace-specificity-result.json'),JSON.stringify({broken,fixed,cmdClick:'PASS after temporary CSS correction'},null,2));
}finally{ws?.close();browser.kill('SIGTERM');await pause(250);await rm(profile,{recursive:true,force:true,maxRetries:5,retryDelay:100});}
