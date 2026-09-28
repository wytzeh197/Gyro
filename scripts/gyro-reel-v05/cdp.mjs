import {writeFileSync} from 'node:fs';
export const port=Number(process.env.GYRO_CAPTURE_PORT||9348);
export async function connect(){
 const pages=await(await fetch(`http://127.0.0.1:${port}/json/list`)).json();
 const page=pages.find(x=>x.type==='page'&&x.url.includes('1427'))||pages.find(x=>x.type==='page');
 if(!page)throw new Error('No capture page');
 const ws=new WebSocket(page.webSocketDebuggerUrl);let seq=0;const pending=new Map();
 ws.addEventListener('message',e=>{const m=JSON.parse(e.data);if(!m.id)return;const p=pending.get(m.id);if(p){pending.delete(m.id);m.error?p.reject(new Error(m.error.message)):p.resolve(m.result)}});
 await new Promise((resolve,reject)=>{ws.addEventListener('open',resolve,{once:true});ws.addEventListener('error',reject,{once:true})});
 const send=(method,params={})=>new Promise((resolve,reject)=>{const id=++seq;pending.set(id,{resolve,reject});ws.send(JSON.stringify({id,method,params}))});
 await send('Emulation.setDeviceMetricsOverride',{width:Number(process.env.GYRO_VIEW_WIDTH||1920),height:Number(process.env.GYRO_VIEW_HEIGHT||1080),deviceScaleFactor:Number(process.env.GYRO_DPR||1),mobile:false});
 const evalJS=async(expression)=>{const r=await send('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});if(r.exceptionDetails)throw new Error(JSON.stringify(r.exceptionDetails));return r.result.value};
 const shot=async(path)=>{const r=await send('Page.captureScreenshot',{format:path.endsWith('.png')?'png':'jpeg',quality:95,captureBeyondViewport:false});writeFileSync(path,Buffer.from(r.data,'base64'))};
 return {send,evalJS,shot,close:()=>ws.close()};
}
