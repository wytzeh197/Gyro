import {connect} from './cdp.mjs';
const c=await connect();const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const clickText=async(t)=>c.evalJS(`(()=>{const b=[...document.querySelectorAll('button')].find(b=>b.offsetWidth&&b.innerText===${JSON.stringify(t)});if(!b)throw Error('Missing '+${JSON.stringify(t)});b.click()})()`);
const dump=async(name)=>{await sleep(500);console.log(name,JSON.stringify(await c.evalJS(`({text:document.body.innerText.slice(-6000),buttons:[...document.querySelectorAll('button')].filter(b=>b.offsetWidth).slice(-35).map(b=>({t:b.innerText,l:b.getAttribute('aria-label'),title:b.title,cl:b.className}))})`)));await c.shot(`docs/media/launch/reel-v05/${name}.png`)};
try{
 await c.send('Page.navigate',{url:'http://127.0.0.1:1427/capture.html?scene=chat&theme=light&reel=1'});
 for(let i=0;i<70;i++){if(await c.evalJS(`!!document.querySelector('textarea') && !!window.__gyroReelFixture`))break;await sleep(200)}
 await sleep(700);await c.evalJS(`document.querySelector('button[aria-label="Bound the sync queue retries"]')?.click()`);await sleep(400);
 await c.evalJS(`document.querySelector('button[aria-label="Close environment"]')?.click()`);
 await c.evalJS(`(()=>{const e=document.querySelector('textarea');Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(e,'Limit retries. Add a test.');e.dispatchEvent(new Event('input',{bubbles:true}));})()`);await sleep(100);
 await c.evalJS(`document.querySelector('button[aria-label="Send message"]').click()`);
 for(let i=0;i<30;i++){if(await c.evalJS('window.__gyroReelFixture.pending'))break;await sleep(100)}
 await c.evalJS('window.__gyroReelFixture.complete()');await sleep(700);
 await clickText('Review');await dump('native-historical');
 await clickText('Compare current file');await dump('native-current');
 await c.evalJS(`document.querySelector('button[title="Open in editor"]')?.click()||document.querySelector('button[aria-label="Open in editor"]')?.click()`);await sleep(2000);await dump('native-editor');
}finally{c.close()}
