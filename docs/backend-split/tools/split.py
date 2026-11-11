#!/usr/bin/env python3
"""Helpers for moving code out of apps/desktop/src-tauri/src/lib.rs.

Subcommands:
  diag                 run cargo check (all targets) and save diagnostics JSON
  baseline             save current warning keys as the pre-move baseline
  imports FILE...      add missing imports to FILE(s) from rustc suggestions, repeat
  prune FILE...        drop unused imports (not in baseline) in FILE(s) via rustc edits
  report               print error/warning summary (new warnings only)
"""
import json, os, re, subprocess, sys, collections

ROOT = "/Users/wytze/Gyro"
CRATE = "apps/desktop/src-tauri"
SRC = f"{CRATE}/src"
HERE = os.path.dirname(os.path.abspath(__file__))
BASELINE = os.path.join(HERE, "warn-baseline.json")
LIB = os.path.join(ROOT, SRC, "lib.rs")

IMPORT_CODES = {"E0425", "E0412", "E0433", "E0422", "E0423", "E0531", "E0532", "E0405", "E0574", "E0408"}


def run_check():
    cmd = ["cargo", "check", "-p", "gyro-desktop", "--all-targets", "--locked", "--message-format=json"]
    p = subprocess.run(cmd, cwd=ROOT, capture_output=True, text=True)
    msgs = []
    for line in p.stdout.splitlines():
        try:
            o = json.loads(line)
        except Exception:
            continue
        if o.get("reason") == "compiler-message":
            msgs.append(o["message"])
    return msgs


def primary(m):
    for s in m.get("spans", []):
        if s.get("is_primary"):
            return s
    return (m.get("spans") or [None])[0]


def key(m):
    s = primary(m)
    f = s["file_name"] if s else ""
    return f"{m['level']}|{f}|{m['message']}"


def lib_bindings():
    """Map name -> full path for names lib.rs imports with `use` (flattened)."""
    text = open(LIB).read()
    out = {}
    for m in re.finditer(r"^(?:pub\(crate\) )?use ([^;]+);", text, re.M | re.S):
        for path in flatten(m.group(1)):
            if " as " in path:
                p, alias = [x.strip() for x in path.split(" as ")]
                if alias != "_":
                    out[alias] = p
                continue
            name = path.rsplit("::", 1)[-1]
            if name in ("*", "self"):
                continue
            out[name] = path
    return out


def flatten(tree, prefix=""):
    tree = re.sub(r"\s+", " ", tree).strip()
    # split top-level on '::{'
    depth = 0
    i = tree.find("{")
    if i == -1:
        return [prefix + tree]
    head = tree[:i]
    body = tree[i + 1 : tree.rfind("}")]
    parts, cur = [], ""
    for ch in body:
        if ch == "{":
            depth += 1
        elif ch == "}":
            depth -= 1
        if ch == "," and depth == 0:
            parts.append(cur)
            cur = ""
        else:
            cur += ch
    parts.append(cur)
    res = []
    for part in parts:
        part = part.strip()
        if not part:
            continue
        if part == "self":
            res.append((prefix + head).rstrip(":"))
            continue
        res.extend(flatten(part, prefix + head))
    return res


def candidate_paths(m):
    out = []
    for c in m.get("children", []):
        for s in c.get("spans", []):
            r = s.get("suggested_replacement")
            if r and r.lstrip().startswith("use "):
                out.append((s, r))
    return out


def missing_name(m):
    mm = re.search(r"`([^`]+)`", m["message"])
    return mm.group(1) if mm else None


def local_mods():
    """Module names declared with `mod x;` in lib.rs (paths starting with these need `crate::`)."""
    return set(re.findall(r"^(?:pub(?:\([^)]*\))? )?mod (\w+)\s*[;{]", open(LIB).read(), re.M))


def choose(name, cands, binds):
    paths = [(s, r, r.strip()[4:].rstrip(";").strip()) for s, r in cands]
    if not paths:
        if name in binds:
            path = binds[name]
            first = path.split("::", 1)[0]
            if first in local_mods():
                path = f"crate::{path}"
            return (None, None, path)
        if re.search(rf"^(?:pub\(crate\) )?(?:async )?(?:fn|struct|enum|const|static|type|trait) {re.escape(name)}\b", open(LIB).read(), re.M):
            return (None, None, f"crate::{name}")
        return None
    want = binds.get(name)
    if want:
        for p in paths:
            if p[2] == want:
                return p
        for p in paths:
            if p[2] == f"crate::{name}":
                return p
    crate_root = [p for p in paths if p[2] == f"crate::{name}"]
    if crate_root:
        return crate_root[0]
    crate_any = [p for p in paths if p[2].startswith("crate::")]
    if len(crate_any) == 1:
        return crate_any[0]
    if len(paths) == 1:
        return paths[0]
    return ("AMBIG", name, [p[2] for p in paths])


def insert_point(path):
    """Byte offset after the leading //! docs, attributes and existing use block."""
    data = open(path, "rb").read()
    lines = data.split(b"\n")
    off = 0
    last_use_end = None
    i = 0
    while i < len(lines):
        ln = lines[i]
        st = ln.strip()
        if st.startswith(b"//!") or st.startswith(b"#![") or st == b"":
            off += len(ln) + 1
            i += 1
            continue
        break
    return off


def apply_edits(path, edits):
    data = open(path, "rb").read()
    for start, end, text in sorted(set(edits), key=lambda e: (e[0], e[1]), reverse=True):
        data = data[:start] + text.encode() + data[end:]
    open(path, "wb").write(data)


def cmd_imports(files):
    files = [os.path.abspath(os.path.join(ROOT, f)) for f in files]
    binds = lib_bindings()
    for rnd in range(8):
        msgs = run_check()
        json.dump(msgs, open(os.path.join(HERE, "last-diag.json"), "w"))
        per_file = collections.defaultdict(dict)
        ambig = {}
        unresolved = set()
        for m in msgs:
            if m["level"] != "error":
                continue
            s = primary(m)
            if not s:
                continue
            f = os.path.abspath(os.path.join(ROOT, s["file_name"]))
            if f not in files:
                continue
            code = (m.get("code") or {}).get("code")
            cands = candidate_paths(m)
            if code == "E0599" or (cands and code not in IMPORT_CODES):
                # trait not in scope: suggestions are `use path::Trait;`
                for sp, r in cands:
                    path_ = r.strip()[4:].rstrip(";").strip()
                    tname = path_.rsplit("::", 1)[-1]
                    want = binds.get(tname)
                    if want is None or want == path_ or "as _" in path_:
                        per_file[f][path_] = 1
                        break
                continue
            if code not in IMPORT_CODES:
                continue
            name = missing_name(m)
            if not name:
                continue
            pick = choose(name, cands, binds)
            if pick is None:
                unresolved.add((os.path.relpath(f, ROOT), name, code, m["message"]))
            elif pick[0] == "AMBIG":
                ambig[name] = pick[2]
            else:
                per_file[f][pick[2]] = 1
        if ambig:
            print("AMBIGUOUS:", json.dumps(ambig, indent=1))
        if not per_file:
            print(f"round {rnd}: no import fixes")
            for u in sorted(unresolved):
                print("UNRESOLVED", u)
            return
        for f, paths in per_file.items():
            add_use_block(f, list(paths))
            print(f"round {rnd}: {os.path.relpath(f, ROOT)} +{len(paths)} imports")


def add_use_block(f, paths):
    """Merge new paths into the file's generated import block."""
    text = open(f).read()
    start_tag, end_tag = "// @split-imports-start\n", "// @split-imports-end\n"
    existing = []
    if start_tag in text:
        a = text.index(start_tag)
        b = text.index(end_tag) + len(end_tag)
        block = text[a + len(start_tag) : b - len(end_tag)]
        for m in re.finditer(r"use ([^;]+);", block, re.S):
            existing.extend(flatten(m.group(1)))
        text = text[:a] + text[b:]
        pos = a
    else:
        pos = insert_point(f)
        pos = len(open(f, "rb").read()[:pos].decode())
    allp = sorted(set(existing) | set(paths))
    block = start_tag + render(allp) + end_tag
    text = text[:pos] + block + text[pos:]
    open(f, "w").write(text)


def render(paths):
    tree = {}
    for p in paths:
        alias = None
        if " as " in p:
            p, alias = [x.strip() for x in p.split(" as ")]
        segs = p.split("::")
        node = tree
        for s in segs[:-1]:
            node = node.setdefault(s, {})
        leaf = segs[-1] + (f" as {alias}" if alias else "")
        node.setdefault("__leaves__", set()).add(leaf)
    lines = []
    for top in sorted(k for k in tree if k != "__leaves__"):
        lines.append(f"use {top}::{fmt(tree[top])};\n")
    return "".join(lines)


def fmt(node):
    items = []
    for leaf in node.get("__leaves__", ()):
        items.append(leaf)
    for k in node:
        if k == "__leaves__":
            continue
        items.append(f"{k}::{fmt(node[k])}")
    items = sorted(set(items), key=lambda x: (x != "self", x.lower()))
    if len(items) == 1:
        return items[0]
    return "{" + ", ".join(items) + "}"


def finalize(files):
    for f in files:
        f = os.path.abspath(os.path.join(ROOT, f))
        text = open(f).read()
        text = text.replace("// @split-imports-start\n", "").replace("// @split-imports-end\n", "")
        open(f, "w").write(text)


def cmd_baseline():
    msgs = run_check()
    keys = sorted({key(m) for m in msgs if m["level"] == "warning"})
    json.dump(keys, open(BASELINE, "w"), indent=1)
    errs = [m for m in msgs if m["level"] == "error"]
    print(f"baseline: {len(keys)} warning keys, {len(errs)} errors")


def cmd_prune(files):
    files = {os.path.abspath(os.path.join(ROOT, f)) for f in files}
    base = set(json.load(open(BASELINE)))
    for rnd in range(4):
        msgs = run_check()
        edits = collections.defaultdict(set)
        for m in msgs:
            if m["level"] != "warning" or key(m) in base:
                continue
            if (m.get("code") or {}).get("code") != "unused_imports":
                continue
            for c in m.get("children", []):
                for s in c.get("spans", []):
                    if s.get("suggested_replacement") is None:
                        continue
                    f = os.path.abspath(os.path.join(ROOT, s["file_name"]))
                    if f in files:
                        edits[f].add((s["byte_start"], s["byte_end"], s["suggested_replacement"]))
        if not edits:
            print(f"prune round {rnd}: nothing")
            return
        for f, e in edits.items():
            apply_edits(f, e)
            print(f"prune round {rnd}: {os.path.relpath(f, ROOT)} {len(e)} edits")


def cmd_report():
    msgs = run_check()
    base = set(json.load(open(BASELINE))) if os.path.exists(BASELINE) else set()
    errs = [m for m in msgs if m["level"] == "error"]
    new_w = [m for m in msgs if m["level"] == "warning" and key(m) not in base]
    seen = set()
    for m in errs + new_w:
        k = key(m) + str((primary(m) or {}).get("line_start"))
        if k in seen:
            continue
        seen.add(k)
        s = primary(m) or {}
        print(f"{m['level']}: {s.get('file_name')}:{s.get('line_start')}: {m['message']}")
    print(f"== {len(errs)} error diags, {len(new_w)} new warning diags")


if __name__ == "__main__":
    c = sys.argv[1]
    if c == "baseline":
        cmd_baseline()
    elif c == "imports":
        cmd_imports(sys.argv[2:])
    elif c == "prune":
        cmd_prune(sys.argv[2:])
    elif c == "finalize":
        finalize(sys.argv[2:])
    elif c == "report":
        cmd_report()
