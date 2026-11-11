#!/usr/bin/env python3
"""List lib.rs unused imports per build: prod (`--lib`) and test (`--lib --profile test`).

Names unused in both can be deleted; names unused only in prod belong behind #[cfg(test)].
Prints JSON {line: {"both": [...], "prod_only": [...], "test_only": [...]}} for lines with new warnings.
"""
import json, re, subprocess, sys, os, collections

ROOT = "/Users/wytze/Gyro"
HERE = os.path.dirname(os.path.abspath(__file__))
base = set(json.load(open(os.path.join(HERE, "warn-baseline.json"))))


def unused(extra):
    cmd = ["cargo", "check", "-p", "gyro-desktop", "--lib", "--locked", "--message-format=json"] + extra
    out = subprocess.run(cmd, cwd=ROOT, capture_output=True, text=True).stdout
    res = collections.defaultdict(set)
    for line in out.splitlines():
        try:
            o = json.loads(line)
        except Exception:
            continue
        if o.get("reason") != "compiler-message":
            continue
        m = o["message"]
        if m["level"] != "warning" or (m.get("code") or {}).get("code") != "unused_imports":
            continue
        for s in m["spans"]:
            if not s["file_name"].endswith("src/lib.rs"):
                continue
            k = f"{m['level']}|{s['file_name']}|{m['message']}"
            name = s["text"][0]["text"][s["text"][0]["highlight_start"] - 1 : s["text"][0]["highlight_end"] - 1]
            res[s["line_start"]].add(name.strip())
    return res


prod = unused([])
test = unused(["--profile", "test"])
report = {}
for line in sorted(set(prod) | set(test)):
    p, t = prod.get(line, set()), test.get(line, set())
    report[line] = {"both": sorted(p & t), "prod_only": sorted(p - t), "test_only": sorted(t - p)}
print(json.dumps(report, indent=1))
