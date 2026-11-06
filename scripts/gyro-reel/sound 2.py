"""Original, deterministic synthesized score; no external samples."""
from pathlib import Path
import numpy as np
import wave
SR=48000; duration=15; rng=np.random.default_rng(417)
a=np.zeros((SR*duration,2))
def add(t,s,gain=1,pan=0):
    pos=int(t*SR);n=min(len(s),len(a)-pos)
    if n<=0:return
    a[pos:pos+n,0]+=s[:n]*gain*np.sqrt((1-pan)/2)
    a[pos:pos+n,1]+=s[:n]*gain*np.sqrt((1+pan)/2)
def tone(f,d):
    t=np.arange(int(SR*d))/SR
    return t,np.sin(2*np.pi*f*t)
# Harmonically related airy pad, opening suspended and resolving at the brand reveal.
for start,freqs,dur in [(0,[110,164.81,220,293.66],6.25),(6.25,[130.81,196,261.63,329.63],5.5),(11.75,[146.83,220,293.66,440],3.25)]:
    t=np.arange(int(SR*dur))/SR;env=np.minimum(t/.7,1)*np.minimum((dur-t)/.8,1)
    for j,f in enumerate(freqs):
        s=(np.sin(2*np.pi*f*t)+.3*np.sin(2*np.pi*(f*1.002)*t))*env*.045
        add(start,s,pan=(j-1.5)/3)
# Tight syncopated low pulse / analog percussion.
for beat in np.arange(0,11.6,.5):
    t=np.arange(int(SR*.35))/SR
    phase=2*np.pi*(49*t+65*.024*(1-np.exp(-t/.024)))
    kick=np.sin(phase)*np.exp(-t*15)+rng.normal(0,.11,len(t))*np.exp(-t*190)
    add(beat,kick,.48)
    if beat>=3:
        t,s=tone(73.416,.24);add(beat+.25,(s+.25*np.sin(2*np.pi*146.832*t))*np.exp(-t*18),.14)
for beat in np.arange(.25,11.5,.25):
    t=np.arange(int(SR*.06))/SR;n=rng.normal(0,1,len(t));n=np.r_[0,np.diff(n)]
    add(beat,n*np.exp(-t*85),.027,pan=.5 if int(beat*4)%2 else -.5)
# Glass-like arpeggio and tempo echoes.
notes=[293.66,440,587.33,659.25,440,329.63,587.33,880]
for j,beat in enumerate(np.arange(0,11.5,.25)):
    t,s=tone(notes[j%8],.55);s=(s+.25*np.sin(2*np.pi*notes[j%8]*2.003*t))*np.exp(-t*9)*(1-np.exp(-t*250))
    add(beat,s,.065,pan=np.sin(j*1.2)*.65);add(beat+.1875,s,.023,pan=-np.sin(j*1.2)*.65)
# Directional transition swells: smooth bands, not broadband bursts.
for end in [3,6.25,8.5,11.75]:
    d=.55;t=np.arange(int(SR*d))/SR;n=rng.normal(0,1,len(t));n=np.convolve(n,np.ones(18)/18,mode='same')
    s=n*np.sin(np.pi*t/d)**2*.32+np.sin(2*np.pi*(180*t+420*t*t))*np.sin(np.pi*t/d)**2*.028
    add(end-d,s,pan=-.2)
    t,s=tone(55,.7);add(end,s*np.exp(-t*8),.36)
# Sonic logo, long tail, no voice.
for j,f in enumerate([293.66,440,587.33]):
    t,s=tone(f,2.7-j*.11);s=(s+.16*np.sin(2*np.pi*f*3*t))*np.exp(-t*2.2)*(1-np.exp(-t*160))
    add(11.85+j*.11,s,.18,pan=(j-1)*.35)
a*=np.minimum(np.arange(len(a))/SR/.015,1)[:,None]
a*=np.minimum((duration-np.arange(len(a))/SR)/.55,1)[:,None]
a=np.tanh(a*1.3)*.85
out=Path('docs/media/launch/reel-v01/score.wav')
with wave.open(str(out),'wb') as w:
    w.setnchannels(2);w.setsampwidth(2);w.setframerate(SR);w.writeframes((a*32767).astype('<i2').tobytes())
print(out)
