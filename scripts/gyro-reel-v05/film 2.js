(() => {
 const W=1920,H=1080,root=document.getElementById('root');
 if(document.getElementById('film-stage'))return true;
 const style=document.createElement('style');style.textContent=`
 html,body{width:1920px!important;height:1080px!important;overflow:hidden!important;background:#f6f9ff!important}
 #film-stage{position:fixed;inset:0;width:1920px;height:1080px;perspective:2500px;overflow:hidden;isolation:isolate;background:radial-gradient(ellipse at 65% 62%,#e7f0ff 0%,#f5f9ff 45%,#fbfcff 85%)}
 #film-camera{position:absolute;left:0;top:0;width:1920px;height:1080px;transform-origin:960px 540px;transform-style:preserve-3d;}
 #film-window{position:absolute;inset:0;width:1920px;height:1080px;overflow:hidden;border-radius:22px;background:var(--gyro-bg,#f8fafc);box-shadow:0 1px 2px #20375110,0 28px 90px #19395f18;outline:1px solid #bccde04f;backface-visibility:hidden;}
 #film-window>#root{width:1920px;height:1080px;overflow:hidden;}
 #film-edge{position:absolute;left:0;top:0;bottom:0;width:7px;background:#4b8bda;border-radius:5px;box-shadow:0 0 22px #5999eb55;transform:rotateY(90deg);transform-origin:3.5px 50%}
 #film-brand{position:absolute;left:0;right:0;top:452px;display:flex;gap:23px;justify-content:center;align-items:center;color:#172b42;transform-origin:960px 510px;}
 #film-brand img{width:87px;height:87px}#film-brand span{font-family:var(--gyro-font-display);font-size:96px;font-weight:500;letter-spacing:-5px;line-height:1.1}
 #film-soon{position:absolute;left:0;right:0;top:617px;text-align:center;font-family:var(--gyro-font-sans);font-size:30px;letter-spacing:-.7px;color:#52739a}
 #film-sweep{position:absolute;top:493px;left:0;height:3px;width:300px;background:linear-gradient(90deg,transparent,#4489e9,transparent);border-radius:4px}
 #film-pointer{position:absolute;left:0;top:0;width:29px;height:37px;z-index:10;filter:drop-shadow(0 3px 4px #12283e33);transform-origin:4px 4px;pointer-events:none}
 #film-stage input,#film-stage textarea{caret-color:transparent!important}
 #film-stage *{scroll-behavior:auto!important}
 `;document.head.append(style);
 const stage=document.createElement('div');stage.id='film-stage';
 const camera=document.createElement('div');camera.id='film-camera';
 const win=document.createElement('div');win.id='film-window';
 root.parentNode.insertBefore(stage,root);win.append(root);camera.append(win);stage.append(camera);
 const edge=document.createElement('div');edge.id='film-edge';camera.append(edge);
 const brand=document.createElement('div');brand.id='film-brand';brand.innerHTML='<img src="/gyro-logo.png"><span>Gyro.</span>';stage.append(brand);
 // Use exact transparent brand mark supplied by driver, never redraw it.
 const soon=document.createElement('div');soon.id='film-soon';soon.textContent='Coming soon.';stage.append(soon);
 const sweep=document.createElement('div');sweep.id='film-sweep';stage.append(sweep);
 const pointer=document.createElement('div');pointer.id='film-pointer';pointer.innerHTML='<svg viewBox="0 0 29 37"><path d="M3 2L24 22 15 23 10 33z" fill="#203348" stroke="#fff" stroke-width="1.8"/></svg>';stage.append(pointer);
 const C=x=>Math.max(0,Math.min(1,x)),S=x=>{x=C(x);return x*x*x*(x*(x*6-15)+10)},L=(a,b,p)=>a+(b-a)*p;
 const anchors={composer:[1080,610],send:[1460,670],result:[1040,500],review:[1500,320],editor:[1090,280],terminal:[1170,800]};
 let keys=[];
 function setKeys(){keys=[
 [0,960,540,.48,89.82,0,0],
 [.85,960,540,.55,85,0,0],
 [1.9,960,540,.72,-9,3,0],
 [2.8,...anchors.composer,1.73,-4,1,0],
 [3.50,...anchors.composer,1.80,0,0,0],
 [3.90,anchors.result[0],240,1.75,0,0,0],
 [4.65,...anchors.result,1.75,0,0,0],
 [5.13,...anchors.result,1.75,0,0,0],
 [5.85,...anchors.review,1.72,-3,0,0],
 [6.10,...anchors.review,1.72,-3,0,0],
 [6.50,...anchors.editor,2.02,0,0,0],
 [7.55,...anchors.editor,2.02,0,0,0],
 [8.85,...anchors.terminal,1.97,0,0,0],
 [9.55,...anchors.terminal,1.97,0,0,0],
 [10.9,960,540,.70,-6,2,0],
 [11.92,960,540,.48,89.85,0,0],
 [12.22,960,540,.46,90,0,0]];}
 setKeys();
 const pose=t=>{let i=0;while(i<keys.length-2&&keys[i+1][0]<=t)i++;const a=keys[i],b=keys[i+1],p=S((t-a[0])/(b[0]-a[0]));return a.slice(1).map((v,j)=>L(v,b[j+1],p))};
 const measure=selector=>{const e=document.querySelector(selector);if(!e)return null;const old=camera.style.transform;camera.style.transform='none';const r=e.getBoundingClientRect();camera.style.transform=old;return {x:r.x,y:r.y,w:r.width,h:r.height,cx:r.x+r.width/2,cy:r.y+r.height/2}};
 window.__gyroFilm={anchors,measure,setAnchor:(name,x,y)=>{anchors[name]=[x,y];setKeys()},draw(t){
  const [fx,fy,scale,ry,rx,rz]=pose(t);const x=(960-fx)*scale,y=(540-fy)*scale;
  camera.style.transform=`translate(${x}px,${y}px) scale(${scale}) rotateY(${ry}deg) rotateX(${rx}deg) rotateZ(${rz}deg)`;
  const speed=(()=>{const prev=pose(Math.max(0,t-1/60));return Math.hypot(fx-prev[0],fy-prev[1])*scale+Math.abs(ry-prev[3])*3})();
  camera.style.filter=speed>.1?`blur(${Math.min(5,speed*.04)}px)`:'none';
  camera.style.opacity=t<11.92?'1':String(1-S((t-11.92)/.35));
  edge.style.opacity=String(C((Math.abs(ry)-65)/22));
  const bp=S((t-12.12)/.65);brand.style.opacity=String(bp);brand.style.transform=`translateY(${14*(1-bp)}px) scale(${.96+.04*bp})`;brand.style.clipPath=`inset(0 ${100*(1-bp)}% 0 0)`;
  soon.style.opacity=String(S((t-12.65)/.35));soon.style.transform=`translateY(${8*(1-S((t-12.65)/.35))}px)`;
  sweep.style.opacity=String(Math.sin(C((t-12)/.8)*Math.PI));sweep.style.transform=`translateX(${L(660,1280,S((t-12)/.8))}px)`;
  pointer.style.opacity='0';
  if(t>=3.20&&t<3.8){const p=S((t-3.2)/.35),r=anchors.send;const wx=L(r[0]+55,r[0],p),wy=L(r[1]+65,r[1],p);pointer.style.opacity=String(S((t-3.2)/.15)*(1-S((t-3.65)/.15)));pointer.style.transform=`translate(${960+(wx-fx)*scale}px,${540+(wy-fy)*scale}px) scale(${1-.15*Math.sin(C((t-3.52)/.15)*Math.PI)})`;}
  return {t,focus:[fx,fy],scale,ry};
 },identity(){camera.style.transform='none';camera.style.filter='none';camera.style.opacity='1';brand.style.opacity='0';soon.style.opacity='0';sweep.style.opacity='0';pointer.style.opacity='0';},pose};
 window.__gyroFilm.draw(0);return true;
})();
