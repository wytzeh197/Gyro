import numpy as np, wave
SR=48000; D=30.0; N=int(SR*D); t=np.arange(N)/SR
rng=np.random.default_rng(3031)
L=np.zeros(N); R=np.zeros(N)
def sstep(x): x=np.clip(x,0,1); return x*x*(3-2*x)
def env(a,b,att,rel):
    x=t-a; return sstep(x/att)*sstep((b-a-x)/rel)*((t>=a)&(t<=b))
def lowpass(x,fc,order=4):
    X=np.fft.rfft(x); fr=np.fft.rfftfreq(len(x),1/SR); X/=np.sqrt(1+(fr/fc)**(2*order)); return np.fft.irfft(X,len(x))
# Pad: D major 9 voicing, detuned, slow chord change at the product beat and resolve at the logo
def padchord(fs,a,b,g):
    e=env(a,b,1.6,2.2); outL=np.zeros(N); outR=np.zeros(N)
    for i,f in enumerate(fs):
        amp=g/(1+0.45*i)
        outL+=np.sin(2*np.pi*(f-0.35)*t+i)*amp; outR+=np.sin(2*np.pi*(f+0.35)*t+2*i)*amp
    return outL*e,outR*e
for fs,a,b,g in [([73.42,146.83,220,277.18,329.63],0,8.6,0.05),
                 ([61.74,123.47,185,246.94,293.66,369.99],7.4,16.8,0.05),
                 ([65.41,130.81,196,261.63,329.63,392],15.6,22.6,0.05),
                 ([73.42,146.83,220,293.66,369.99,440,554.37],21.6,30,0.06)]:
    l,r=padchord(fs,a,b,g); L+=l; R+=r
lfo=0.8+0.2*np.sin(2*np.pi*t/6.0); L*=lfo; R*=lfo
# pulse: soft plucked 8ths during orbit beats, tempo 100 bpm
bpm=100; step=60/bpm/2
notes=[587.33,739.99,880,739.99,1174.66,880,739.99,880]
k=0; x0=4.2
while x0<20.2:
    i=int(x0*SR); n=int(0.5*SR); x=np.arange(n)/SR
    f=notes[k%len(notes)]*(0.5 if 7.6<x0<16.6 and (k%2) else 1)*(0.94387 if 15.6<x0<20.3 else 1)
    s=np.sin(2*np.pi*f*x)*np.exp(-x/0.12)*0.018*(1+0.2*np.sin(k))
    pan=0.35*np.sin(k*0.9)
    L[i:i+n]+=s*(1-pan); R[i:i+n]+=s*(1+pan); k+=1; x0+=step
def boom(at,g=1.0,f=49):
    i=int(at*SR); x=t[i:]-at
    s=(np.sin(2*np.pi*f*x*(1+0.3*np.exp(-x/0.05)))+0.3*np.sin(2*np.pi*2*f*x))*np.exp(-x/1.4)*np.clip(x/0.02,0,1)
    L[i:]+=s*g*0.26; R[i:]+=s*g*0.26
for at,g in [(0.35,0.5),(3.97,1.0),(8.9,0.75),(11.5,0.55),(16.7,0.8),(22.32,1.35)]: boom(at,g)
noise=lowpass(rng.standard_normal(N),2200); noise/=np.abs(noise).max()
noise2=np.roll(noise,1777)
def whoosh(a,b,p,g=0.1):
    e=env(a,b,(b-a)*0.7,(b-a)*0.3)*g; pan=np.interp(t,[a,b],[p,-p])
    L[:]+=noise*e*(1-pan); R[:]+=noise2*e*(1+pan)
for a,b,p,g in [(3.4,4.3,0.0,0.09),(4.1,6.2,0.7,0.12),(7.6,9.2,-0.4,0.10),(10.3,11.6,0.5,0.10),(12.4,13.2,-0.6,0.07),(13.9,14.7,0.6,0.07),(15.7,16.9,0.0,0.10),(20.3,22.4,0.8,0.16)]:
    whoosh(a,b,p,g)
# riser into the logo
a,b=20.4,22.3; i0,i1=int(a*SR),int(b*SR); x=t[i0:i1]-a; d=b-a
f=180*(4.5)**(x/d); ph=2*np.pi*np.cumsum(f)/SR
r=np.sin(ph)*(x/d)**2*0.05; L[i0:i1]+=r; R[i0:i1]+=r
def chime(at,fs,g=1.0,pan=0,dec=1.8):
    i=int(at*SR); x=t[i:]-at
    s=sum(np.sin(2*np.pi*f*x)*np.exp(-x/(dec-0.25*k)) for k,f in enumerate(fs))*np.clip(x/0.008,0,1)*0.045*g
    L[i:]+=s*(1-pan); R[i:]+=s*(1+pan)
for i in range(6): chime(0.2+i*0.16,[1174.66*2**([0,4,7,11,14,16][i]/12)],0.3,(i-2.5)/3,1.2)
chime(3.97,[587.33,880],0.7)
for i in range(6): chime(4.2+i*0.11,[880*2**([0,2,4,7,9,12][i]/12)],0.35,(i-2.5)/3)
chime(12.5,[987.77],0.35,0.4); chime(14.0,[1108.73],0.35,-0.4)
for i in range(6): chime(16.7+i*0.1,[783.99*2**([0,4,7,12,16,19][i]/12)],0.3,(i-2.5)/3)
chime(22.33,[293.66,440,587.33,880,1174.66],1.3,0,2.6)
chime(23.8,[1760],0.25,0.2,1.0); chime(24.4,[2349.32],0.18,-0.2,1.0)
fade=np.clip((29.8-t)/3.2,0,1)**2; L*=fade; R*=fade
m=max(np.abs(L).max(),np.abs(R).max()); L*=0.85/m; R*=0.85/m
w=wave.open('score.wav','wb'); w.setnchannels(2); w.setsampwidth(2); w.setframerate(SR)
w.writeframes((np.stack([L,R],1)*32767).astype('<i2').tobytes()); w.close(); print('ok')
