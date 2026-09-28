import numpy as np, wave
SR=48000; D=30.0; N=int(SR*D); t=np.arange(N)/SR
rng=np.random.default_rng(1010)
L=np.zeros(N); R=np.zeros(N)
def env(a,b,att,rel):
    e=np.zeros(N); i0,i1=int(a*SR),min(N,int(b*SR))
    x=t[i0:i1]-a; dur=b-a
    e[i0:i1]=np.clip(x/att,0,1)*np.clip((dur-x)/rel,0,1)
    return e**2*(3-2*e)  # smoothstep-ish
# Pad: A major add9 voicing, slow swells
freqs=[110,164.81,220,277.18,329.63,493.88]
pad=np.zeros(N)
for i,f in enumerate(freqs):
    for d in (-0.6,0.6):
        pad+=np.sin(2*np.pi*(f+d)*t+i)*(0.5/(1+i*0.5))
lfo=0.75+0.25*np.sin(2*np.pi*t/7.5)
padenv=env(0,29.6,2.5,5.0)*lfo
# scene dynamics
dyn=np.interp(t,[0,3,5.5,8.4,13.5,15.2,18.5,23.5,25.1,27.5,29.6],[0.5,0.7,1.0,0.85,0.9,1.0,0.85,0.8,1.1,0.85,0])
pad*=padenv*dyn*0.06
L+=pad*1.0; R+=np.roll(pad,240)
# low landings
def boom(at,g=1.0,f=55):
    i=int(at*SR); x=t[i:]-at
    s=(np.sin(2*np.pi*f*x)+0.35*np.sin(2*np.pi*2*f*x)+0.15*np.sin(2*np.pi*3*f*x))*np.exp(-x/1.6)*np.clip(x/0.03,0,1)
    L[i:]+=s*g*0.28; R[i:]+=s*g*0.28
for at,g in [(0.2,0.5),(2.1,0.6),(4.2,0.6),(4.8,0.6),(5.4,0.8),(8.4,0.7),(10.3,0.6),(11.95,0.6),(15.2,0.9),(19.2,0.6),(20.95,0.6),(22.7,0.6),(24.9,1.2)]: boom(at,g)
# air whooshes (band-limited noise swells, panned)
def lowpass(x,fc):
    X=np.fft.rfft(x); fr=np.fft.rfftfreq(len(x),1/SR); X*=1/(1+(fr/fc)**4); return np.fft.irfft(X,len(x))
noise=lowpass(rng.standard_normal(N),1800)-lowpass(rng.standard_normal(N),150)*0
noise/=np.abs(noise).max()
for a,b,p in [(3.0,3.8,0.0),(7.0,8.3,0.3),(9.5,10.4,-0.6),(11.2,12.0,0.0),(13.8,14.9,0.3),(18.1,18.9,-0.3),(19.9,20.6,0.3),(21.6,22.4,-0.3),(23.3,25.0,0.0)]:
    e=env(a,b,(b-a)*0.65,(b-a)*0.35)*0.10
    pan=np.interp(t,[a,b],[p,-p])
    L+=noise*e*(1-pan)/2*1.6; R+=np.roll(noise,997)*e*(1+pan)/2*1.6
# UI click at Review press
i=int(2.1*SR); x=t[i:i+2400]-2.1
c=np.sin(2*np.pi*2400*x)*np.exp(-x/0.006)*0.18+np.sin(2*np.pi*900*x)*np.exp(-x/0.012)*0.1
L[i:i+2400]+=c; R[i:i+2400]+=c
# soft chimes
def chime(at,fs,g=1.0,pan=0):
    i=int(at*SR); x=t[i:]-at
    s=sum(np.sin(2*np.pi*f*x)*np.exp(-x/(2.2-0.3*k)) for k,f in enumerate(fs))*np.clip(x/0.01,0,1)*0.05*g
    L[i:]+=s*(1-pan); R[i:]+=s*(1+pan)
chime(2.12,[659.25,987.77],0.6,0)
chime(6.4,[880,1318.5],0.5,0)
for k in range(6): chime(14.8+k*0.1,[880*2**([0,2,4,7,9,12][k]/12)],0.35,(k-2.5)/4)
chime(25.65,[440,659.25,880,1318.5],1.1,0)
# final fade to silence
fade=np.clip((29.7-t)/2.7,0,1); fade=fade**2
L*=fade; R*=fade
m=max(np.abs(L).max(),np.abs(R).max()); L*=0.84/m; R*=0.84/m
st=np.stack([L,R],1)
w=wave.open('score.wav','wb'); w.setnchannels(2); w.setsampwidth(2); w.setframerate(SR)
w.writeframes((st*32767).astype('<i2').tobytes()); w.close()
print('ok')
