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
 const menuResults=[];
 for(const theme of ['dark','light'])for(const large of [false,true])for(const narrow of [false,true]){
  await navigate('new-session-preview.html');if(theme==='light')await click('Toggle theme');if(large)await click('Toggle interface size');if(narrow)await click('Toggle narrow sidebar');await click('New Session');
  await until(()=>evaluate('!!document.querySelector(".gyro-sidebar-new-session-menu")'),'menu');
  const g=await evaluate(`(()=>{const m=document.querySelector('.gyro-sidebar-new-session-menu');const b=m.getBoundingClientRect();const rows=[...m.querySelectorAll('button')];const rects=rows.map(r=>r.getBoundingClientRect());return {width:b.width,right:b.right,height:b.height,overflow:document.body.scrollWidth>innerWidth,overlap:rects.some((r,i)=>rects[i+1]&&r.bottom>rects[i+1].top+0.5),chat:!!m.querySelector('.is-chat'),cli:!!m.querySelector('.is-cli'),picker:!!m.querySelector('select'),padding:getComputedStyle(m).padding,rowHeights:rects.map(r=>r.height)};})()`);
  console.log('MENU',JSON.stringify({theme,large,narrow,...g}));assert.equal(g.overlap,false);assert.equal(g.overflow,false);assert.ok(g.chat&&g.cli&&!g.picker);assert.ok(g.width<=240&&g.right<=1280);assert.ok(g.rowHeights.every(h=>h>=24&&h<=48));menuResults.push({theme,large,narrow,...g});
  if(!large&&!narrow)await capture(`new-session-${theme}.png`);
  await evaluate(`document.querySelector('button[aria-label="New Chat"]').click()`);await until(()=>evaluate('document.querySelector("[aria-label=\\"Fixture action\\"]").textContent.includes("New Chat callback received")'),'New Chat callback');
 }
 await navigate('goal-plan-fixture.html?panel=none');
 const goalResults=[];
 for(const status of ['queued','running','waiting-approval','blocked','paused','complete']){
  await click(`Goal fixture: ${status}`);const g=await evaluate(`(()=>{const n=document.querySelector('.gyro-goal-strip');return {running:n.dataset.running??null,status:n.dataset.runStatus,label:n.getAttribute('aria-label'),animation:getComputedStyle(n.querySelector('svg')).animationName};})()`);
  const moving=['queued','running','waiting-approval'].includes(status);assert.equal(g.running,moving?'true':null);assert.equal(g.animation!=='none',moving);assert.equal(g.status,status);goalResults.push(g);
 }
 await click('Restore goal');await click('Toggle goal editor');assert.equal(await evaluate('!!document.querySelector(".gyro-goal-strip")'),false);assert.equal(await evaluate('document.querySelector("[aria-label=\\"Close goal editor — draft is kept\\"]")?.hasAttribute("title")'),false);
 await evaluate(`document.querySelector('[aria-label="Close goal editor — draft is kept"]').click()`);await until(()=>evaluate('!!document.querySelector(".gyro-goal-strip")'),'goal close');await capture('goal-strip.png');
 await navigate('browser-viewport-fixture.html');await until(()=>evaluate('!!document.querySelector("iframe[title=\\"Browser preview\\"]")'),'browser iframe');
 const browserResults=[];
 for(const panel of [320,480,960]){await click(`${panel}px panel`);await pause(200);const g=await evaluate(`(()=>{const f=document.querySelector('iframe[title="Browser preview"]');const b=f.getBoundingClientRect(),p=f.parentElement.getBoundingClientRect();return {src:f.src,title:f.title,width:b.width,parentWidth:p.width,transform:getComputedStyle(f).transform,ready:f.contentDocument?.readyState,body:f.contentDocument?.body.innerText.slice(0,120)};})()`);assert.ok(g.src.startsWith('http://127.0.0.1:1520/'));assert.equal(g.ready,'complete');assert.ok(g.width<=g.parentWidth+1&&g.width>0);browserResults.push({panel,...g});}
 await capture('browser-fit.png');
 const results={result:'PASS',menuResults,goalResults,browserResults};await writeFile(join(root,'extra-fixture-results.json'),JSON.stringify(results,null,2));console.log(JSON.stringify(results,null,2));
}finally{ws?.close();browser.kill('SIGTERM');await pause(250);await rm(profile,{recursive:true,force:true,maxRetries:5,retryDelay:100});}
