import {connect} from './cdp.mjs';
import {mkdirSync,readFileSync,writeFileSync} from 'node:fs';
const out='docs/media/launch/reel-v05';
const preview=process.argv.includes('--preview');
const c=await connect();
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const E=s=>c.evalJS(s);
const settle=()=>E('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))');
async function until(s){for(let i=0;i<100;i++){if(await E(s))return;await sleep(100)}throw Error('Timed out: '+s)}
async function click(selector){await E('window.__gyroFilm?.identity()');await E(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e)throw Error('Missing '+${JSON.stringify(selector)});e.click()})()`);await settle()}
async function clickText(text){await E('window.__gyroFilm?.identity()');await E(`(()=>{const e=[...document.querySelectorAll('button')].find(b=>b.offsetWidth&&b.innerText===${JSON.stringify(text)});if(!e)throw Error('Missing '+${JSON.stringify(text)});e.click()})()`);await settle()}
async function type(value){await E('window.__gyroFilm?.identity()');await E(`(()=>{const e=document.querySelector('textarea');Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(e,${JSON.stringify(value)});e.dispatchEvent(new Event('input',{bubbles:true}))})()`);await settle()}
async function rect(selector){return E(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e)return null;const r=e.getBoundingClientRect();return {x:r.x,y:r.y,w:r.width,h:r.height,cx:r.x+r.width/2,cy:r.y+r.height/2}})()`)}
async function native(name){await c.shot(`${out}/native-${name}.png`)}
async function start(){
 await c.send('Page.navigate',{url:'http://127.0.0.1:1427/capture.html?scene=chat&theme=light&reset=1&reel=1'});
 await until(`!!document.querySelector('textarea')&&!!window.__gyroReelFixture`);await sleep(400);
 await click('button[aria-label="Bound the sync queue retries"]');
 await E(`document.querySelector('button[aria-label="Close environment"]')?.click()`);await settle();
 await E('document.fonts.ready');
}
async function complete(){await E('window.__gyroFilm?.identity()');await until('window.__gyroReelFixture.pending');await E('window.__gyroReelFixture.complete()');await until(`!!document.querySelector('button[title="Show the change to src/sync.js"]')`);await settle()}
async function review(){await click('button[title="Show the change to src/sync.js"]');await clickText('Review');await until(`!!document.querySelector('.gyro-diff-tree-file')`);await settle()}
async function compare(){await clickText('Compare current file');await until(`[...document.querySelectorAll('button')].some(b=>b.innerText==='Open file')`)}
async function openEditor(){await clickText('Open file');await until(`!!document.querySelector('.monaco-editor .view-line')`);await sleep(250);await settle();}
async function editor(){await compare();await openEditor()}
async function select(){await E('window.__gyroFilm?.identity()');await E(String.raw`(async()=>{const source=await(await fetch('/src/monaco-editor.ts')).text();const url=source.match(/from [\"']([^\"']*\/monaco-editor\.js[^\"']*)/)[1];const m=await import(url);const e=m.editor.getEditors().find(e=>e.getModel()?.uri.path.endsWith('/sync.js'));if(!e)throw Error('Missing real editor');e.focus();e.setSelection(new m.Selection(3,1,3,24));window.__gyroCaptureEditor=e;return e.getSelection()})()`);await settle()}
async function terminal(){await click('button[aria-label="Open the workspace panel"]');await clickText('Shell');await until(`!!document.querySelector('.xterm-screen')`);await sleep(400);await settle()}
try{
 mkdirSync(`${out}/${preview?'preview':'frames'}`,{recursive:true});
 // Freeze date-derived labels; requestAnimationFrame and performance clocks stay live.
 await c.send('Page.addScriptToEvaluateOnNewDocument',{source:`{const RealDate=Date;const fixed=Date.parse('2026-07-25T16:00:00Z');window.Date=class extends RealDate{constructor(...a){super(...(a.length?a:[fixed]))}static now(){return fixed}}}`});
 await start();
 const comp=await rect('textarea'),send=await rect('button[aria-label="Send message"]');
 await native('composer');await type('Limit retries. Add a test.');await click('button[aria-label="Send message"]');await complete();await native('result');
 const resultButton=await rect('button[title="Show the change to src/sync.js"]');
 console.log('result',await E(`document.querySelector('.gyro-run-header-toggle')?.innerText`));
 await review();await native('review');
 const rev=await rect('.gyro-diff-tree-file');
 await editor();await select();await native('editor');
 const line=await E(`(()=>{const e=[...document.querySelectorAll('.view-line')].find(e=>e.textContent.includes('MAX_ATTEMPTS'));const r=e.getBoundingClientRect();return {x:r.x,y:r.y,w:r.width,h:r.height}})()`);
 await terminal();await native('terminal');
 const term=await rect('.xterm-screen');
 const anchors={composer:[comp.cx,comp.cy+25],send:[send.cx,send.cy],result:[resultButton.cx,resultButton.cy-85],review:[rev.cx,330],editor:[line.x+240,line.y+65],terminal:[term.x+240,term.y+110]};
 console.log('anchors',anchors,'term',term);writeFileSync(`${out}/anchors.json`,JSON.stringify({anchors,comp,send,resultButton,rev,line,term},null,2));
 await start();
 await E(readFileSync('scripts/gyro-reel-v05/film.js','utf8'));
 const logo=readFileSync('packages/ui/src/assets/gyro-logo-transparent-dark.png').toString('base64');
 await E(`document.querySelector('#film-brand img').src='data:image/png;base64,${logo}';Object.entries(${JSON.stringify(anchors)}).forEach(([k,p])=>window.__gyroFilm.setAnchor(k,...p));true`);await settle();
 const prompt='Limit retries. Add a test.';let prior='';const frames=[];
 for(let f=0;f<900;f++){
  const t=f/60;
  if(f>=180&&f<=209){const value=prompt.slice(0,Math.floor((f-180)/29*prompt.length));if(value!==prior){await type(value);prior=value}}
  if(f===213)await click('button[aria-label="Send message"]');
  if(f===246)await complete();
  if(f===312)await review();
  if(f===365)await compare();
  if(f===385)await openEditor();
  if(f===412)await select();
  if(f===492)await terminal();
  if([0,270,350,435,555].includes(f)){await E('window.__gyroFilm.identity()');await settle();await c.shot(`${out}/fidelity-${f}.png`)}
  if(preview&&f%15!==0&&![179,209,212,251,311,371,411,491,899].includes(f))continue;
  const pose=await E(`window.__gyroFilm.draw(${t})`);await settle();
  await c.shot(`${out}/${preview?'preview':'frames'}/${String(f).padStart(4,'0')}.jpg`);frames.push(pose);
  if(f%60===0)console.log(`Rendered ${f}/900 (${t.toFixed(1)}s)`);
 }
 writeFileSync(`${out}/${preview?'preview':'render'}-poses.json`,JSON.stringify(frames,null,2));
 await E('window.__gyroFilm.draw(13.5)');await settle();await c.shot(`${out}/poster.png`);
 console.log('Complete');
}finally{c.close()}
