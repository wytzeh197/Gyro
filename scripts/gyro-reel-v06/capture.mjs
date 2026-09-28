import {connect,connectBrowser} from './cdp.mjs';
import {mkdirSync,writeFileSync,readFileSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
const out='docs/media/launch/reel-v06',base='http://127.0.0.1:1428';
const dpr=Number(process.env.CAPTURE_DPR||4);
if(!Number.isInteger(dpr)||dpr<1||dpr>6)throw Error('CAPTURE_DPR must be an integer from 1 to 6');
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const fixedDate=`{const RealDate=Date;const fixed=Date.parse('2026-07-25T16:00:00Z');window.Date=class extends RealDate{constructor(...a){super(...(a.length?a:[fixed]))}static now(){return fixed}}}`;
const manifest={schemaVersion:1,source:'Gyro running development capture harness; native DOM and canvas, unchanged interior geometry',url:`${base}/capture.html?scene=chat&theme=light&reset=1&reel=1`,viewport:{width:1920,height:1080,deviceScaleFactor:dpr},task:'Limit retries. Add a test.',session:'ses_capture_1',capturedAt:'2026-07-25T16:00:00Z',pages:{},assets:{},interactionOrder:['select seeded task','send native composer','fixture complete','changed-file card','Review','Compare current file','Open file','Monaco native selection','workspace Panel','Shell']};
const B=await connectBrowser(),open=[];
function use(c){
 const E=s=>c.evalJS(s),settle=()=>E('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))');
 async function until(s){for(let i=0;i<120;i++){if(await E(s))return;await sleep(100)}throw Error('Timed out: '+s)}
 async function click(selector){await E(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e)throw Error('Missing '+${JSON.stringify(selector)});e.click()})()`);await settle()}
 async function clickText(t){await E(`(()=>{const e=[...document.querySelectorAll('button')].find(b=>b.offsetWidth&&b.innerText===${JSON.stringify(t)});if(!e)throw Error('Missing '+${JSON.stringify(t)});e.click()})()`);await settle()}
 const rect=selector=>E(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e)return null;const r=e.getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height,cx:r.x+r.width/2,cy:r.y+r.height/2}})()`);
 async function complete(){
  await c.send('Page.addScriptToEvaluateOnNewDocument',{source:fixedDate});await c.send('Page.navigate',{url:manifest.url});
  await until(`!!document.querySelector('textarea')&&!!window.__gyroReelFixture`);await sleep(400);
  await click('button[aria-label="Bound the sync queue retries"]');
  await E(`(()=>{const e=document.querySelector('textarea');Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(e,'Limit retries. Add a test.');e.dispatchEvent(new Event('input',{bubbles:true}))})()`);await settle();
  await click('button[aria-label="Send message"]');await until('window.__gyroReelFixture.pending');await E('window.__gyroReelFixture.complete()');
  await until(`!!document.querySelector('button[title="Show the change to src/sync.js"]')`);await sleep(200);
  await E(`document.querySelector('button[aria-label="Close environment"]')?.click()`);await settle();
  await E('document.fonts.ready');await settle();
 }
 async function review(){await click('button[title="Show the change to src/sync.js"]');await clickText('Review');await until(`!!document.querySelector('.gyro-diff-tree-file')`);await sleep(250);await settle()}
 async function workspace(){
  await clickText('Compare current file');await until(`[...document.querySelectorAll('button')].some(b=>b.innerText==='Open file')`);await clickText('Open file');
  await until(`!!document.querySelector('.monaco-editor .view-line')`);await sleep(300);
  await E(String.raw`(async()=>{const source=await(await fetch('/src/monaco-editor.ts')).text();const url=source.match(/from [\"']([^\"']*\/monaco-editor\.js[^\"']*)/)[1];const m=await import(url);const e=m.editor.getEditors().find(e=>e.getModel()?.uri.path.endsWith('/sync.js'));if(!e)throw Error('Missing real editor');e.focus();e.setSelection(new m.Selection(3,1,3,24));window.__gyroCaptureEditor=e;return e.getSelection()})()`);
  await click('button[aria-label="Open the workspace panel"]');await clickText('Shell');await until(`!!document.querySelector('.xterm-screen')`);await sleep(600);await settle();
 }
 async function asset(name,source,rectValue){
  const r=rectValue||{x:0,y:0,width:1920,height:1080};const crop={x:Math.floor(r.x),y:Math.floor(r.y),width:Math.ceil(r.width),height:Math.ceil(r.height)},path=`${out}/assets/${name}.png`;
  // Derive every region from its preserved full native frame, so transient caret
  // blinking cannot create a fidelity difference between source and crop.
  if(source.startsWith('window-'))execFileSync('ffmpeg',['-v','error','-y','-i',`${out}/assets/${source}.png`,'-vf',`crop=${crop.width*dpr}:${crop.height*dpr}:${crop.x*dpr}:${crop.y*dpr}`,'-frames:v','1',path]);
  else await c.shot(path,crop);
  const png=readFileSync(path),width=png.readUInt32BE(16),height=png.readUInt32BE(20);
  if(width!==crop.width*dpr||height!==crop.height*dpr)throw Error(`Unexpected native PNG dimensions: ${name}`);
  manifest.assets[name]={path:`assets/${name}.png`,source,cssRect:crop,scale:dpr,width,height,sha256:createHash('sha256').update(png).digest('hex'),nativePixelCrop:source.startsWith('window-')};return crop;
 }
 return {E,rect,complete,review,workspace,asset,settle};
}
try{
 mkdirSync(`${out}/assets`,{recursive:true});
 for(const name of ['chat','review','workspace']){
  const context=await B.send('Target.createBrowserContext');const target=await B.send('Target.createTarget',{url:'about:blank',browserContextId:context.browserContextId});const c=await connect({targetId:target.targetId,dpr});open.push(c);
  manifest.pages[name]={targetId:target.targetId,browserContextId:context.browserContextId};const ui=use(c);await ui.complete();
  if(name==='chat'){
   manifest.typography=await ui.E(`(()=>{const s=getComputedStyle(document.documentElement),body=getComputedStyle(document.body),bubble=getComputedStyle(document.querySelector('.gyro-user-message-bubble'));return {sans:s.getPropertyValue('--gyro-font-sans'),display:s.getPropertyValue('--gyro-font-display'),body:body.fontFamily,bodyBackground:body.backgroundColor,bubbleFont:bubble.fontFamily,bubbleSize:bubble.fontSize,bubbleBackground:bubble.backgroundColor}})()`);
   await ui.asset('window-chat','chat');
   const bubble=await ui.rect('.gyro-user-message-bubble');manifest.nativeTaskBubble=bubble;await ui.asset('task','window-chat',bubble);
   const change=await ui.rect('button[title="Show the change to src/sync.js"]');const card=await ui.E(`(()=>{const e=document.querySelector('button[title="Show the change to src/sync.js"]');return [...(function*(x){while(x){yield x;x=x.parentElement}})(e)].slice(0,5).map(x=>({cl:x.className,text:x.innerText,rect:{x:x.getBoundingClientRect().x,y:x.getBoundingClientRect().y,width:x.getBoundingClientRect().width,height:x.getBoundingClientRect().height}}))})()`);
   manifest.chatGeometry={bubble,change,card};
   const conversation=await ui.asset('conversation','window-chat',{x:bubble.x-18,y:bubble.y-14,width:bubble.width+36,height:450});
   const reviewButton=await ui.E(`(()=>{const e=[...document.querySelectorAll('button')].find(b=>b.innerText==='Review'&&b.offsetWidth);const r=e.getBoundingClientRect();return{x:r.x,y:r.y,width:r.width,height:r.height,cx:r.x+r.width/2,cy:r.y+r.height/2}})()`);
   manifest.reviewClick={page:reviewButton,withinConversation:{x:reviewButton.cx-conversation.x,y:reviewButton.cy-conversation.y}};
  }else{
   await ui.review();
   if(name==='review'){
    await ui.asset('window-review','review');
    manifest.reviewGeometry=await ui.E(`[...document.querySelectorAll('.gyro-diff-tree-file, [class*="companion"], [class*="diff-surface"]')].filter(e=>e.offsetWidth).map(e=>({cl:e.className,rect:{x:e.getBoundingClientRect().x,y:e.getBoundingClientRect().y,width:e.getBoundingClientRect().width,height:e.getBoundingClientRect().height}}))`);
    await ui.asset('review','window-review',{x:1496,y:0,width:424,height:600});
   }else{
    await ui.workspace();await ui.asset('window-workspace','workspace');
    manifest.workspaceGeometry=await ui.E(`[...document.querySelectorAll('.monaco-editor,.xterm-screen,[class*="workspace-panel"],[class*="ide-tab"]')].filter(e=>e.offsetWidth).map(e=>({cl:e.className,rect:{x:e.getBoundingClientRect().x,y:e.getBoundingClientRect().y,width:e.getBoundingClientRect().width,height:e.getBoundingClientRect().height}}))`);
    await ui.asset('code','window-workspace',{x:280,y:0,width:680,height:230});
    await ui.asset('shell','window-workspace',{x:280,y:780,width:750,height:280});
   }
  }
  console.log(name,'ready',manifest.pages[name]);
 }
 const verifiedAssets=[];
 for(const [name,a] of Object.entries(manifest.assets)){
  if(!a.nativePixelCrop)continue;
  const r=a.cssRect,filter=`crop=${r.width*dpr}:${r.height*dpr}:${r.x*dpr}:${r.y*dpr}`;
  const srcHash=execFileSync('ffmpeg',['-v','error','-i',`${out}/assets/${a.source}.png`,'-vf',filter,'-f','md5','-'],{encoding:'utf8'}).trim();
  const assetHash=execFileSync('ffmpeg',['-v','error','-i',`${out}/${a.path}`,'-f','md5','-'],{encoding:'utf8'}).trim();
  if(srcHash!==assetHash)throw Error(`Native crop pixels differ for ${name}`);
  a.decodedPixelMD5=assetHash.replace('MD5=','');verifiedAssets.push(name);
 }
 manifest.fidelity={method:'Lossless native pixel regions derived from preserved full app frames; decoded pixel MD5 comparison',verifiedAssets,allCropsPixelIdentical:true};
 writeFileSync(`${out}/capture-manifest.json`,JSON.stringify(manifest,null,2));console.log(`Native DPR${dpr} captures complete, all region pixels verified`);
}finally{for(const c of open)c.close();B.close()}
