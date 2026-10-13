import ctypes, subprocess, time, json, statistics, datetime, hashlib, struct
from pathlib import Path
lib=ctypes.CDLL('/usr/lib/libproc.dylib')
system=ctypes.CDLL('/usr/lib/libSystem.B.dylib',use_errno=True)
system.sysctl.argtypes=[ctypes.POINTER(ctypes.c_int),ctypes.c_uint,ctypes.c_void_p,ctypes.POINTER(ctypes.c_size_t),ctypes.c_void_p,ctypes.c_size_t]
system.sysctl.restype=ctypes.c_int
lib.proc_listpids.argtypes=[ctypes.c_uint32,ctypes.c_uint32,ctypes.c_void_p,ctypes.c_int]
lib.proc_listpids.restype=ctypes.c_int
lib.proc_pidpath.argtypes=[ctypes.c_int,ctypes.c_void_p,ctypes.c_uint32]
lib.proc_pidpath.restype=ctypes.c_int

def is_watchdog(pid):
    mib=(ctypes.c_int*3)(1,49,pid)
    length=ctypes.c_size_t(0)
    if system.sysctl(mib,3,None,ctypes.byref(length),None,0) != 0: return False
    if length.value < 4 or length.value > 1024*1024: return False
    buffer=ctypes.create_string_buffer(length.value)
    if system.sysctl(mib,3,buffer,ctypes.byref(length),None,0) != 0: return False
    # Inspect only argc/path/argv. Never decode, record or print environment data.
    argc=struct.unpack('i',buffer.raw[:4])[0]
    if argc < 2 or argc > 8: return False
    raw=buffer.raw[:length.value]
    index=raw.find(bytes([0]),4)
    if index < 0: return False
    index += 1
    while index < len(raw) and raw[index] == 0: index += 1
    args=[]
    for _ in range(argc):
        end=raw.find(bytes([0]),index)
        if end < 0: return False
        args.append(raw[index:end]); index=end+1
    return len(args)==3 and args[1]==b'--gyro-process-crash-helper'

def owned_helpers(parent, executable):
    pids=(ctypes.c_int32*64)()
    count=lib.proc_listpids(6,parent,pids,ctypes.sizeof(pids))
    result=set()
    for pid in pids[:max(0,count)//4]:
        if pid <= 0: continue
        path=ctypes.create_string_buffer(4096)
        if lib.proc_pidpath(pid,path,len(path)) > 0 and path.value.decode()==executable and is_watchdog(pid):
            result.add(pid)
    return result

before='/private/tmp/gyro-process-lifecycle-guarded-probe'
after='/private/tmp/gyro-process-lifecycle-pooled-probe'
rows=[]
for order in [[('before',before,'benchmark-guarded'),('after',after,'benchmark-pooled')],
              [('after',after,'benchmark-pooled'),('before',before,'benchmark-guarded')]]:
    for label,executable,mode in order:
        started=time.monotonic()
        process=subprocess.Popen([executable,mode],stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True)
        seen=set()
        while process.poll() is None:
            seen.update(owned_helpers(process.pid,executable))
            if time.monotonic()-started > 20:
                process.kill(); process.wait(); raise RuntimeError('owned benchmark timed out')
            time.sleep(0.001)
        stdout,stderr=process.communicate()
        if process.returncode: raise RuntimeError(stderr)
        samples=json.loads(stdout)
        rows.append({'condition':label,'samplesUs':samples,'runWallMs':(time.monotonic()-started)*1000,
                     'observedWatchdogPids':sorted(seen),'observedWatchdogCount':len(seen)})
summary={}
for label in ['before','after']:
    selected=[row for row in rows if row['condition']==label]
    values=[value for row in selected for value in row['samplesUs']]
    summary[label]={'samples':len(values),'medianCommandMs':statistics.median(values)/1000,
                    'meanCommandMs':statistics.mean(values)/1000,'runWallMs':[row['runWallMs'] for row in selected],
                    'observedWatchdogCounts':[row['observedWatchdogCount'] for row in selected]}
out={'recordedAt':datetime.datetime.now(datetime.timezone.utc).isoformat(),
     'scope':'Two immutable standalone probe executables, same 20 true commands, alternating block order, owned-child PID sampling every 1ms, helper argv checked after exec; desktop/model latency is not measured',
     'binaryHashes':{str(p):hashlib.sha256(Path(p).read_bytes()).hexdigest() for p in [before,after]},
     'rows':rows,'summary':summary}
Path('/private/tmp/gyro-backend-final-2026-10-08/watchdog-reuse-benchmark.json').write_text(json.dumps(out,indent=2)+'\n')
print(json.dumps(summary))
