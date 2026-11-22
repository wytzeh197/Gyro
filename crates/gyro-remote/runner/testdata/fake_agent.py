#!/usr/bin/env python3
"""Stand-in for an agent CLI in the runner tests. It never touches the network.

The last argument is the task. Flags come before it:
  --lines N --interval S   print N numbered lines, S seconds apart
  --sleep S                sleep before exiting
  --exit C                 exit code
  --big N                  print one line of N characters
  --say TEXT               print TEXT
  --task-file PATH         write the task text to PATH
  --edit NAME              write the task text to NAME in the working directory
  --child PATH             start a grandchild that sleeps; its pid goes to PATH
  --background             leave a child behind that holds stdout open
  --ignore-term            ignore SIGTERM (forces the runner to SIGKILL)
"""
import os
import signal
import subprocess
import sys
import time

args, task = sys.argv[1:-1], sys.argv[-1]
opts = {}
flags = ("--background", "--ignore-term")
index = 0
while index < len(args):
    if args[index] in flags:
        opts[args[index]] = True
        index += 1
    else:
        opts[args[index]] = args[index + 1]
        index += 2

if "--ignore-term" in opts:
    signal.signal(signal.SIGTERM, signal.SIG_IGN)
if "--task-file" in opts:
    with open(opts["--task-file"], "w") as handle:
        handle.write(task)
if "--edit" in opts:
    with open(opts["--edit"], "w") as handle:
        handle.write(task)
if "--child" in opts:
    child = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(120)"],
                             stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    with open(opts["--child"], "w") as handle:
        handle.write(str(child.pid))
if "--background" in opts:
    subprocess.Popen([sys.executable, "-c", "import time; time.sleep(30)"])
if "--say" in opts:
    print(opts["--say"], flush=True)
if "--big" in opts:
    print("x" * int(opts["--big"]), flush=True)
for number in range(int(opts.get("--lines", 0))):
    print("line %d" % number, flush=True)
    time.sleep(float(opts.get("--interval", 0)))
time.sleep(float(opts.get("--sleep", 0)))
sys.exit(int(opts.get("--exit", 0)))
