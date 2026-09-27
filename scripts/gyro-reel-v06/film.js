// All motion is a pure function of the exported 60 fps frame index.
// Images are native 4× captures; only their outer editorial transforms change.
const assetRoot='../../docs/media/launch/reel-v06/';
const [timeline,manifest]=await Promise.all([fetch('./timeline.json').then(r=>r.json()),fetch(assetRoot+'capture-manifest.json').then(r=>r.json())]);
const $=id=>document.getElementById(id), clamp=x=>Math.min(1,Math.max(0,x));
const smooth=x=>{x=clamp(x);return x*x*x*(x*(x*6-15)+10)};
const out=x=>1-Math.pow(1-clamp(x),4);
const lerp=(a,b,p)=>a+(b-a)*p;
const fade=(t,a,b)=>smooth((t-a)/(b-a));
const between=(t,a,b,c,d)=>fade(t,a,b)*(1-fade(t,c,d));
const pose=(x,y,w,h,o=1,r=0)=>({x,y,w,h,o,r});
const mix=(a,b,p)=>Object.fromEntries(Object.keys(a).map(k=>[k,lerp(a[k],b[k],p)]));
// Segment easing inherits a zero velocity at every reading hold.
function track(t,keys){
 if(t<=keys[0][0])return keys[0][1];
 for(let i=1;i<keys.length;i++)if(t<keys[i][0]){
  const [ta,a]=keys[i-1],[tb,b,ease='smooth']=keys[i];
  return mix(a,b,(ease==='out'?out:smooth)((t-ta)/(tb-ta)));
 }
 return keys.at(-1)[1];
}
for(const el of document.querySelectorAll('img[data-asset]')){const a=manifest.assets[el.dataset.asset];el.src=assetRoot+a.path;el.style.width=a.cssRect.width+'px';}
await Promise.all([...document.images].map(im=>im.decode()));
await document.fonts.ready;

const tracks={
 'opening':[[0,pose(520,424,880,230)],[1.03,pose(520,424,880,230)],[1.55,pose(460,248,880,230,0)]],
 'selection':[[0,pose(939,410,470,211,0)],[.64,pose(939,410,470,211,0)],[.82,pose(939,410,470,211,.94)],[1.02,pose(939,410,470,211,.94)],[1.48,pose(178,449,1564,106,.84)],[1.65,pose(178,449,1564,106,0)]],
 'task':[[0,pose(180,451,1560,102,0)],[1.23,pose(180,451,1560,102,0)],[1.60,pose(180,451,1560,102)],[1.78,pose(180,451,1560,102)],[2.50,pose(124,660,1000,65.38,1,-3)],[3.15,pose(108,663,1000,65.38,1,-3)],[3.90,pose(62,677,1000,65.38,1,-4)],[4.05,pose(62,677,1000,65.38,1,-4)],[4.70,pose(1026,286,434.7,28.4,1,0)],[4.92,pose(1045.3,282.38,430.6,28.15,0,0)]],
 'code':[[0,pose(1540,-140,700,236.76,0,8)],[1.39,pose(1540,-140,700,236.76,0,8)],[2.26,pose(1120,177,700,236.76,1,4)],[2.8,pose(1120,177,700,236.76,1,4)],[3.9,pose(1134,101,700,236.76,1,5)],[4.05,pose(1134,101,700,236.76,1,5)],[4.68,pose(875,360,746,252.35,.8,0)],[4.92,pose(875,360,746,252.35,0,0)]],
 'shell-fragment':[[0,pose(1850,780,795,296.8,0,-8)],[1.64,pose(1850,780,795,296.8,0,-8)],[2.48,pose(1070,638,795,296.8,1,3)],[2.8,pose(1070,638,795,296.8,1,3)],[3.9,pose(1110,688,755,281.87,1,5)],[4.05,pose(1110,688,755,281.87,1,5)],[4.70,pose(872,598,748,279.25,.8,0)],[4.92,pose(872,598,748,279.25,0,0)]],
 'places':[[0,pose(134,200,900,340,0)],[2.10,pose(134,245,900,340,0)],[2.52,pose(134,200,900,340,1)],[3.7,pose(134,200,900,340,1)],[4.30,pose(134,151,900,340,0)]],
 'alignment':[[0,pose(55,648,1020,95,0,-4)],[3.86,pose(55,648,1020,95,0,-4)],[4.08,pose(55,648,1020,95,.85,-4)],[4.82,pose(656,244,1060,596.25,.9)],[5.13,pose(656,244,1060,596.25,0)]],
 'chat-window':[[0,pose(672,252,1040,585,0)],[4.57,pose(672,252,1040,585,0)],[4.98,pose(664,244,1060,596.25,1)],[5.80,pose(664,244,1060,596.25,1)],[6.35,pose(-1200,-20,3840,2160,0)]],
 'meet':[[0,pose(133,373,450,340,0)],[4.98,pose(133,420,450,340,0)],[5.32,pose(133,373,450,340,1)],[5.82,pose(133,373,450,340,1)],[6.19,pose(68,270,450,340,0)]],
 'conversation':[[0,pose(1035,274,450.5,248.45,0)],[5.86,pose(1035,274,450.5,248.45,0)],[6.38,pose(144,90,1632,900,1)],[7.12,pose(144,90,1632,900,1)],[7.67,pose(-196,36,1632,900,0)]],
 'review':[[0,pose(144,514,890.4,997.5,0)],[7.20,pose(144,514,890.4,997.5,0)],[7.63,pose(514.8,42,890.4,997.5,1)],[7.69,pose(514.8,42,890.4,997.5,1)],[8.02,pose(207.4,156.6,1505.2,766.8,1)],[8.96,pose(207.4,156.6,1505.2,766.8,1)],[9.52,pose(207.4,-646,1505.2,766.8,0)]],
 'shell-proof':[[0,pose(195,966,1530,809.2,0)],[9.02,pose(195,966,1530,809.2,0)],[9.56,pose(195,135.4,1530,809.2,1)],[10.05,pose(195,135.4,1530,809.2,1)],[10.82,pose(1048.333333,678.75,206.25,109.083333,1)],[11.02,pose(1048.333333,678.75,206.25,109.083333,0)]],
 'workspace-window':[[0,pose(-415.5,-1394,4032,2268,0)],[10.05,pose(-415.5,-1394,4032,2268,0)],[10.27,pose(-335,-1080,3470,1951.88,.34)],[10.78,pose(785.4,216.9,1142.4,642.6,1)],[11.10,pose(920,321.25,880,495,1)],[12.00,pose(920,321.25,880,495,1)],[12.55,pose(976,158,792,445.5,0)]],
 'statement':[[0,pose(124,377,800,270,0)],[10.83,pose(124,419,800,270,0)],[11.18,pose(124,377,800,270,1)],[12.00,pose(124,377,800,270,1)],[12.47,pose(124,230,800,270,0)]],
 'brand':[[0,pose(695,462,530,145,0)],[12.25,pose(695,492,530,145,0)],[12.76,pose(695,427,530,145,1)]],
 'file-bridge':[[0,pose(182,758.53125,360,88,0)],[7.13,pose(182,758.53125,360,88,0)],[7.20,pose(182,758.53125,360,88,1)],[7.49,pose(560,279,576,140.8,1)],[7.65,pose(572,294,378,92.4,0)]],
 'soon':[[0,pose(710,639,500,52,0)],[12.58,pose(710,639,500,52,0)],[13.00,pose(710,617,500,52,1)]],
};
const intrinsic={opening:[880,230],selection:null,places:[900,340],task:[780,51],code:[680,230],'shell-fragment':[750,280],alignment:null,'chat-window':[1920,1080],meet:[450,340],conversation:[816,450],review:[424,475],'file-bridge':[180,44],'workspace-window':[1920,1080],'shell-proof':[450,238],statement:[800,270],brand:[530,145],soon:[500,52]};
// Fit the opening to the actual native font metrics, including its word-space.
const openingWidth=$('one').getBoundingClientRect().width+$('task-word').getBoundingClientRect().width;
const openingX=(1920-openingWidth)/2;
const taskX=openingX+$('one').getBoundingClientRect().width;
const taskWidth=$('task-text').getBoundingClientRect().width;
tracks.opening=[[0,pose(openingX,393,880,230)],[1.03,pose(openingX,393,880,230)],[1.55,pose(openingX-60,217,880,230,0)]];
tracks.selection=[[0,pose(taskX-9,388,taskWidth+18,252,0)],[.64,pose(taskX-9,388,taskWidth+18,252,0)],[.82,pose(taskX-9,388,taskWidth+18,252,.94)],[1.02,pose(taskX-9,388,taskWidth+18,252,.94)],[1.48,pose(172,443,1576,118,.84)]];
function apply(id,p,blur=0){
 const e=$(id),dim=intrinsic[id];
 e.style.opacity=p.o;
 e.style.display=p.o<.00001?'none':'block';
 if(id==='brand')e.style.display=p.o<.00001?'none':'flex';
 if(dim){e.style.width=dim[0]+'px';e.style.height=dim[1]+'px';e.style.transform=`translate3d(${p.x}px,${p.y}px,0) rotate(${p.r}deg) scale(${p.w/dim[0]},${p.h/dim[1]})`;}
 else{e.style.width=p.w+'px';e.style.height=p.h+'px';e.style.transform=`translate3d(${p.x}px,${p.y}px,0) rotate(${p.r}deg)`;}
 e.style.filter=blur>.1?`blur(${blur}px)`:'none';
 if(id==='file-bridge'){e.style.boxShadow='none';e.style.borderRadius='0';}
 else if(dim&&e.classList.contains('native')){
  const s=p.w/dim[0];e.style.borderRadius=(id==='task'?22:12)/s+'px';
  e.style.boxShadow=`0 ${32/s}px ${74/s}px ${-34/s}px #234d843e,0 0 0 ${1/s}px #9cb4d42b`;
 }
}
function resolvedPose(id,t){
 let p=track(t,tracks[id]);
 if(id==='selection'&&t>=1.48){
  const task=track(t,tracks.task);p={...task,x:task.x-8,y:task.y-8,w:task.w+16,h:task.h+16,o:.64*(1-fade(t,3.92,4.12))};
 }
 if(['task','code','shell-fragment'].includes(id)&&t>=4.05)p={...p,o:1-fade(t,4.90,4.933333333)};
 if(id==='chat-window'&&t<=5.80)p={...p,o:fade(t,4.90,4.933333333)};
 if(id==='chat-window'&&t>=5.80&&t<6.38){
  const cp=track(t,tracks.conversation),s=cp.w/816;
  p={...p,x:cp.x-672*s,y:cp.y-55*s,w:1920*s,h:1080*s};
 }
 if(id==='conversation'&&t>=7.12)p={...p,o:t<7.41?1:0};
 if(id==='review'&&t>=7.20&&t<7.63)p={...p,o:fade(t,7.38,7.46)};
 if(id==='review'){
  const push=fade(t,7.69,8.02),h=p.w/424*lerp(475,216,push);
  p={...p,h};if(t>=7.69&&t<=8.02)p.y=lerp(540.75,540,push)-h/2;
 }
 if(id==='workspace-window'&&t>=10.05&&t<12){
  const sp=track(t,tracks['shell-proof']),s=sp.w/450;
  p={...p,x:sp.x-280*s,y:sp.y-780*s,w:1920*s,h:1080*s,o:fade(t,10.08,10.49)};
 }
 return p;
}
window.renderFrame=frame=>{
 const t=Math.min(13,Math.max(0,frame/timeline.fps)); // exactly still frames780–899
 const state={frame,t,layers:{}};
 for(const id of Object.keys(tracks)){
  const p=resolvedPose(id,t),prev=resolvedPose(id,Math.max(0,t-1/120));
  if(id==='selection')$('selection').style.background=t>=1.48?'transparent':'#c5dcfc';
  if(id==='conversation')$('conversation').style.clipPath=`inset(0 ${100*fade(t,7.20,7.41)}% ${25.72*fade(t,7.14,7.20)}% 0)`;
  if(id==='review'){
   const push=fade(t,7.69,8.02);intrinsic.review[1]=lerp(475,216,push);
   $('review').querySelector('img').style.transform=`translateY(${-263*push}px)`;
  }
  const speed=Math.hypot(p.x-prev.x,p.y-prev.y)+(Math.abs(p.w-prev.w)*.24);
  const blur=Math.min(3.5,Math.max(0,speed-6)*.065);
  apply(id,p,blur);state.layers[id]={...p,blur};
 }
 const one=out(t/.19);$('one').style.opacity=1;$('one').style.transform=`translateY(${(1-one)*13}px)`;
 const task=out((t-timeline.cues.task)/.22);$('task-word').style.opacity=task;$('task-word').style.transform=`translateY(${(1-task)*24}px)`;
 const click=manifest.reviewClick.withinConversation;
 const cp=track(t,tracks.conversation),s=cp.w/816;
 const cursorFade=between(t,6.94,7.08,7.18,7.24);
 $('cursor').style.opacity=cursorFade;$('cursor').style.transform=`translate(${cp.x+click.x*s}px,${cp.y+click.y*s}px) scale(${t>7.13&&t<7.20?.85:1})`;
 window.__frameState=state;return state;
};
const fit=()=>{$('stage').style.transform=`scale(${Math.min(innerWidth/1920,innerHeight/1080)})`;};fit();addEventListener('resize',fit);
window.renderFrame(0);window.__filmReady=true;
// Standalone editable preview: ?play=1 autoplays with the exact same frame clock.
if(new URLSearchParams(location.search).has('play')){
 const audio=new Audio(assetRoot+'score-final.wav');let start;
 const tick=now=>{start??=now;const frame=Math.min(899,Math.floor((now-start)*.06));window.renderFrame(frame);if(frame<899)requestAnimationFrame(tick)};
 audio.play().catch(()=>{});requestAnimationFrame(tick);
}
