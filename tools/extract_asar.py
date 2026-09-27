#!/usr/bin/env python3
"""Extract an Electron app.asar archive (no Node required).

Usage: extract_asar.py <app.asar> <outdir>
Files marked "unpacked" are copied from <app.asar>.unpacked if present.
"""
import json, os, shutil, struct, sys


def main(asar_path, out_dir):
    with open(asar_path, "rb") as f:
        _, header_pickle_size, _, json_len = struct.unpack("<4I", f.read(16))
        header = json.loads(f.read(json_len).decode("utf-8"))
        base = 8 + header_pickle_size
        unpacked_root = asar_path + ".unpacked"
        count = 0

        def walk(node, rel):
            nonlocal count
            for name, entry in node.get("files", {}).items():
                path = os.path.join(rel, name)
                dest = os.path.join(out_dir, path)
                if "files" in entry:
                    os.makedirs(dest, exist_ok=True)
                    walk(entry, path)
                elif "link" in entry:
                    continue
                elif entry.get("unpacked"):
                    src = os.path.join(unpacked_root, path)
                    if os.path.exists(src):
                        os.makedirs(os.path.dirname(dest), exist_ok=True)
                        shutil.copyfile(src, dest)
                        count += 1
                else:
                    f.seek(base + int(entry["offset"]))
                    os.makedirs(os.path.dirname(dest), exist_ok=True)
                    with open(dest, "wb") as o:
                        o.write(f.read(entry["size"]))
                    count += 1

        walk(header, "")
    print(f"extracted {count} files to {out_dir}")


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2])
