#!/usr/bin/env python3
"""Opt-in macOS process sampling; no app instrumentation or telemetry.

Includes XPC helpers attributed to --pid by macOS responsibility, not every
WebKit process on the machine. Requires permission to inspect processes. Only
executable basenames and counters are saved; never arguments or app contents.
"""
import argparse
import ctypes as C
import datetime
import json
import math
import os
from pathlib import Path
import statistics
import sys
import time


class Usage(C.Structure):
    # sys/resource.h: rusage_info_v2. CPU times are Mach absolute-time ticks.
    _fields_ = [("uuid", C.c_uint8 * 16)] + [
        (name, C.c_uint64) for name in (
            "user_time", "system_time", "pkg_idle_wkups", "interrupt_wkups",
            "pageins", "wired_size", "resident_size", "phys_footprint",
            "proc_start_abstime", "proc_exit_abstime", "child_user_time",
            "child_system_time", "child_pkg_idle_wkups", "child_interrupt_wkups",
            "child_pageins", "child_elapsed_abstime", "diskio_bytesread",
            "diskio_byteswritten",
        )
    ]


class Timebase(C.Structure):
    _fields_ = [("numer", C.c_uint32), ("denom", C.c_uint32)]


class Processes:
    def __init__(self):
        self.lib = C.CDLL("/usr/lib/libSystem.B.dylib", use_errno=True)
        signatures = {
            "proc_pid_rusage": ([C.c_int, C.c_int, C.c_void_p], C.c_int),
            "proc_listallpids": ([C.c_void_p, C.c_int], C.c_int),
            "proc_name": ([C.c_int, C.c_void_p, C.c_uint32], C.c_int),
            # Private SPI: diagnostic script only; fail explicitly if absent.
            "responsibility_get_pid_responsible_for_pid": ([C.c_int], C.c_int),
            "mach_timebase_info": ([C.POINTER(Timebase)], C.c_int),
        }
        for name, (args, result) in signatures.items():
            function = getattr(self.lib, name)
            function.argtypes, function.restype = args, result
        base = Timebase()
        if self.lib.mach_timebase_info(C.byref(base)) or not base.denom:
            raise RuntimeError("Cannot read Mach timebase")
        self.seconds_per_tick = base.numer / base.denom / 1e9

    def usage(self, pid):
        value = Usage()
        if self.lib.proc_pid_rusage(pid, 2, C.byref(value)):
            raise OSError(C.get_errno(), "Cannot read process counters", pid)
        return value

    def owned(self, root):
        count = self.lib.proc_listallpids(None, 0)
        if count <= 0:
            raise RuntimeError("Cannot enumerate processes")
        buffer = (C.c_int * (count * 2 + 128))()
        length = self.lib.proc_listallpids(buffer, C.sizeof(buffer))
        if length <= 0 or length >= len(buffer):
            raise RuntimeError("Process enumeration failed or overflowed; retry")
        values, errors = [], []
        for pid in buffer[:length]:
            if pid <= 0 or (pid != root and
                    self.lib.responsibility_get_pid_responsible_for_pid(pid) != root):
                continue
            try:
                value = self.usage(pid)
            except OSError as error:
                errors.append({"pid": pid, "errno": error.errno})
                continue
            name = C.create_string_buffer(1024)
            self.lib.proc_name(pid, name, len(name))
            values.append({
                "pid": pid, "start": value.proc_start_abstime,
                "name": name.value.decode("utf-8", errors="replace"),
                "cpuSeconds": (value.user_time + value.system_time) * self.seconds_per_tick,
                "footprintBytes": value.phys_footprint,
                "residentBytes": value.resident_size,
                "packageIdleWakeups": value.pkg_idle_wkups,
                "interruptWakeups": value.interrupt_wkups,
                "diskReadBytes": value.diskio_bytesread,
                "diskWrittenBytes": value.diskio_byteswritten,
            })
        return sorted(values, key=lambda value: value["pid"]), errors


def measure(processes, root, seconds, interval):
    identity = processes.usage(root).proc_start_abstime
    started = time.monotonic()
    samples = []
    previous = {}
    counters = ("cpuSeconds", "packageIdleWakeups", "interruptWakeups",
                "diskReadBytes", "diskWrittenBytes")
    while True:
        if processes.usage(root).proc_start_abstime != identity:
            raise RuntimeError("Root process changed identity during sampling")
        owned, errors = processes.owned(root)
        if not any(value["pid"] == root for value in owned):
            raise RuntimeError("Root process disappeared during sampling")
        elapsed = time.monotonic() - started
        delta = {name: 0 for name in counters}
        for value in owned:
            old = previous.get((value["pid"], value["start"]))
            if old:
                for name in counters:
                    delta[name] += max(0, value[name] - old[name])
        span = elapsed - samples[-1]["elapsedSeconds"] if samples else 0
        samples.append({
            "elapsedSeconds": elapsed,
            "footprintBytes": sum(value["footprintBytes"] for value in owned),
            "residentBytes": sum(value["residentBytes"] for value in owned),
            "cpuPercentOneCore": delta["cpuSeconds"] / span * 100 if span else None,
            "delta": delta, "processes": owned, "readErrors": errors,
        })
        previous = {(value["pid"], value["start"]): value for value in owned}
        if elapsed >= seconds:
            break
        time.sleep(min(interval, seconds - elapsed))
    duration = samples[-1]["elapsedSeconds"] - samples[0]["elapsedSeconds"]
    totals = {name: sum(sample["delta"][name] for sample in samples) for name in counters}
    footprints = [sample["footprintBytes"] / 1024**2 for sample in samples]
    return {
        "durationSeconds": duration,
        "cpuPercentOneCore": totals["cpuSeconds"] / duration * 100,
        "footprintMiB": {"median": statistics.median(footprints), "min": min(footprints), "max": max(footprints)},
        "observedCounters": totals, "samples": samples,
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--pid", type=int, required=True)
    parser.add_argument("--seconds", type=float, default=60)
    parser.add_argument("--interval", type=float, default=2)
    parser.add_argument("--label", required=True, help="Describe the observed scenario")
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    if sys.platform != "darwin":
        parser.error("Native resource sampling requires macOS")
    if args.pid <= 0 or not all(math.isfinite(v) and v > 0 for v in (args.seconds, args.interval)):
        parser.error("PID, duration and interval must be positive finite values")
    if args.seconds < 1 or args.interval < 0.1:
        parser.error("Use at least one second of sampling and a 0.1-second interval")
    result = {
        "schema": "gyro.native-resources.v1",
        "collectedAt": datetime.datetime.now(datetime.timezone.utc).isoformat(),
        "label": args.label, "rootPid": args.pid,
        "attribution": "macOS process responsibility (private diagnostic SPI)",
        "cpuConvention": "100% = one logical core; Mach ticks converted with mach_timebase_info",
        "limits": [
            "Sampled physical footprint, not an allocation trace or exclusive system-wide memory cost.",
            "Short-lived processes between samples and counters before a process first appears are excluded.",
            "Disk counters describe physical I/O, not all cached filesystem reads. GPU watts and network bytes are not measured.",
            "An external local model server may not be attributed to the app and must be measured separately.",
        ],
        "logicalCpus": os.cpu_count(), "loadAverageAtStart": os.getloadavg(),
    }
    result.update(measure(Processes(), args.pid, args.seconds, args.interval))
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(result, indent=2) + "\n")
    print(json.dumps({key: value for key, value in result.items() if key != "samples"}, indent=2))


if __name__ == "__main__":
    main()
