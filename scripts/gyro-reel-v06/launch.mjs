import {spawn} from 'node:child_process';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {resolve} from 'node:path';
const profile=mkdtempSync(resolve(tmpdir(),'gyro-v06-'));
const p=spawn('/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',['--headless=new','--disable-gpu','--hide-scrollbars','--force-color-profile=srgb','--autoplay-policy=no-user-gesture-required',`--user-data-dir=${profile}`,'--remote-debugging-port=9349','http://127.0.0.1:1428/capture.html?scene=chat&theme=light&reset=1&reel=1'],{stdio:'ignore'});
const done=()=>{p.kill('SIGKILL');try{rmSync(profile,{recursive:true,force:true,maxRetries:5,retryDelay:200})}catch{}process.exit(0)};
process.on('SIGTERM',done);process.on('SIGINT',done);p.on('exit',()=>process.exit(0));
console.log('Gyro v06 capture browser running on 9349, temporary profile');
