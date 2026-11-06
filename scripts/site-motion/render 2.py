#!/usr/bin/env python3
"""Compose real Gyro captures into responsive posters and two silent films."""
import json
import subprocess
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
STILLS = ROOT / 'docs/screenshots/site-v4'
ASSETS = ROOT / 'site/assets'
WORK = Path(tempfile.mkdtemp(prefix='gyro-site-motion-'))

def run(*args):
    subprocess.run([str(a) for a in args], check=True)

def ff(*args):
    run('ffmpeg', '-hide_banner', '-loglevel', 'error', '-y', *args)

for theme in ('dark', 'light'):
    scenes = []
    for index, name in enumerate(('conversation', 'activity', 'review')):
        source = ('hero' if theme == 'dark' else 'hero-light') if name == 'review' else f'website-{name}-{theme}'
        width = 2880 if name == 'review' else 1920
        left = (3200-width)//2
        output = WORK / f'{name}-{theme}.png'
        # A quiet photographic surround. All pixels inside the window are actual UI.
        composition = (
            '[0:v]scale=3200:2000:force_original_aspect_ratio=increase,crop=3200:2000,setsar=1[bg];'
            f'[1:v]scale={width}:1440:flags=lanczos,setsar=1[ui];'
            f'[bg]drawbox=x={left-24}:y=264:w={width+48}:h=1492:color=black@0.14:t=fill,'
            f'drawbox=x={left-2}:y=278:w={width+4}:h=1444:color=white@0.25:t=fill[mat];'
            f'[mat][ui]overlay={left}:280,format=rgb24[out]'
        )
        ff('-i', ASSETS/'gyro-coast.webp', '-i', STILLS/f'{source}.png', '-filter_complex', composition,
           '-map', '[out]', '-frames:v', '1', output)
        scenes.append(output)
        if name == 'review':
            prefix = 'hero' if theme == 'dark' else 'hero-light'
            for size in (600,1200,2400):
                run('cwebp','-quiet','-q','88','-resize',size,int(size*0.625),output,'-o',ASSETS/f'screenshots/{prefix}-{size}.webp')
    # Four-second readable holds; dissolves connect the actual captured states.
    # Last review returns to the first conversation for a seamless looping file.
    inputs=[]
    for frame in (*scenes, scenes[0]):
        inputs += ['-loop','1','-framerate','24','-t','5','-i',frame]
    graph = ''.join(f'[{i}:v]scale=1600:1000:flags=lanczos,format=yuv420p,settb=AVTB[v{i}];' for i in range(4))
    graph += '[v0][v1]xfade=transition=fade:duration=0.6:offset=3.8[a];'
    graph += '[a][v2]xfade=transition=fade:duration=0.6:offset=7.6[b];'
    graph += '[b][v3]xfade=transition=fade:duration=0.6:offset=12.4,format=yuv420p[out]'
    ff(*inputs,'-filter_complex',graph,'-map','[out]','-t','13','-an','-c:v','libx264','-preset','slow',
       '-crf','20','-movflags','+faststart',ASSETS/f'motion/workflow-{theme}.mp4')
print(f'Compositions available for QA: {WORK}')
