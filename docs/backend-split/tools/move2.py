#!/usr/bin/env python3
"""Move contiguous stretches of lib.rs into module files.

Usage: move2.py SPEC.json
SPEC: {"mods": {"git": {"doc": [...], "children": ["commands", ...]}},   # creates <dir>/mod.rs if missing
       "files": {"git/commands.rs": {"doc": [...], "ranges": [["fn git_status", "fn first_error_line"], ...]}}}
Each range covers everything from the first selector's leading attributes/comments
through the end of the last selector's item, inclusive.
Adds a root `use` re-export for every moved top-level item, rewrites
generate_handler! entries for moved #[tauri::command] fns, and adds `mod` lines.
"""
import json, re, sys, os

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
SRC = "/Users/wytze/Gyro/apps/desktop/src-tauri/src"
LIB = os.path.join(SRC, "lib.rs")

VIS = r"(?:pub(?:\([^)]*\))? )?"


def start_regex(sel):
    kind, rest = sel.split(" ", 1)
    if kind == "fn":
        return re.compile(rf"^{VIS}(?:async )?fn {re.escape(rest)}\b")
    if kind in ("struct", "enum", "const", "static", "type", "trait", "mod"):
        return re.compile(rf"^{VIS}{kind} {re.escape(rest)}\b")
    if kind == "impl":
        return re.compile(rf"^impl(?:<[^>]*>)? {re.escape(rest)}(?:<[^>]*>)? \{{")
    if kind == "impl-for":
        trait, ty = rest.split(" ", 1)
        return re.compile(rf"^impl(?:<[^>]*>)? (?:[\w:]+::)?{re.escape(trait)}(?:<[^>]*>)? for {re.escape(ty)}\b")
    raise SystemExit(f"bad selector {sel}")


def item_end(lines, i, kind):
    line = lines[i]
    if kind in ("const", "static", "type"):
        depth = 0
        for j in range(i, len(lines)):
            depth += sum(lines[j].count(c) for c in "({[") - sum(lines[j].count(c) for c in ")}]")
            if depth == 0 and lines[j].rstrip().endswith(";"):
                return j
        raise SystemExit("no end")
    s = line.rstrip()
    if s.endswith(";") or (s.endswith("}") and line.count("{") == line.count("}")):
        return i
    for j in range(i + 1, len(lines)):
        if lines[j].startswith("}"):
            return j
    raise SystemExit("no end")


def find(lines, sel, nth=None):
    last = sel.endswith("@last")
    sel = sel.removesuffix("@last")
    rx = start_regex(sel)
    hits = [i for i, l in enumerate(lines) if rx.match(l)]
    if len(hits) != 1 and not (last and hits):
        raise SystemExit(f"selector {sel!r}: {len(hits)} matches at {[h+1 for h in hits[:5]]}")
    i = hits[-1] if last else hits[0]
    start = i
    while start > 0 and (lines[start - 1].startswith("#[") or lines[start - 1].startswith("//")):
        start -= 1
    return start, item_end(lines, i, sel.split()[0])


TOP = re.compile(r"^(?:(pub(?:\([^)]*\))?) )?(async fn|fn|struct|enum|const|static|type|trait) (\w+)")


def publicize(chunk):
    out = []
    ctx = None
    for l in chunk.split("\n"):
        if l and not l.startswith(" ") and not l.startswith("\t"):
            m = TOP.match(l)
            if m and not m.group(1):
                l = "pub(crate) " + l
            if re.match(rf"^{VIS}struct \w+(?:<[^>]*>)?(?: where [^{{]*)? \{{", l):
                ctx = "struct"
            elif re.match(r"^impl\b.* for ", l):
                ctx = "traitimpl"
            elif re.match(r"^impl\b", l):
                ctx = "impl"
            elif l.startswith("}"):
                ctx = None
            elif not (l.startswith("#") or l.startswith("//")):
                ctx = "other"
            out.append(l)
            continue
        if ctx == "struct" and re.match(r"^    (?:r#)?[a-z_][a-z0-9_]*: ", l):
            l = "    pub(crate) " + l[4:]
        elif ctx == "impl" and re.match(r"^    (?:const |unsafe )?(?:async )?fn ", l):
            l = "    pub(crate) " + l[4:]
        elif ctx == "impl" and re.match(r"^    const [A-Z_]", l):
            l = "    pub(crate) " + l[4:]
        out.append(l)
    text = "\n".join(out)
    # tuple structs: struct Foo(Type);
    text = re.sub(r"^(pub\(crate\) struct \w+(?:<[^>]*>)?)\(([^()]*?)\);", lambda m: m.group(1) + "(" + ", ".join(("pub(crate) " + p.strip()) if not p.strip().startswith("pub") else p.strip() for p in m.group(2).split(",") if p.strip()) + ");", text, flags=re.M)
    return text


def top_items(chunk):
    """[(name, cfg_attrs, is_command)] for top-level items in chunk."""
    lines = chunk.split("\n")
    res = []
    depth_mod = False
    for i, l in enumerate(lines):
        m = TOP.match(l)
        if not m:
            continue
        attrs = []
        k = i - 1
        while k >= 0 and (lines[k].startswith("#[") or lines[k].startswith("//")):
            attrs.append(lines[k])
            k -= 1
        cfgs = [a for a in attrs if a.startswith("#[cfg(")]
        cmd = any(a.startswith("#[tauri::command") for a in attrs)
        res.append((m.group(3), cfgs, cmd))
    return res


def main():
    spec = json.load(open(sys.argv[1]))
    lines = open(LIB).read().split("\n")
    taken = {}
    plans = []
    for path, f in spec["files"].items():
        for a, b in f["ranges"]:
            s, _ = find(lines, a)
            _, e = find(lines, b)
            if e < s:
                raise SystemExit(f"range {a}..{b} reversed")
            for k in range(s, e + 1):
                if k in taken:
                    raise SystemExit(f"overlap {a}..{b} with {taken[k]} at line {k+1}")
                taken[k] = f"{a}..{b}"
            plans.append((path, s, e))
    reexports = []
    commands = {}
    for path, f in spec["files"].items():
        chunks = []
        for p, s, e in sorted(plans, key=lambda x: x[1]):
            if p != path:
                continue
            chunk = "\n".join(lines[s : e + 1]).strip("\n")
            chunks.append(publicize(chunk))
        body = "\n\n".join(chunks) + "\n"
        modpath = path[:-3].replace("/mod", "").replace("/", "::")
        for name, cfgs, cmd in top_items(body):
            reexports.append((modpath, name, cfgs))
            if cmd:
                commands[name] = modpath
        doc = "".join(f"//! {d}\n" if d else "//!\n" for d in f.get("doc", []))
        full = os.path.join(SRC, path)
        os.makedirs(os.path.dirname(full), exist_ok=True)
        if os.path.exists(full):
            old = open(full).read().rstrip("\n")
            open(full, "w").write(old + "\n\n" + body)
        else:
            open(full, "w").write(doc + ("\n" if doc else "") + body)
        print(f"wrote {path}: {len(chunks)} ranges, {sum(e-s+1 for p,s,e in plans if p==path)} lines")
    kept = [l for i, l in enumerate(lines) if i not in taken]
    text = "\n".join(kept)
    text = re.sub(r"\n{3,}", "\n\n", text)
    # handler paths
    if commands:
        a = text.index("tauri::generate_handler![")
        b = text.index("])", a)
        block = text[a:b]
        for n, mp in commands.items():
            new, cnt = re.subn(rf"(\n\s+){re.escape(n)},", rf"\g<1>{mp}::{n},", block)
            if cnt != 1:
                print(f"WARN handler {n}: {cnt} entries")
            block = new
        text = text[:a] + block + text[b:]
    # mod declarations
    mods_needed = {}
    for path in spec["files"]:
        parts = path[:-3].split("/")
        if len(parts) == 1:
            mods_needed.setdefault(parts[0], None)
        else:
            mods_needed.setdefault(parts[0], set()).add(parts[1])
    for top, children in mods_needed.items():
        if not re.search(rf"^(?:pub\(crate\) )?mod {top};", text, re.M):
            text = text.replace("\nmod agent_session_worker;", f"\nmod agent_session_worker;\nmod {top};", 1) if text.startswith("mod") is False else re.sub(r"\A", f"mod {top};\n", text, count=1)
        if children:
            mp = os.path.join(SRC, top, "mod.rs")
            existing = open(mp).read() if os.path.exists(mp) else ""
            doc = spec.get("mods", {}).get(top, {}).get("doc", [])
            if not existing:
                existing = "".join(f"//! {d}\n" if d else "//!\n" for d in doc) + ("\n" if doc else "") + "#![deny(clippy::wildcard_imports)]\n\n"
            for c in sorted(children):
                if c == "mod":
                    continue
                if not re.search(rf"^pub\(crate\) mod {c};", existing, re.M):
                    existing = existing.rstrip("\n") + f"\npub(crate) mod {c};\n"
            open(mp, "w").write(existing)
    # root re-exports, tagged for later pruning
    tag_a, tag_b = "// @moved-reexports-start\n", "// @moved-reexports-end\n"
    lines_out = []
    for mp, name, cfgs in reexports:
        for c in cfgs:
            lines_out.append(c + "\n")
        lines_out.append(f"use {mp}::{name};\n")
    if tag_a in text:
        i = text.index(tag_b)
        text = text[:i] + "".join(lines_out) + text[i:]
    else:
        m = re.search(r"^use ", text, re.M)
        text = text[: m.start()] + tag_a + "".join(lines_out) + tag_b + text[m.start():]
    open(LIB, "w").write(text)
    print("lib.rs lines:", text.count("\n"), "| reexports:", len(reexports), "| commands:", len(commands))


main()
