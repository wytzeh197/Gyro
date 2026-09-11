#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUTPUT_DIR="$ROOT_DIR/docs/media/launch"
FILM="$OUTPUT_DIR/gyro-launch-film.mp4"
POSTER="$OUTPUT_DIR/gyro-launch-poster.png"
CAPTURE="$ROOT_DIR/scripts/launch-teaser/capture.mjs"

if ! command -v ffmpeg >/dev/null 2>&1; then
  echo "ffmpeg is required to render the launch teaser." >&2
  exit 1
fi

if ! command -v node >/dev/null 2>&1; then
  echo "node is required to capture launch teaser plates." >&2
  exit 1
fi

WORK_DIR="$(mktemp -d "${TMPDIR:-/tmp}/gyro-launch-teaser.XXXXXX")"
cleanup() {
  rm -rf "$WORK_DIR"
}
trap cleanup EXIT

echo "Capturing teaser plates into $WORK_DIR"
node "$CAPTURE" "$WORK_DIR"

for scene in logo chat cli workspace together agents end; do
  if [[ ! -f "$WORK_DIR/$scene.png" ]]; then
    echo "Missing captured plate: $WORK_DIR/$scene.png" >&2
    exit 1
  fi
done

mkdir -p "$OUTPUT_DIR"

# Each still is a 3840x2160 capture of a 1920x1080 compositor plate. Scale a
# little larger than 1080p, then crop with a slow pan so the UI stays sharp
# instead of being re-drawn by a generative video model.
ffmpeg -hide_banner -loglevel warning -y \
  -loop 1 -framerate 30 -t 2.6 -i "$WORK_DIR/logo.png" \
  -loop 1 -framerate 30 -t 3.3 -i "$WORK_DIR/chat.png" \
  -loop 1 -framerate 30 -t 3.3 -i "$WORK_DIR/cli.png" \
  -loop 1 -framerate 30 -t 3.3 -i "$WORK_DIR/workspace.png" \
  -loop 1 -framerate 30 -t 3.2 -i "$WORK_DIR/together.png" \
  -loop 1 -framerate 30 -t 3.3 -i "$WORK_DIR/agents.png" \
  -loop 1 -framerate 30 -t 4.5 -i "$WORK_DIR/end.png" \
  -f lavfi -i "sine=frequency=46:sample_rate=48000:duration=22" \
  -f lavfi -i "anoisesrc=color=pink:amplitude=0.045:sample_rate=48000:duration=22" \
  -f lavfi -i "anoisesrc=color=white:amplitude=0.32:sample_rate=48000:duration=0.9" \
  -f lavfi -i "sine=frequency=68:sample_rate=48000:duration=0.75" \
  -filter_complex "
    [0:v]scale=1984:1116,
      crop=1920:1080:x='32+6*sin(t*0.5)':y='18+4*cos(t*0.35)',
      trim=duration=2.6,setpts=PTS-STARTPTS,
      fps=30,settb=AVTB,setsar=1[logo];
    [1:v]scale=1968:1107,
      crop=1920:1080:x='4+12*t':y='0',
      trim=duration=3.3,setpts=PTS-STARTPTS,
      fps=30,settb=AVTB,setsar=1[chat];
    [2:v]scale=1968:1107,
      crop=1920:1080:x='40-10*t':y='0',
      trim=duration=3.3,setpts=PTS-STARTPTS,
      fps=30,settb=AVTB,setsar=1[cli];
    [3:v]scale=1968:1107,
      crop=1920:1080:x='6+10*t':y='0',
      trim=duration=3.3,setpts=PTS-STARTPTS,
      fps=30,settb=AVTB,setsar=1[workspace];
    [4:v]scale=1968:1107,
      crop=1920:1080:x='8+11*t':y='0',
      trim=duration=3.2,setpts=PTS-STARTPTS,
      fps=30,settb=AVTB,setsar=1[together];
    [5:v]scale=1984:1116,
      crop=1920:1080:x='32+8*sin(t*0.4)':y='18+3*cos(t*0.3)',
      trim=duration=3.3,setpts=PTS-STARTPTS,
      fps=30,settb=AVTB,setsar=1[agents];
    [6:v]scale=1984:1116,
      crop=1920:1080:x='32+5*sin(t*0.32)':y='18+3*cos(t*0.28)',
      trim=duration=4.5,setpts=PTS-STARTPTS,
      fps=30,settb=AVTB,setsar=1[end];

    [logo][chat]xfade=transition=fade:duration=0.25:offset=2.35[ab];
    [ab][cli]xfade=transition=fade:duration=0.25:offset=5.40[abc];
    [abc][workspace]xfade=transition=fade:duration=0.25:offset=8.45[abcd];
    [abcd][together]xfade=transition=fade:duration=0.25:offset=11.50[abcde];
    [abcde][agents]xfade=transition=fade:duration=0.25:offset=14.45[abcdef];
    [abcdef][end]xfade=transition=fade:duration=0.25:offset=17.50,
      unsharp=5:5:0.35:3:3:0,
      scale=1920:1080:in_range=full:out_range=tv,
      format=yuv420p,
      setparams=range=limited:color_primaries=bt709:color_trc=bt709:colorspace=bt709[vout];

    [7:a]volume=0.055,afade=t=in:d=1.2,afade=t=out:st=20.5:d=1.5[rumble];
    [8:a]highpass=f=110,lowpass=f=2600,volume=0.18,
      afade=t=in:d=1.0,afade=t=out:st=20.8:d=1.2[air];
    [9:a]highpass=f=420,lowpass=f=7600,
      afade=t=in:d=0.42,afade=t=out:st=0.42:d=0.48,
      volume=0.16,asplit=6[w1][w2][w3][w4][w5][w6];
    [w1]adelay=2100[wd1];
    [w2]adelay=5150[wd2];
    [w3]adelay=8200[wd3];
    [w4]adelay=11250[wd4];
    [w5]adelay=14200[wd5];
    [w6]adelay=17250[wd6];
    [10:a]volume=0.18,afade=t=out:st=0:d=0.75,asplit=6[h1][h2][h3][h4][h5][h6];
    [h1]adelay=2300[hd1];
    [h2]adelay=5350[hd2];
    [h3]adelay=8400[hd3];
    [h4]adelay=11450[hd4];
    [h5]adelay=14400[hd5];
    [h6]adelay=17450[hd6];
    [rumble][air][wd1][wd2][wd3][wd4][wd5][wd6]
      [hd1][hd2][hd3][hd4][hd5][hd6]
      amix=inputs=14:duration=longest:normalize=0,
      volume=8,
      alimiter=limit=0.92,
      aformat=channel_layouts=stereo[aout]
  " \
  -map "[vout]" \
  -map "[aout]" \
  -c:v libx264 \
  -profile:v high \
  -level 4.1 \
  -preset slow \
  -crf 18 \
  -pix_fmt yuv420p \
  -colorspace bt709 \
  -color_primaries bt709 \
  -color_trc bt709 \
  -c:a aac \
  -b:a 192k \
  -ar 48000 \
  -movflags +faststart \
  -t 22 \
  "$FILM"

ffmpeg -hide_banner -loglevel warning -y \
  -ss 20 \
  -i "$FILM" \
  -frames:v 1 \
  -update 1 \
  "$POSTER"

echo "Rendered $FILM"
echo "Rendered $POSTER"
echo "SHA-256:"
shasum -a 256 "$FILM" "$POSTER"
