import {execFileSync} from 'node:child_process';
import {readFileSync,writeFileSync,existsSync} from 'node:fs';
const mode=process.argv[2]||'final';
const t=JSON.parse(readFileSync(new URL('./timeline.json',import.meta.url)));
const out='docs/media/launch/reel-v07';
const animatic=mode==='animatic';
const target=`${out}/gyro-launch-16x9-15s-en-v07${animatic?'-animatic':''}.mp4`;
const run=args=>execFileSync('ffmpeg',['-y','-hide_banner','-loglevel','warning',...args],{stdio:'inherit'});
const color=['-color_primaries','bt709','-color_trc','bt709','-colorspace','bt709'];
const soundtrack=`${out}/score-final.wav`;
if(!existsSync(soundtrack))throw Error('Run finish-audio.mjs first.');
if(animatic){
 run(['-framerate','15','-i','/tmp/gyro-v07-animatic-frames/%05d.jpg','-i',soundtrack,'-vf','scale=1280:720:flags=lanczos,format=yuv420p','-r','30','-c:v','libx264','-crf','19','-preset','fast',...color,'-c:a','aac','-aac_coder','fast','-b:a','256k','-ar','48000','-ac','2','-t',String(t.duration),'-movflags','+faststart',target]);
}else{
 const moving='/tmp/gyro-v07-moving.mp4',hold='/tmp/gyro-v07-closing.mp4';
 const vf=`scale=${t.width}:${t.height}:flags=lanczos,format=yuv420p`;
 run(['-framerate',String(t.fps),'-i','/tmp/gyro-v07-final-frames/%05d.jpg','-frames:v','780','-vf',vf,'-c:v','libx264','-crf','16','-preset','medium',...color,moving]);
 // Isolate the exact closing still from lookahead-dependent rate control.
 // Constant QP and intra frames make all120 decoded pictures pixel-identical.
 run(['-framerate',String(t.fps),'-start_number','780','-i','/tmp/gyro-v07-final-frames/%05d.jpg','-frames:v','120','-vf',vf,'-c:v','libx264','-qp','18','-preset','medium','-g','1','-bf','0','-x264-params','aq-mode=0:mbtree=0',...color,hold]);
 const list='/tmp/gyro-v07-concat.txt';writeFileSync(list,`file '${moving}'\nfile '${hold}'\n`);
 run(['-f','concat','-safe','0','-i',list,'-i',soundtrack,'-map','0:v:0','-map','1:a:0','-c:v','copy','-c:a','aac','-aac_coder','fast','-b:a','256k','-ar','48000','-ac','2','-t',String(t.duration),'-movflags','+faststart',target]);
}
console.log(target);
