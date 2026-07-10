#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUTPUT_DIR="$ROOT_DIR/docs/media/launch"
PLATE_DIR="$OUTPUT_DIR/plates"
FILM="$OUTPUT_DIR/gyro-launch-film.mp4"
POSTER="$OUTPUT_DIR/gyro-launch-poster.png"
LOGO="$ROOT_DIR/packages/ui/src/assets/gyro-logo-mark.png"
FONT_REGULAR="/System/Library/Fonts/Supplemental/Arial.ttf"
FONT_BOLD="/System/Library/Fonts/Supplemental/Arial Bold.ttf"

if ! command -v ffmpeg >/dev/null 2>&1; then
  echo "ffmpeg is required to render the launch teaser." >&2
  exit 1
fi

for asset in \
  "$PLATE_DIR/gyro-particles.jpg" \
  "$PLATE_DIR/gyro-core.jpg" \
  "$PLATE_DIR/gyro-surfaces.jpg" \
  "$LOGO" \
  "$FONT_REGULAR" \
  "$FONT_BOLD"; do
  if [[ ! -f "$asset" ]]; then
    echo "Missing render asset: $asset" >&2
    exit 1
  fi
done

mkdir -p "$OUTPUT_DIR"

ffmpeg -hide_banner -loglevel warning -y \
  -loop 1 -framerate 30 -t 22 -i "$PLATE_DIR/gyro-particles.jpg" \
  -loop 1 -framerate 30 -t 22 -i "$PLATE_DIR/gyro-core.jpg" \
  -loop 1 -framerate 30 -t 22 -i "$PLATE_DIR/gyro-surfaces.jpg" \
  -loop 1 -framerate 30 -t 22 -i "$LOGO" \
  -f lavfi -i "sine=frequency=46:sample_rate=48000:duration=22" \
  -f lavfi -i "anoisesrc=color=pink:amplitude=0.045:sample_rate=48000:duration=22" \
  -f lavfi -i "anoisesrc=color=white:amplitude=0.32:sample_rate=48000:duration=0.9" \
  -f lavfi -i "sine=frequency=68:sample_rate=48000:duration=0.75" \
  -filter_complex "
    [0:v]scale=2304:1296,
      crop=1920:1080:x='210+90*sin(t*0.55)':y='108+36*cos(t*0.35)',
      trim=duration=3.0,setpts=PTS-STARTPTS,
      eq=contrast=1.06:saturation=0.82,
      vignette=PI/5,
      drawtext=fontfile='$FONT_REGULAR':text='AI CODING, IN THREE FORMS.':
        fontsize=28:fontcolor=0x4a4640:x=170:y=176:
        alpha='if(lt(t,0.35),0,if(lt(t,0.85),(t-0.35)/0.5,if(gt(t,2.55),(3.0-t)/0.45,1)))',
      drawtext=fontfile='$FONT_BOLD':text='CHAT.  CLI.  FULL IDE.':
        fontsize=82:fontcolor=0x0a0a0c:x=170:y=226:
        alpha='if(lt(t,0.55),0,if(lt(t,1.05),(t-0.55)/0.5,if(gt(t,2.55),(3.0-t)/0.45,1)))',
      fps=30,settb=AVTB,setsar=1[scene-a];

    [1:v]split=3[core-b][core-f][core-g];
    [core-b]scale=2304:1296,
      crop=1920:1080:x='80+55*t':y='118-10*t',
      trim=duration=3.4,setpts=PTS-STARTPTS,
      eq=contrast=1.12:brightness=-0.07:saturation=0.9,
      vignette=PI/4,
      drawtext=fontfile='$FONT_REGULAR':text='ONE SHARED CORE':
        fontsize=27:fontcolor=0xff5a36:x=166:y=692:
        alpha='if(lt(t,0.35),0,if(lt(t,0.8),(t-0.35)/0.45,if(gt(t,2.95),(3.4-t)/0.45,1)))',
      drawtext=fontfile='$FONT_BOLD':text='BUILT TO MOVE AS ONE.':
        fontsize=74:fontcolor=0xf2eee6:x=166:y=744:
        alpha='if(lt(t,0.5),0,if(lt(t,0.95),(t-0.5)/0.45,if(gt(t,2.95),(3.4-t)/0.45,1)))',
      drawtext=fontfile='$FONT_REGULAR':text='One session keeps the work connected.':
        fontsize=31:fontcolor=0xc4beb5:x=170:y=846:
        alpha='if(lt(t,0.7),0,if(lt(t,1.15),(t-0.7)/0.45,if(gt(t,2.95),(3.4-t)/0.45,1)))',
      fps=30,settb=AVTB,setsar=1[scene-b];

    [2:v]split=3[surface-c][surface-d][surface-e];
    [surface-c]scale=2688:1512,
      crop=1920:1080:x='40+45*t':y='310-18*t',
      trim=duration=3.2,setpts=PTS-STARTPTS,
      eq=contrast=1.12:brightness=-0.09:saturation=0.85,
      vignette=PI/4,
      drawbox=x=0:y=0:w=1920:h=1080:color=black@0.12:t=fill,
      drawtext=fontfile='$FONT_REGULAR':text='01 / CHAT':
        fontsize=28:fontcolor=0xff6542:x=152:y=130,
      drawtext=fontfile='$FONT_BOLD':text='TALK TO AI. NATURALLY.':
        fontsize=72:fontcolor=0xf2eee6:x=152:y=184,
      drawtext=fontfile='$FONT_REGULAR':text='A familiar chat interface.':
        fontsize=31:fontcolor=0xc4beb5:x=156:y=282,
      fps=30,settb=AVTB,setsar=1[scene-c];
    [surface-d]scale=2688:1512,
      crop=1920:1080:x='350+45*t':y='250+10*t',
      trim=duration=3.2,setpts=PTS-STARTPTS,
      eq=contrast=1.14:brightness=-0.11:saturation=0.82,
      vignette=PI/4,
      drawbox=x=0:y=0:w=1920:h=1080:color=black@0.14:t=fill,
      drawtext=fontfile='$FONT_REGULAR':text='02 / CLI':
        fontsize=28:fontcolor=0xff6542:x=152:y=130,
      drawtext=fontfile='$FONT_BOLD':text='RUN AGENTS SIDE BY SIDE.':
        fontsize=72:fontcolor=0xf2eee6:x=152:y=184,
      drawtext=fontfile='$FONT_REGULAR':text='One terminal or sixteen. Your call.':
        fontsize=31:fontcolor=0xc4beb5:x=156:y=282,
      fps=30,settb=AVTB,setsar=1[scene-d];
    [surface-e]scale=2688:1512,
      crop=1920:1080:x='700-30*t':y='205+15*t',
      trim=duration=3.2,setpts=PTS-STARTPTS,
      eq=contrast=1.14:brightness=-0.1:saturation=0.82,
      vignette=PI/4,
      drawbox=x=0:y=0:w=1920:h=1080:color=black@0.13:t=fill,
      drawtext=fontfile='$FONT_REGULAR':text='03 / FULL IDE':
        fontsize=28:fontcolor=0xff6542:x=152:y=130,
      drawtext=fontfile='$FONT_BOLD':text='CODE WITHOUT LEAVING GYRO.':
        fontsize=68:fontcolor=0xf2eee6:x=152:y=184,
      drawtext=fontfile='$FONT_REGULAR':text='Files. Editing. Diffs. Terminal. Preview.':
        fontsize=31:fontcolor=0xc4beb5:x=156:y=282,
      fps=30,settb=AVTB,setsar=1[scene-e];

    [core-f]scale=2400:1350,
      crop=1920:1080:x='420-60*t':y='150-18*t',
      trim=duration=3.0,setpts=PTS-STARTPTS,
      eq=contrast=1.16:brightness=-0.12:saturation=0.88,
      vignette=PI/4,
      drawbox=x=0:y=0:w=1920:h=1080:color=black@0.2:t=fill,
      drawtext=fontfile='$FONT_BOLD':text='ONE SESSION.':
        fontsize=90:fontcolor=0xf2eee6:x=150:y=700,
      drawtext=fontfile='$FONT_BOLD':text='ALL THREE.':
        fontsize=90:fontcolor=0xff6542:x=150:y=800,
      drawtext=fontfile='$FONT_REGULAR':text='Start in Chat. Move to CLI. Finish in the IDE.':
        fontsize=31:fontcolor=0xc4beb5:x=156:y=918,
      fps=30,settb=AVTB,setsar=1[scene-f];

    [core-g]scale=2304:1296,
      crop=1920:1080:x='250+18*t':y='108',
      trim=duration=4.2,setpts=PTS-STARTPTS,
      gblur=sigma=8,
      eq=contrast=1.08:brightness=-0.28:saturation=0.72,
      drawbox=x=0:y=0:w=1920:h=1080:color=black@0.45:t=fill[g-base];
    [3:v]format=rgba,lutrgb=r=242:g=238:b=230,scale=176:176,
      trim=duration=4.2,setpts=PTS-STARTPTS,
      fade=t=in:st=0.45:d=0.65:alpha=1[final-logo];
    [g-base][final-logo]overlay=x=174:y=356:enable='gte(t,0.45)',
      drawtext=fontfile='$FONT_BOLD':text='GYRO':
        fontsize=92:fontcolor=0xf2eee6:x=166:y=548:
        alpha='if(lt(t,0.65),0,min(1,(t-0.65)/0.65))',
      drawtext=fontfile='$FONT_BOLD':text='THE AI CODING WORKSPACE.':
        fontsize=53:fontcolor=0xf2eee6:x=642:y=440:
        alpha='if(lt(t,0.95),0,min(1,(t-0.95)/0.65))',
      drawtext=fontfile='$FONT_REGULAR':text='Chat  ·  CLI  ·  Full IDE':
        fontsize=34:fontcolor=0xc4beb5:x=646:y=520:
        alpha='if(lt(t,1.2),0,min(1,(t-1.2)/0.65))',
      drawtext=fontfile='$FONT_REGULAR':text='Private preview soon':
        fontsize=26:fontcolor=0xff6542:x=646:y=594:
        alpha='if(lt(t,1.45),0,min(1,(t-1.45)/0.65))',
      fps=30,settb=AVTB,setsar=1[scene-g];

    [scene-a][scene-b]xfade=transition=fade:duration=0.2:offset=2.8[ab];
    [ab][scene-c]xfade=transition=fade:duration=0.2:offset=6.0[abc];
    [abc][scene-d]xfade=transition=fade:duration=0.2:offset=9.0[abcd];
    [abcd][scene-e]xfade=transition=fade:duration=0.2:offset=12.0[abcde];
    [abcde][scene-f]xfade=transition=fade:duration=0.2:offset=15.0[abcdef];
    [abcdef][scene-g]xfade=transition=fade:duration=0.2:offset=17.8,
      unsharp=5:5:0.35:3:3:0,
      scale=1920:1080:in_range=full:out_range=tv,
      format=yuv420p,
      setparams=range=limited:color_primaries=bt709:color_trc=bt709:colorspace=bt709[vout];

    [4:a]volume=0.055,afade=t=in:d=1.2,afade=t=out:st=20.5:d=1.5[rumble];
    [5:a]highpass=f=110,lowpass=f=2600,volume=0.18,
      afade=t=in:d=1.0,afade=t=out:st=20.8:d=1.2[air];
    [6:a]highpass=f=420,lowpass=f=7600,
      afade=t=in:d=0.42,afade=t=out:st=0.42:d=0.48,
      volume=0.16,asplit=6[w1][w2][w3][w4][w5][w6];
    [w1]adelay=2600[wd1];
    [w2]adelay=5800[wd2];
    [w3]adelay=8800[wd3];
    [w4]adelay=11800[wd4];
    [w5]adelay=14800[wd5];
    [w6]adelay=17600[wd6];
    [7:a]volume=0.18,afade=t=out:st=0:d=0.75,asplit=6[h1][h2][h3][h4][h5][h6];
    [h1]adelay=2800[hd1];
    [h2]adelay=6000[hd2];
    [h3]adelay=9000[hd3];
    [h4]adelay=12000[hd4];
    [h5]adelay=15000[hd5];
    [h6]adelay=17800[hd6];
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
