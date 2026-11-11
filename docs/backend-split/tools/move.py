#!/usr/bin/env python3
"""Move top-level items from lib.rs into module files.

Usage: move.py SPEC.json
SPEC: {"files": {"automation/commands.rs": {"doc": "...", "items": ["fn list_automations", ...]}},
       "handler_prefix": {"automation::commands": ["list_automations", ...]}}
Item selectors: "<kind> <name>" where kind in fn, struct, enum, const, static, impl, impl-for
  ("impl Foo" = inherent impl, "impl-for Drop Foo" = trait impl).
"""
import json, re, sys, os

SRC = "/Users/wytze/Gyro/apps/desktop/src-tauri/src"
LIB = os.path.join(SRC, "lib.rs")

VIS = r"(?:pub(?:\([^)]*\))? )?"


def start_regex(sel):
    kind, rest = sel.split(" ", 1)
    if kind == "fn":
        return re.compile(rf"^{VIS}(?:async )?fn {re.escape(rest)}\b")
    if kind in ("struct", "enum", "const", "static", "type", "trait"):
        return re.compile(rf"^{VIS}{kind} {re.escape(rest)}\b")
    if kind == "impl":
        return re.compile(rf"^impl(?:<[^>]*>)? {re.escape(rest)}(?:<[^>]*>)? \{{")
    if kind == "impl-for":
        trait, ty = rest.split(" ", 1)
        return re.compile(rf"^impl(?:<[^>]*>)? (?:[\w:]+::)?{re.escape(trait)}(?:<[^>]*>)? for {re.escape(ty)}\b")
    raise SystemExit(f"bad selector {sel}")


def find_item(lines, sel):
    rx = start_regex(sel)
    hits = [i for i, l in enumerate(lines) if rx.match(l)]
    if len(hits) != 1:
        raise SystemExit(f"selector {sel!r}: {len(hits)} matches {hits[:5]}")
    i = hits[0]
    start = i
    while start > 0 and (lines[start - 1].startswith("#[") or lines[start - 1].startswith("///") or lines[start - 1].startswith("//")):
        start -= 1
    # end
    kind = sel.split()[0]
    line = lines[i]
    if kind in ("const", "static"):
        depth = 0
        for j in range(i, len(lines)):
            depth += sum(lines[j].count(c) for c in "({[") - sum(lines[j].count(c) for c in ")}]")
            if depth == 0 and lines[j].rstrip().endswith(";"):
                return start, j
        raise SystemExit(f"no end for {sel}")
    if line.rstrip().endswith(";") or (line.rstrip().endswith("}") and line.count("{") == line.count("}")):
        return start, i
    for j in range(i + 1, len(lines)):
        if lines[j].startswith("}"):
            return start, j
    raise SystemExit(f"no end for {sel}")
    return start, end


def publicize(text, kind):
    out = []
    lines = text.split("\n")
    depth_impl_trait = False
    for idx, l in enumerate(lines):
        # top-level items
        m = re.match(r"^(async fn |fn |struct |enum |const |static |type |trait )", l)
        if m:
            l = "pub(crate) " + l
        out.append(l)
    text = "\n".join(out)
    return text


def publicize_members(text):
    """pub(crate) for struct fields and inherent-impl methods (4-space indent)."""
    lines = text.split("\n")
    out = []
    ctx = None  # 'struct', 'impl', 'traitimpl', 'enum', 'other'
    for l in lines:
        if not l.startswith(" ") and l.strip():
            if re.match(rf"^{VIS}struct \w+(?:<[^>]*>)? \{{", l):
                ctx = "struct"
            elif re.match(r"^impl(?:<[^>]*>)? [\w:<>, ]+ for ", l):
                ctx = "traitimpl"
            elif re.match(r"^impl\b", l):
                ctx = "impl"
            elif l.startswith("}"):
                ctx = None
            else:
                ctx = "other" if l.rstrip().endswith("{") else ctx if ctx else None
            out.append(l)
            continue
        if ctx == "struct" and re.match(r"^    [a-z_][a-z0-9_]*: ", l):
            l = "    pub(crate) " + l[4:]
        elif ctx == "impl" and re.match(r"^    (?:const )?(?:async )?fn ", l):
            l = "    pub(crate) " + l[4:]
        elif ctx == "impl" and re.match(r"^    const [A-Z_]", l):
            l = "    pub(crate) " + l[4:]
        out.append(l)
    return "\n".join(out)


def main():
    spec = json.load(open(sys.argv[1]))
    lines = open(LIB).read().split("\n")
    taken = {}
    for path, f in spec["files"].items():
        for sel in f["items"]:
            s, e = find_item(lines, sel)
            for k in range(s, e + 1):
                if k in taken:
                    raise SystemExit(f"overlap {sel} with {taken[k]}")
                taken[k] = sel
            f.setdefault("_ranges", []).append((s, e, sel))
    for path, f in spec["files"].items():
        chunks = []
        for s, e, sel in sorted(f["_ranges"]):
            chunk = "\n".join(lines[s : e + 1])
            chunk = publicize(chunk, sel)
            chunk = publicize_members(chunk)
            chunks.append(chunk)
        body = "\n\n".join(chunks) + "\n"
        doc = "".join(f"//! {d}\n" if d else "//!\n" for d in f.get("doc", []))
        full = os.path.join(SRC, path)
        os.makedirs(os.path.dirname(full), exist_ok=True)
        open(full, "w").write(doc + ("\n" if doc else "") + body)
        print(f"wrote {path}: {len(f['_ranges'])} items")
    # remove from lib.rs, collapsing blank runs
    kept = [l for i, l in enumerate(lines) if i not in taken]
    text = "\n".join(kept)
    text = re.sub(r"\n{3,}", "\n\n", text)
    # generate_handler paths
    for prefix, names in spec.get("handler_prefix", {}).items():
        a = text.index("tauri::generate_handler![")
        b = text.index("]", a)
        block = text[a:b]
        for n in names:
            new, cnt = re.subn(rf"(\n\s+){re.escape(n)},", rf"\g<1>{prefix}::{n},", block)
            if cnt != 1:
                raise SystemExit(f"handler {n}: {cnt}")
            block = new
        text = text[:a] + block + text[b:]
    open(LIB, "w").write(text)
    print("lib.rs lines:", text.count("\n"))


main()
