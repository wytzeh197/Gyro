import {connect} from './cdp.mjs';
import {copyFileSync} from 'node:fs';
const c=await connect(),out='docs/media/launch/reel-v05';
try{
 await c.evalJS(`document.querySelector('#film-brand span').style.fontFamily='var(--gyro-font-display)';document.querySelector('#film-soon').style.fontFamily='var(--gyro-font-sans)';true`);
 for(let f=728;f<=780;f++){
  await c.evalJS(`window.__gyroFilm.draw(${f/60})`);
  await c.evalJS('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))');
  await c.shot(`${out}/frames/${String(f).padStart(4,'0')}.jpg`);
 }
 for(let f=781;f<900;f++)copyFileSync(`${out}/frames/0780.jpg`,`${out}/frames/${String(f).padStart(4,'0')}.jpg`);
 await c.shot(`${out}/poster.png`);
 console.log('Ending uses native Gyro typography.');
}finally{c.close()}
