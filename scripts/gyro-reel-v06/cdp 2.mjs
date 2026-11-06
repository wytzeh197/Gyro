import {writeFileSync} from 'node:fs';
export const port=Number(process.env.GYRO_CAPTURE_PORT||9349);
export async function connectBrowser(){
 const version=await(await fetch(`http://127.0.0.1:${port}/json/version`)).json();
 const ws=new WebSocket(version.webSocketDebuggerUrl);let seq=0;const pending=new Map();
 ws.addEventListener('message',e=>{const m=JSON.parse(e.data),p=pending.get(m.id);if(p){pending.delete(m.id);m.error?p.reject(Error(m.error.message)):p.resolve(m.result)}});
 await new Promise((resolve,reject)=>{ws.addEventListener('open',resolve,{once:true});ws.addEventListener('error',reject,{once:true})});
 const send=(method,params={})=>new Promise((resolve,reject)=>{const id=++seq;pending.set(id,{resolve,reject});ws.send(JSON.stringify({id,method,params}))});
 return {send,close:()=>ws.close()};
}
export async function connect(options={}){
 const pages=await(await fetch(`http://127.0.0.1:${port}/json/list`)).json();
 const page=options.targetId?pages.find(x=>x.id===options.targetId):pages.find(x=>x.type==='page'&&x.url.includes('1428'))||pages.find(x=>x.type==='page');
 if(!page)throw Error('No capture page');
 const ws=new WebSocket(page.webSocketDebuggerUrl);let seq=0;const pending=new Map();
 ws.addEventListener('message',e=>{const m=JSON.parse(e.data);if(!m.id)return;const p=pending.get(m.id);if(p){pending.delete(m.id);m.error?p.reject(Error(m.error.message)):p.resolve(m.result)}});
 await new Promise((resolve,reject)=>{ws.addEventListener('open',resolve,{once:true});ws.addEventListener('error',reject,{once:true})});
 const send=(method,params={})=>new Promise((resolve,reject)=>{const id=++seq;pending.set(id,{resolve,reject});ws.send(JSON.stringify({id,method,params}))});
 await send('Emulation.setDeviceMetricsOverride',{width:options.width||1920,height:options.height||1080,deviceScaleFactor:options.dpr||Number(process.env.GYRO_DPR||3),mobile:false});
 const evalJS=async expression=>{const r=await send('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});if(r.exceptionDetails)throw Error(JSON.stringify(r.exceptionDetails));return r.result.value};
 const shot=async(path,clip)=>{const params={format:path.endsWith('.png')?'png':'jpeg',captureBeyondViewport:false,fromSurface:true};if(params.format==='jpeg')params.quality=95;if(clip)params.clip={...clip,scale:1};const r=await send('Page.captureScreenshot',params);writeFileSync(path,Buffer.from(r.data,'base64'))};
 return {send,evalJS,shot,targetId:page.id,close:()=>ws.close()};
}
