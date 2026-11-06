#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../.."
OUT=docs/media/launch/reel-v02
ffmpeg -hide_banner -loglevel warning -y -framerate 60 -i "$OUT/frames/%04d.jpg" -i "$OUT/score.wav" -af 'loudnorm=I=-15:TP=-1.5:LRA=9:measured_I=-19.78:measured_TP=-4.14:measured_LRA=5.20:measured_thresh=-29.97:offset=0.29:linear=false' -vf 'scale=1920:1080:in_range=full:out_range=tv,format=yuv420p' -c:v libx264 -preset slow -crf 16 -profile:v high -color_primaries bt709 -color_trc bt709 -colorspace bt709 -c:a aac -b:a 256k -ar 48000 -t 15 -movflags +faststart "$OUT/gyro-launch-16x9-15s-en-v02.mp4"
ffmpeg -hide_banner -loglevel error -y -ss 13.5 -i "$OUT/gyro-launch-16x9-15s-en-v02.mp4" -frames:v 1 "$OUT/gyro-launch-poster-v02.jpg"
ffmpeg -hide_banner -loglevel error -y -i "$OUT/gyro-launch-16x9-15s-en-v02.mp4" -vf 'fps=1,scale=480:270,tile=5x3' -frames:v 1 "$OUT/contact-sheet.jpg"
