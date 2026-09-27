/** Reproducible v06 PCM mastering and decoded AAC validation.
 *
 * Native FFmpeg AAC's default twoloop coder produced a first-packet overshoot
 * on this exact transient-led score. The verified delivery uses aac_coder fast.
 * Keep the final MP4 audio settings identical to AAC_ARGS below.
 */
import {execFileSync, spawnSync} from 'node:child_process';
import {mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

const root = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const out = join(root, 'docs/media/launch/reel-v06');
const source = join(out, 'score.wav');
const mastered = join(out, 'score-final.wav');
const timeline = JSON.parse(readFileSync(new URL('./timeline.json', import.meta.url)));
const duration = Number(timeline.duration);
const temp = mkdtempSync(join(tmpdir(), 'gyro-v06-audio-'));

export const MASTER_FILTER = [
  'aresample=192000',
  'volume=4.4dB',
  'alimiter=limit=0.76:attack=5:release=60:level=false:latency=true',
  'aresample=48000',
  `atrim=start=0:end=${duration}`,
  'afade=t=in:st=0:d=0.001',
  `afade=t=out:st=${duration - .01}:d=0.01`,
].join(',');
export const AAC_ARGS = ['-c:a', 'aac', '-aac_coder', 'fast', '-b:a', '256k', '-ar', '48000', '-ac', '2'];

function run(args) {
  return execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args], {encoding: 'utf8'});
}
function probe(file) {
  const result = execFileSync('ffprobe', [
    '-v', 'error', '-select_streams', 'a:0', '-show_entries',
    'stream=codec_name,sample_fmt,sample_rate,channels,duration,duration_ts,time_base',
    '-of', 'json', file,
  ], {encoding: 'utf8'});
  return JSON.parse(result).streams[0];
}
function measure(file, label) {
  const result = spawnSync('ffmpeg', [
    '-hide_banner', '-i', file, '-af', 'ebur128=peak=true:framelog=verbose', '-f', 'null', '-',
  ], {encoding: 'utf8'});
  const log = `${result.stdout || ''}${result.stderr || ''}`;
  writeFileSync(join(out, `audio-final-check-${label}.log`), log);
  if (result.status !== 0) throw new Error(`FFmpeg ${label} measurement failed`);
  const loudness = Number(log.match(/\bI:\s*([-\d.]+) LUFS/)?.[1]);
  const truePeak = Number(log.match(/\bPeak:\s*([-\d.]+) dBFS/)?.[1]);
  if (!Number.isFinite(loudness) || !Number.isFinite(truePeak)) throw new Error(`Missing ${label} measurement`);
  if (loudness < -15.6 || loudness > -14.4) throw new Error(`${label} loudness out of range: ${loudness}`);
  if (truePeak > -1.5) throw new Error(`${label} true peak above ceiling: ${truePeak}`);
  return {integratedLUFS: loudness, truePeakDBTP: truePeak, ...probe(file)};
}

try {
  run(['-i', source, '-af', MASTER_FILTER, '-ac', '2', '-c:a', 'pcm_s24le', mastered]);
  const pcm = measure(mastered, 'pcm');
  if (Number(pcm.sample_rate) !== 48000 || pcm.channels !== 2 || Number(pcm.duration_ts) !== 720000) {
    throw new Error(`Unexpected mastered PCM format: ${JSON.stringify(pcm)}`);
  }
  const aacFile = join(temp, 'validation.m4a');
  run(['-i', mastered, ...AAC_ARGS, '-t', String(duration), aacFile]);
  const aac = measure(aacFile, 'aac');
  if (Number(aac.sample_rate) !== 48000 || aac.channels !== 2 || Number(aac.duration) !== duration) {
    throw new Error(`Unexpected encoded AAC format: ${JSON.stringify(aac)}`);
  }
  const report = {source, mastered, filter: MASTER_FILTER, aacArgs: AAC_ARGS, pcm, decodedAAC: aac,
    subjectiveListening: 'Not performed; no tool-supported headphone audition.'};
  writeFileSync(join(out, 'audio-final-check.log'), `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify(report, null, 2));
} finally {
  rmSync(temp, {recursive: true, force: true});
}
