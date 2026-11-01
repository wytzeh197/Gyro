import { chromium } from 'playwright';
import { spawn } from 'child_process';
import path from 'path';

const mode = process.argv[2] || 'boards';
const FPS = 60, DUR = 30;
const url = 'file://' + path.resolve('index.html');
const browser = await chromium.launch({ args: ['--allow-file-access-from-files', '--font-render-hinting=none'] });
const page = await browser.newPage({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 });
await page.goto(url);
await page.evaluate(() => window.filmReady);

if (mode === 'boards') {
  const times = (process.argv[3] || '0.5,1.5,2.2,2.8,3.4,4.5,5.8,6.4,7.9,9.4,10.5,11.0,12.6,14.9,17.9,19.9,20.4,22.4,23.9,24.6,25.4,28').split(',').map(Number);
  for (const t of times) {
    await page.evaluate(t => window.renderAt(t), t);
    await page.screenshot({ path: `boards/b_${String(t).padStart(5, '0')}.jpg`, type: 'jpeg', quality: 80 });
  }
} else {
  const ff = spawn('ffmpeg', ['-y', '-f', 'image2pipe', '-framerate', String(FPS), '-c:v', 'mjpeg', '-i', '-',
    '-c:v', 'libx264', '-preset', 'medium', '-crf', '16', '-pix_fmt', 'yuv420p', '-profile:v', 'high',
    '-color_primaries', 'bt709', '-color_trc', 'bt709', '-colorspace', 'bt709', '-movflags', '+faststart', 'video.mp4'], { stdio: ['pipe', 'ignore', 'inherit'] });
  const N = FPS * DUR;
  for (let f = 0; f < N; f++) {
    await page.evaluate(t => window.renderAt(t), f / FPS);
    const buf = await page.screenshot({ type: 'jpeg', quality: 97 });
    if (!ff.stdin.write(buf)) await new Promise(r => ff.stdin.once('drain', r));
    if (f % 300 === 0) console.log('frame', f);
  }
  ff.stdin.end();
  await new Promise(r => ff.on('close', r));
}
await browser.close();
