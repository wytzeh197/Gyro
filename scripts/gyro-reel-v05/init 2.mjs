import {connect} from './cdp.mjs';
const c=await connect();
try{
 await c.send('Emulation.setDeviceMetricsOverride',{width:1440,height:900,deviceScaleFactor:1,mobile:false});
 await c.send('Page.navigate',{url:'http://127.0.0.1:1427/capture.html?scene=chat&theme=light&reel=1'});
 for(let i=0;i<60;i++){if(await c.evalJS(`!!document.querySelector('textarea') && !!window.__gyroReelFixture`))break;await new Promise(r=>setTimeout(r,250));}
 await new Promise(r=>setTimeout(r,700));
 console.log(JSON.stringify(await c.evalJS(`({text:document.body.innerText.slice(-3500),buttons:[...document.querySelectorAll('button')].map(b=>({text:b.innerText,label:b.getAttribute('aria-label'),title:b.title})),fields:[...document.querySelectorAll('textarea,input')].map(x=>({tag:x.tagName,placeholder:x.placeholder}))})`)));
 await c.shot('docs/media/launch/reel-v05/initial.png');
}finally{c.close()}
