import {mkdirSync,copyFileSync,writeFileSync,readFileSync,existsSync} from 'node:fs';
import {resolve} from 'node:path';
import {connect,connectBrowser} from './cdp.mjs';
const mode=process.argv[2]||'boards';
const root=resolve('docs/media/launch/reel-v07');
const dpr=Number(process.env.GYRO_FILM_DPR||(mode==='final'?2:1));
const browser=await connectBrowser();
const {targetId}=await browser.send('Target.createTarget',{url:'about:blank'});
browser.close();
const c=await connect({targetId,dpr});
await c.send('Page.navigate',{url:process.env.GYRO_FILM_URL||'http://127.0.0.1:1428/scripts/gyro-reel-v07/index.html'});
for(let i=0;i<100;i++){if(await c.evalJS('Boolean(window.__filmReady)'))break;await new Promise(r=>setTimeout(r,100));}
if(!await c.evalJS('Boolean(window.__filmReady)'))throw Error('Film not ready');
await c.evalJS('document.fonts.ready.then(()=>true)');
const dir=mode==='boards'?resolve(root,'styleframes'):resolve('/tmp',`gyro-v07-${mode}-frames`);mkdirSync(dir,{recursive:true});
let frames=mode==='boards'?[57,210,294,333,399,438,504,581,669,810]:mode==='animatic'?Array.from({length:225},(_,i)=>i*4):Array.from({length:900},(_,i)=>i);
const partial=process.env.GYRO_FRAMES;
if(partial)frames=partial.split(',').flatMap(range=>{const [a,b]=range.split(':').map(Number);return Array.from({length:(b??a)-a+1},(_,i)=>a+i)});
let states=[];
for(let i=0;i<frames.length;i++){
 const frame=frames[i],name=mode==='boards'?`frame-${String(frame).padStart(4,'0')}.png`:`${String(mode==='final'?frame:i).padStart(5,'0')}.jpg`,path=resolve(dir,name);
 if(mode==='final'&&frame>780){copyFileSync(resolve(dir,'00780.jpg'),path);continue;}
 const state=await c.evalJS(`window.renderFrame(${frame}); new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve(window.__frameState))))`);states.push(state);
 await c.shot(path);
 if(i%60===0)console.log(`${mode}: ${i+1}/${frames.length} / t=${(frame/60).toFixed(2)}s`);
}
const statePath=resolve(root,`${mode}-poses.json`);
if(partial&&existsSync(statePath)){
 const all=new Map(JSON.parse(readFileSync(statePath)).map(s=>[s.frame,s]));
 for(const s of states)all.set(s.frame,s);
 states=[...all.values()].sort((a,b)=>a.frame-b.frame);
}
writeFileSync(statePath,JSON.stringify(states,null,2));
c.close();console.log(JSON.stringify({mode,dir,count:frames.length,dpr,targetId}));
