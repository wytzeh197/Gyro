"""Gyro v02: original synthesized 120 BPM electronica, deterministic seed."""
import numpy as np
import wave
from pathlib import Path
sr=48000;dur=15;rng=np.random.default_rng(8027);out=np.zeros((sr*dur,2))
def add(start,s,level=1,pan=0):
    i=round(start*sr)
    if i<0:s=s[-i:];i=0
    n=min(len(s),len(out)-i)
    if n<=0:return
    out[i:i+n,0]+=s[:n]*level*np.sqrt((1-pan)/2)
    out[i:i+n,1]+=s[:n]*level*np.sqrt((1+pan)/2)
def axis(d):return np.arange(round(d*sr))/sr
def note(f,d,bright=1):
    t=axis(d);s=np.zeros(len(t))
    for k in range(1,7):s+=np.sin(2*np.pi*f*k*t+.025*np.sin(2*np.pi*3*t))/(k*k**.3)*np.exp(-t*(2+k*bright))
    return s*(1-np.exp(-t*180))
# Evolving stereo chords, Dm9 / Fmaj9 / Cadd9 / Dm9.
for start,notes,length in [(0,[146.83,220,261.63,329.63],5),(5,[174.61,220,261.63,329.63],3.5),(8.5,[130.81,196,261.63,293.66],3),(11.5,[146.83,220,293.66,440],3.5)]:
    t=axis(length);env=np.minimum(t/.35,1)*np.minimum((length-t)/.8,1)
    for j,f in enumerate(notes):
        s=(np.sin(2*np.pi*f*t)+.32*np.sin(2*np.pi*f*1.003*t)+.12*np.sin(2*np.pi*f*2*t))*env
        add(start,s,.043,(j-1.5)/2.1)
# Rounded deep kick, dry backbeat and shuffling high percussion.
for k,b in enumerate(np.arange(0,11.5,.5)):
    t=axis(.32);phase=2*np.pi*(48*t+85*.021*(1-np.exp(-t/.021)))
    s=np.sin(phase)*np.exp(-t*14)+rng.normal(0,.11,len(t))*np.exp(-t*230)
    add(b,s,.62)
    if k%2:
        t=axis(.15);n=rng.normal(0,1,len(t));low=np.convolve(n,np.ones(10)/10,'same');n=n-low
        env=np.exp(-t*37)*(1+.7*np.cos(2*np.pi*110*t)**8)
        add(b,n*env,.075,.04)
for k,b in enumerate(np.arange(.125,11.5,.25)):
    t=axis(.07);n=rng.normal(0,1,len(t));n=np.r_[0,np.diff(n)]
    add(b+(k%2)*.018,n*np.exp(-t*74),.024 if k%2 else .033,(-1 if k%2 else 1)*.6)
# Syncopated warm bass, controlled with a soft saturator.
for k,b in enumerate(np.arange(0,11.5,.5)):
    f=[73.416,73.416,110,65.406][k//4%4];t=axis(.32)
    s=np.sin(2*np.pi*f*t)+.27*np.sin(2*np.pi*f*2*t)+.12*np.sin(2*np.pi*f*3*t)
    s=np.tanh(s*1.7)*np.exp(-t*10)*(1-np.exp(-t*200))
    add(b+.23,s,.20)
# Short plucked motif with stereo dotted echoes; restrained upper register.
melody=[293.66,440,523.25,659.25,587.33,440,329.63,523.25]
for j,b in enumerate(np.arange(.25,11.25,.375)):
    s=note(melody[j%8],.8,2);p=np.sin(j*1.7)*.55
    add(b,s,.075,p);add(b+.1875,s,.025,-p);add(b+.375,s,.011,p)
# Stabs add drive after the first product reveal.
for b in [2.5,3.25,4,5,5.75,6.75,7.5,8.5,9.25,10,10.75]:
    s=sum(note(f,.55,4) for f in [293.66,349.23,440])
    add(b,s,.058,-.15);add(b+.1875,s,.018,.3)
# Soft directional swooshes and impacts tied to edits.
for end in [2.5,5,6.75,8.5,11.5]:
    t=axis(.48);n=rng.normal(0,1,len(t));n=np.convolve(n,np.ones(12)/12,'same')
    s=n*np.sin(np.pi*t/.48)**2
    add(end-.42,s,.35,-.35);add(end-.38,s,.16,.35)
    t=axis(.5);add(end,np.sin(2*np.pi*(52*t+9*(1-np.exp(-t*12))))*np.exp(-t*12),.30)
# Brand signature: three ascending glass notes, soft stereo tail.
for j,f in enumerate([293.66,440,587.33]):
    s=note(f,3.2-j*.125,.65)
    add(11.5+j*.125,s,.19,(j-1)*.4)
    add(11.75+j*.125,s,.07,(1-j)*.5)
    add(12+j*.125,s,.025,(j-1)*.5)
# Subtle ambience, no noise at either edge.
t=axis(dur);air=rng.normal(0,1,len(t));air=np.convolve(air,np.ones(80)/80,'same');add(0,air,.014)
fade=np.minimum(t/.018,1)*np.minimum((dur-t)/.8,1)
out=np.tanh(out*1.15)*fade[:,None]*.83
p=Path('docs/media/launch/reel-v03/score.wav')
with wave.open(str(p),'wb') as w:w.setnchannels(2);w.setsampwidth(2);w.setframerate(sr);w.writeframes((out*32767).astype('<i2').tobytes())
print(p)
