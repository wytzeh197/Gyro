#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")/../.."
output_dir="docs/media/launch/reel-v05"
ffmpeg -hide_banner -y -framerate 60 -start_number 0 -i "$output_dir/frames/%04d.jpg" \
  -i "$output_dir/score.wav" -t 15 \
  -vf scale=1920:1080:flags=lanczos -c:v libx264 -preset slow -crf 16 -pix_fmt yuv420p \
  -colorspace bt709 -color_primaries bt709 -color_trc bt709 \
  -af 'loudnorm=I=-15:TP=-1.5:LRA=9:measured_I=-19.22:measured_TP=-3.10:measured_LRA=2.90:measured_thresh=-29.63:offset=-0.33:linear=false' \
  -ar 48000 -ac 2 -c:a aac -b:a 256k -movflags +faststart \
  "$output_dir/gyro-launch-16x9-15s-en-v05.mp4"
