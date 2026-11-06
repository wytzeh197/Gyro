// v07: continuous curved travel, planar depth, and long deceleration tails.
// Native4× pixels are never redrawn. All sampling follows one60fps clock.
const assetRoot='../../docs/media/launch/reel-v07/';
const [timeline,manifest]=await Promise.all([fetch('./timeline.json').then(r=>r.json()),fetch(assetRoot+'capture-manifest.json').then(r=>r.json())]);
const $=id=>document.getElementById(id),C=timeline.cues;
const clamp=x=>Math.max(0,Math.min(1,x)),lerp=(a,b,p)=>a+(b-a)*p;
const ease=x=>{x=clamp(x);return x*x*(3-2*x)};
const fade=(t,a,b)=>ease((t-a)/(b-a));
const band=(t,a,b,c,d)=>fade(t,a,b)*(1-fade(t,c,d));
const P=(x,y,w,rz=0,rx=0,ry=0,z=0)=>({x,y,w,rz,rx,ry,z,o:1});
// Monotonic cubic Hermite tangents retain velocity through intermediate keys.
// Only explicit reading holds stop; there is no ease-to-zero at every waypoint.
function flow(t,keys){
 const n=keys.length;
 if(t<=keys[0][0])return {...keys[0][1]};
 if(t>=keys[n-1][0])return {...keys[n-1][1]};
 let j=1;while(keys[j][0]<t)j++;
 const i=j-1,dt=keys[j][0]-keys[i][0],u=(t-keys[i][0])/dt;
 const tangent=(k,p)=>{
  if(k===0||k===n-1||keys[k][2])return 0;
  const a=(keys[k][1][p]-keys[k-1][1][p])/(keys[k][0]-keys[k-1][0]);
  const b=(keys[k+1][1][p]-keys[k][1][p])/(keys[k+1][0]-keys[k][0]);
  if(a*b<=0)return 0;
  return Math.sign(a)*Math.min((Math.abs(a)+Math.abs(b))/2,3*Math.min(Math.abs(a),Math.abs(b)));
 };
 const h00=2*u**3-3*u*u+1,h10=u**3-2*u*u+u,h01=-2*u**3+3*u*u,h11=u**3-u*u;
 return Object.fromEntries(Object.keys(keys[i][1]).map(k=>[k,h00*keys[i][1][k]+h10*dt*tangent(i,k)+h01*keys[j][1][k]+h11*dt*tangent(j,k)]));
}
for(const im of document.querySelectorAll('img[data-asset]')){const a=manifest.assets[im.dataset.asset];im.src=assetRoot+a.path;im.style.width=a.cssRect.width+'px';}
await Promise.all([...document.images].map(im=>im.decode()));await document.fonts.ready;
const tw=$('one').getBoundingClientRect().width+$('task-word').getBoundingClientRect().width;
const oneWidth=$('one').getBoundingClientRect().width,wordWidth=$('task-text').getBoundingClientRect().width;
const openingX=(1920-tw)/2;
const tracks={
 opening:[[0,P((1920-tw*1.36)/2,352,1196.8)],[1.18,P(openingX,393,880)],[2.02,P(openingX-74,204,790)]],
 task:[[1.38,P(180,472,1560)],[2.05,P(145,502,1540,-1,0,0)],[2.85,P(52,646,1210,-5,8,9,-35)],[3.60,P(66,748,1100,-8,12,14,-60)],[4.28,P(425,647,1430,-9,8,-17,70)],[4.82,P(856,370,835,-4,3,-9,20)],[5.35,P(1031.875,256.6875,471.25)]],
 code:[[1.40,P(1840,-330,1540,-19,19,-36,180)],[2.40,P(1160,67,1100,10,10,-24,80)],[3.55,P(1060,177,810,8,-7,-16,-120)],[4.27,P(1190,305,1000,10,-12,-26,-70)],[5.10,P(790,364,783,0,0,0,-40)],[5.40,P(790,364,783)]],
 'shell-fragment':[[1.90,P(1990,1070,1370,-17,-19,-28,140)],[2.70,P(1100,885,1060,-9,-7,18,90)],[3.60,P(1015,710,830,-5,8,16,25)],[4.26,P(966,692,1180,-7,9,23,100)],[5.10,P(790,577,783,0,0,0,-40)],[5.40,P(790,577,783)]],
 places:[[1.90,P(146,202,960)],[2.60,P(140,179,900)],[3.55,P(130,158,875)],[4.30,P(104,35,810)]],
 alignment:[[3.62,P(58,738,1116,-8,12,14,-60)],[4.34,P(412,367,1490,-8,8,-20,20)],[5.35,P(615,215,1160)]],
 hero:[[4.45,P(485,270,1420,-9,9,-22,-20)],[5.00,P(568,226,1260,-4,3,-10,0)],[5.35,P(615,215,1160)]],
 meet:[[4.55,P(116,430,450)],[5.12,P(133,373,450)],[5.72,P(93,295,422)],[6.25,P(18,168,400)]],
 conversation:[[5.35,P(1021,248.2291667,493)],[5.83,P(705,61,1110)],[6.27,P(144,90,1632),true],[6.73,P(144,90,1632),true],[7.26,P(-598,-82,1570,-4,4,13,-50)],[7.79,P(-1470,-301,1360,-10,9,22,-180)]],
 review:[[6.72,P(1470,230,975,10,9,-28,60)],[7.23,P(767,73,1260,5,4,-16,30)],[7.95,P(207.4,156.6,1505.2),true],[8.53,P(207.4,156.6,1505.2),true],[9.13,P(-284,-305,1430,-7,8,-17,-80)],[9.62,P(-1310,-780,1300,-14,14,-25,-180)]],
 'shell-proof':[[8.51,P(520,1230,1290,-8,-16,19,-100)],[9.10,P(256,548,1450,-4,-7,9,-25)],[9.61,P(195,135.4,1530),true],[10.04,P(195,135.4,1530),true],[10.66,P(484,411,860,0,0,0)],[11.28,P(1040,615,333,0,0,0)],[11.86,P(1048.333333,678.75,206.25),true]],
 statement:[[10.39,P(98,443,820)],[11.20,P(124,377,800),true],[11.74,P(124,377,800),true],[12.68,P(-120,161,695,-3,0,-8,-75)]],
 brand:[[11.82,P(695,664,530,0,-12,0,-150)],[12.42,P(695,474,530,0,-4,0,-30)],[13,P(695,427,530),true]],
 soon:[[12.25,P(710,715,500)],[13,P(710,617,500),true]],
 'file-bridge':[[6.68,P(182,758.53125,360)],[7.02,P(510,517,510,-4,0,-8)],[7.42,P(718,280,510,-2,0,-4)],[7.73,P(642,270,390)]],
};
const dims={opening:[880,230],selection:null,places:[900,340],task:[780,51],code:[680,230],'shell-fragment':[750,280],alignment:null,'chat-window':[1920,1080],meet:[450,340],conversation:[816,450],review:[424,475],'file-bridge':[180,44],'workspace-window':[1920,1080],'shell-proof':[450,238],statement:[800,270],brand:[530,145],soon:[500,52]};
function pose(id,t){
 let p;
 if(id==='selection'){
  const op=flow(Math.min(t,1.27),tracks.opening),s=op.w/880;
  const begin={...op,x:op.x+(oneWidth-9)*s,y:op.y-5*s,w:(wordWidth+18)*s,h:252*s};
  const tp=flow(Math.min(t,2.05),tracks.task),end={...tp,x:tp.x-8,y:tp.y-8,w:tp.w+16,h:tp.w*51/780+16};
  const u=fade(t,1.27,2.05);p=Object.fromEntries(Object.keys(begin).map(k=>[k,lerp(begin[k],end[k]??0,u)]));p.o=band(t,.58,1.08,1.92,2.20);return p;
 }
 if(id==='chat-window'){
  p=flow(t,tracks.hero);
  if(t>=5.35){const cp=flow(t,tracks.conversation),s=cp.w/816;p={...cp,x:cp.x-672*s,y:cp.y-55*s,w:1920*s};}
  p.o=band(t,4.52,4.76,6.06,6.31);
 }else if(id==='workspace-window'){
  const sp=flow(Math.min(t,11.86),tracks['shell-proof']),s=sp.w/450;
  p={...sp,x:sp.x-280*s,y:sp.y-780*s,w:1920*s};p.o=band(t,10.04,10.64,11.85,12.68);
  if(t>11.86){const u=fade(t,11.86,12.68);p.x+=100*u;p.y-=200*u;p.w*=1-.12*u;p.ry=-14*u;p.rx=6*u;p.z=-100*u;}
 }else p=flow(t,tracks[id]);
 const opacity={opening:()=>1-fade(t,1.29,2.00),task:()=>band(t,1.44,2.00,5.16,5.42),code:()=>band(t,1.51,2.29,4.98,5.37),'shell-fragment':()=>band(t,1.95,2.66,5.01,5.39),places:()=>band(t,2.05,2.67,3.52,4.25),alignment:()=>band(t,3.62,4.08,5.29,5.70),meet:()=>band(t,4.63,5.15,5.49,6.12),conversation:()=>band(t,5.81,6.20,7.18,7.77),review:()=>band(t,6.70,6.90,9.45,9.72),'shell-proof':()=>band(t,8.51,8.77,10.28,10.66),statement:()=>band(t,10.88,11.48,11.85,12.61),brand:()=>fade(t,11.94,12.73),soon:()=>fade(t,12.34,13),'file-bridge':()=>band(t,6.69,6.86,7.40,7.74)};
 if(opacity[id])p.o=opacity[id]();
 if(id==='meet'&&t>=5.35){const cp=flow(t,tracks.conversation);p.x+=cp.x-672*(cp.w/816)-615;}
 if(id==='alignment')p.h=lerp(flow(t,tracks.task).w*51/780+16,p.w*1080/1920,fade(t,3.62,5.35));
 else p.h=p.w/dims[id][0]*(id==='review'?lerp(475,216,fade(t,6.92,7.95)):dims[id][1]);
 return p;
}
function apply(id,p,blur,t){
 const e=$(id),dim=dims[id];
 e.style.opacity=clamp(p.o);e.style.display=p.o<.00001?'none':id==='brand'?'flex':'block';
 const iw=dim?dim[0]:p.w,ih=dim?(id==='review'?lerp(475,216,fade(t,6.92,7.95)):dim[1]):p.h,s=p.w/iw;
 e.style.width=iw+'px';e.style.height=ih+'px';
 e.style.transform=`translate(${p.x+p.w/2}px,${p.y+p.h/2}px) perspective(1900px) translateZ(${p.z}px) rotateZ(${p.rz}deg) rotateY(${p.ry}deg) rotateX(${p.rx}deg) scale(${s}) translate(${-iw/2}px,${-ih/2}px)`;
 e.style.filter=blur>.08?`blur(${blur/s}px)`:'none';
 if(e.classList.contains('native')){
  e.style.borderRadius=(id==='task'?22:12)/s+'px';
  e.style.boxShadow=id==='file-bridge'?'none':`0 ${42/s}px ${94/s}px ${-35/s}px #234d843c,0 0 0 ${1/s}px #9cb4d42b`;
 }
 if(id==='task')e.style.outline=`${2/s}px solid rgba(55,124,224,${.70*band(t,1.77,2.16,4.94,5.39)})`;
 if(id==='chat-window')e.style.clipPath=`inset(0 ${100*(1-fade(t,4.53,5.28))}% 0 0)`;
 if(id==='review')e.querySelector('img').style.transform=`translateY(${-263*fade(t,6.92,7.95)}px)`;
 if(id==='statement'){const wall=pose('workspace-window',t),space=Math.max(0,wall.x-32-p.x);e.style.clipPath=`inset(0 ${100*clamp(1-space/p.w)}% 0 0)`;}
 if(id==='conversation')e.style.clipPath=`inset(0 ${100*fade(t,6.97,7.75)}% ${25.72*fade(t,6.70,6.86)}% 0)`;
}
window.renderFrame=frame=>{
 const t=Math.min(C.hold,Math.max(0,frame/timeline.fps));const state={frame,t,layers:{}};
 for(const id of Object.keys(dims)){
  const p=pose(id,t),focal=id==='workspace-window'?'shell-proof':id==='chat-window'&&t>=5.35?'conversation':id;
  const now=pose(focal,t),prev=pose(focal,Math.max(0,t-1/120));
  const speed=Math.hypot(now.x-prev.x,now.y-prev.y)+Math.abs(now.w-prev.w)*.24+Math.abs(now.ry-prev.ry)*8;
  const blur=Math.min(5,Math.max(0,speed-4)*.115);
  apply(id,p,blur,t);state.layers[id]={...p,blur};
 }
 const taskAlpha=fade(t,.24,.93);$('task-word').style.opacity=taskAlpha;$('task-word').style.transform=`translateX(${48*(1-taskAlpha)}px)`;
 $('one').style.opacity=1;$('one').style.transform='none';
 $('selection').style.background=t<1.76?'#c5dcfc':'transparent';
 const cp=pose('conversation',t),s=cp.w/816,click=manifest.reviewClick.withinConversation;
 $('cursor').style.opacity=band(t,6.37,6.59,6.75,6.88);$('cursor').style.transform=`translate(${cp.x+click.x*s}px,${cp.y+click.y*s}px) scale(${t>=C.reviewClick&&t<C.reviewClick+.10?.9:1})`;
 const light=fade(t,1,5.35)*(1-fade(t,11.3,13));
 $('stage').style.background=`radial-gradient(ellipse at ${65-23*light}% ${76-19*light}%,#e3eefc 0%,#f2f7fd 49%,#f8faff 100%)`;
 window.__frameState=state;return state;
};
const fit=()=>{$('stage').style.transform=`scale(${Math.min(innerWidth/1920,innerHeight/1080)})`;};fit();addEventListener('resize',fit);
window.renderFrame(0);window.__filmReady=true;
if(new URLSearchParams(location.search).has('play')){
 const audio=new Audio(assetRoot+'score-final.wav');let start;
 const tick=now=>{start??=now;const f=Math.min(899,Math.floor((now-start)*.06));window.renderFrame(f);if(f<899)requestAnimationFrame(tick)};
 audio.play().catch(()=>{});requestAnimationFrame(tick);
}
