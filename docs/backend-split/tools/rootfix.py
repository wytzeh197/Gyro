#!/usr/bin/env python3
"""Prune lib.rs root imports: drop names unused in both prod and test builds,
move names used only by tests behind #[cfg(test)].

Uses rustc's own removal suggestions from the prod (`--lib`) build, then appends
`#[cfg(test)] use <path>;` for names the test build still needs.
"""
import json, subprocess, sys, os, collections, re

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import split  # noqa

ROOT = "/Users/wytze/Gyro"
LIB = os.path.join(ROOT, "apps/desktop/src-tauri/src/lib.rs")


def unused(extra):
    cmd = ["cargo", "check", "-p", "gyro-desktop", "--lib", "--locked", "--message-format=json"] + extra
    out = subprocess.run(cmd, cwd=ROOT, capture_output=True, text=True).stdout
    names = set()
    edits = set()
    errors = 0
    for line in out.splitlines():
        try:
            o = json.loads(line)
        except Exception:
            continue
        if o.get("reason") != "compiler-message":
            continue
        m = o["message"]
        if m["level"] == "error":
            errors += 1
        if m["level"] != "warning" or (m.get("code") or {}).get("code") != "unused_imports":
            continue
        hit = False
        for s in m["spans"]:
            if not s["file_name"].endswith("src/lib.rs"):
                continue
            hit = True
            t = s["text"][0]
            names.add((t["text"][t["highlight_start"] - 1 : t["highlight_end"] - 1].strip(), s["line_start"]))
        if hit:
            for c in m.get("children", []):
                for s in c.get("spans", []):
                    if s.get("suggested_replacement") is not None and s["file_name"].endswith("src/lib.rs"):
                        edits.add((s["byte_start"], s["byte_end"], s["suggested_replacement"]))
    return names, edits, errors


def main():
    prod, prod_edits, e1 = unused([])
    test, _, e2 = unused(["--profile", "test"])
    if e1 or e2:
        raise SystemExit(f"errors present (prod {e1}, test {e2}); fix first")
    test_names = {n for n, _ in test}
    binds = split.lib_bindings()
    keep_for_test = sorted({n for n, _ in prod if n not in test_names})
    paths = []
    for n in keep_for_test:
        p = binds.get(n)
        if not p:
            print("no path for", n)
            continue
        paths.append(p)
    split.apply_edits(LIB, prod_edits)
    text = open(LIB).read()
    # drop attribute lines left dangling on removed uses
    text = re.sub(r"^#\[cfg\([^\n]*\)\]\n(?=(?:#\[cfg\([^\n]*\)\]\n)*(?:\n|//|#\[cfg\(test\)\]\nuse |mod |pub |fn |use ))", lambda m: m.group(0), text, flags=re.M)
    if paths:
        block = "".join(f"#[cfg(test)]\nuse {p};\n" for p in paths)
        tag = "// @moved-reexports-end\n"
        if tag in text:
            text = text.replace(tag, block + tag, 1)
        else:
            m = re.search(r"^use ", text, re.M)
            text = text[: m.start()] + block + text[m.start():]
    open(LIB, "w").write(text)
    print(f"removed {len(prod)} unused prod imports; {len(paths)} kept behind cfg(test)")


main()
