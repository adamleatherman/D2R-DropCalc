#!/usr/bin/env python3
"""Extract the game tables straight from the installed D2R CASC archive (read-only on the game folder).

Usage:  python tools/extract_tables.py [out-folder] [--game "C:\\Program Files (x86)\\Diablo II Resurrected"] [--force]
Default out-folder: C:\\Users\\thein\\D2R-excel. Refuses to write into a non-empty folder unless --force.
Only the Python standard library is used.

Output layout (what build.py expects):
    <out>\\*.txt, *.bin                      data/global/excel/*        Reign of the Warlock tables (root)
    <out>\\base\\*.txt, *.bin                data/global/excel/base/*   Lord of Destruction tables
    <out>\\hd\\desecratedzones.json          data/hd/global/excel/desecratedzones.json

How it finds the files: .build.info (pipe separated, the Active=1 row) gives the Build Key and Version; Data\\config\\xx\\yy\\<Build Key>
lists vfs-root, vfs-1 .. vfs-N as "<content key> <encoding key>". Each vfs is a TVFS (path tree -> EKeys) stored as one BLTE blob in
Data\\data\\data.000-data.0NN. Every stored blob is a 30-byte header (first 16 bytes = EKey reversed, entry size LE uint32 at offset 16)
followed by 'BLTE'; chunks are mode Z (zlib) or N (raw). TVFS layout follows CascLib's parser.
"""
import mmap
import os
import re
import shutil
import struct
import sys
import zlib

WANTED = [
    (re.compile(r"data/global/excel/(?:base/)?[^/]+\.(?:txt|bin)", re.I), lambda p: p[len("data/global/excel/"):]),
    (re.compile(r"data/hd/global/excel/desecratedzones\.json", re.I), lambda p: "hd/desecratedzones.json"),
]


def parse_build_info(game):
    """-> the Active=1 row of .build.info as a dict (header 'Name!TYPE:n|...', one row per branch)."""
    with open(os.path.join(game, ".build.info"), encoding="utf-8") as f:
        lines = [l.rstrip("\r\n") for l in f if l.strip()]
    head = [h.split("!")[0] for h in lines[0].split("|")]
    rows = [dict(zip(head, l.split("|"))) for l in lines[1:]]
    act = [r for r in rows if r.get("Active") == "1"]
    if not act:
        sys.exit("no Active=1 row in .build.info")
    return act[0]


def read_config(game, key):
    path = os.path.join(game, "Data", "config", key[:2], key[2:4], key)
    if not os.path.isfile(path):
        sys.exit("build config not found: " + path)
    cfg = {}
    with open(path, encoding="utf-8") as f:
        for l in f:
            if "=" in l:
                k, v = l.split("=", 1)
                cfg[k.strip()] = v.strip()
    return cfg


def blte_decode(mm, pos):
    """Decode the BLTE blob whose magic is at pos -> bytes. The 30-byte entry header precedes it."""
    hsize = struct.unpack(">I", mm[pos + 4:pos + 8])[0]
    if hsize == 0:   # single raw chunk, no chunk table: size comes from the entry header
        esize = struct.unpack("<I", mm[pos - 14:pos - 10])[0]
        chunks, data = [esize - 30 - 8], pos + 8
    else:
        count = int.from_bytes(mm[pos + 9:pos + 12], "big")
        chunks = [struct.unpack(">I", mm[pos + 12 + 24 * i:pos + 16 + 24 * i])[0] for i in range(count)]
        data = pos + hsize   # header size counts the 8-byte magic + size field
    out = []
    for c in chunks:
        mode, body = mm[data:data + 1], mm[data + 1:data + c]
        if mode == b"Z":
            out.append(zlib.decompress(body))
        elif mode == b"N":
            out.append(bytes(body))
        else:
            raise ValueError("unsupported BLTE chunk mode %r" % mode)
        data += c
    return b"".join(out)


def tvfs_files(b):
    """Parse a decoded TVFS blob -> {path: [EKey prefix (9 bytes), ...]} (path prefix tree -> VFS span table -> container file table)."""
    if b[:4] != b"TVFS":
        raise ValueError("not a TVFS blob")
    ekey_size = b[6]
    pt_off, pt_size, vfs_off, vfs_size, cft_off, cft_size = struct.unpack(">6I", b[12:36])
    cft_ofs_size = 4 if cft_size > 0xFFFFFF else 3 if cft_size > 0xFFFF else 2 if cft_size > 0xFF else 1

    def ekeys_for(rel):
        p = vfs_off + rel
        spans = b[p]
        p += 1
        keys = []
        for _ in range(spans):
            p += 8   # file offset + span size
            c = int.from_bytes(b[p:p + cft_ofs_size], "big")
            p += cft_ofs_size
            keys.append(b[cft_off + c:cft_off + c + ekey_size][:9])
        return keys

    out = {}

    def walk(p, end, path):
        save = path
        while p < end:
            if b[p] == 0:
                path += "/"
                p += 1
            if p < end and b[p] != 0xFF:
                n = b[p]
                path += b[p + 1:p + 1 + n].decode("utf-8", "replace")
                p += 1 + n
            if p < end and b[p] == 0:
                path += "/"
                p += 1
            if p < end and b[p] == 0xFF:
                v = struct.unpack(">I", b[p + 1:p + 5])[0]
                p += 5
                if v & 0x80000000:
                    size = v & 0x7FFFFFFF
                    walk(p, p + size - 4, path)
                    p += size - 4
                else:
                    out[path] = ekeys_for(v)
            path = save

    walk(pt_off, pt_off + pt_size, "")
    return out


def main():
    args = sys.argv[1:]
    force = "--force" in args
    game = r"C:\Program Files (x86)\Diablo II Resurrected"
    if "--game" in args:
        i = args.index("--game")
        game = args[i + 1]
        del args[i:i + 2]
    args = [a for a in args if a != "--force"]
    out = args[0] if args else r"C:\Users\thein\D2R-excel"

    if os.path.isdir(out) and os.listdir(out) and not force:
        sys.exit("output folder %s is not empty; pass --force to write into it (files with the same name are overwritten)" % out)

    info = parse_build_info(game)
    print("game version %s (build key %s)" % (info.get("Version", "?"), info["Build Key"]))
    cfg = read_config(game, info["Build Key"])
    vfs = [(k, cfg[k].split()[1]) for k in cfg if re.fullmatch(r"vfs-(?:root|\d+)", k)]
    if not vfs:
        sys.exit("no vfs-* entries in the build config")

    # one pass over the data files: EKey (first 9 bytes of the reversed 16) -> (file, offset of 'BLTE')
    ddir = os.path.join(game, "Data", "data")
    files = sorted(f for f in os.listdir(ddir) if re.fullmatch(r"data\.\d{3}", f))
    mms, loc = {}, {}
    for name in files:
        fh = open(os.path.join(ddir, name), "rb")
        mm = mms[name] = mmap.mmap(fh.fileno(), 0, access=mmap.ACCESS_READ)
        pos = mm.find(b"BLTE")
        while pos >= 0:
            if pos >= 30:
                loc.setdefault(mm[pos - 30:pos - 14][::-1][:9], (name, pos))
            pos = mm.find(b"BLTE", pos + 4)
    print("indexed %d blobs in %d data files" % (len(loc), len(files)))

    paths, seen = {}, set()
    for name, ekey in vfs:
        k = bytes.fromhex(ekey)[:9]
        if k in seen:
            continue   # vfs-root and vfs-1 can be the same blob
        seen.add(k)
        if k not in loc:
            sys.exit("%s (EKey %s) not found in the data files" % (name, ekey))
        found = tvfs_files(blte_decode(mms[loc[k][0]], loc[k][1]))
        print("%s: %d paths" % (name, len(found)))
        paths.update(found)

    todo = {}
    for p, keys in paths.items():
        for rx, rel in WANTED:
            if rx.fullmatch(p):
                todo[rel(p)] = keys
                break
    if not todo:
        sys.exit("no table paths found in the archive (is this a D2R install?)")

    # decode everything into a staging folder first so a failure leaves the output folder untouched
    staged = out.rstrip("\\/") + ".partial"
    if os.path.exists(staged):
        shutil.rmtree(staged)
    for rel, keys in sorted(todo.items()):
        try:
            blob = b"".join(blte_decode(mms[loc[k][0]], loc[k][1]) for k in keys)
        except (KeyError, ValueError) as e:
            sys.exit("cannot extract %s: %r" % (rel, e))
        dst = os.path.join(staged, *rel.split("/"))
        os.makedirs(os.path.dirname(dst), exist_ok=True)
        with open(dst, "wb") as g:
            g.write(blob)
    for root, _, fs in os.walk(staged):
        for f in fs:
            src = os.path.join(root, f)
            dst = os.path.join(out, os.path.relpath(src, staged))
            os.makedirs(os.path.dirname(dst), exist_ok=True)
            shutil.move(src, dst)
    shutil.rmtree(staged)
    print("extracted %d files into %s (game version %s)" % (len(todo), out, info.get("Version", "?")))


if __name__ == "__main__":
    main()
