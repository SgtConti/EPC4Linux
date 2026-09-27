#!/usr/bin/env bash
# Deobfuscate (.NET Reactor) the vendor assemblies with a patched NETReactorSlayer, then decompile with ilspycmd.
# Output: work/dotnet-clean/<Assembly>/  (C# projects)
set -uo pipefail
source "$(dirname "$0")/wslenv.sh"
NRS=~/tools/NETReactorSlayer
python3 "$REPO/tools/patch_netreactorslayer.py" "$NRS"
(cd "$NRS" && dotnet build NETReactorSlayer.CLI/NETReactorSlayer.CLI.csproj -c Release -p:TargetFrameworks=net8.0 -p:RollForward=Major -v q -nologo 2>&1 | grep -E "error|Build succeeded" | head -5)
SLAYER=$NRS/bin/Release/net8.0/NETReactorSlayer.CLI
BIN="$REPO/Evnia Precision Center/resources/bin"
STAGE=~/work/slayed; OUT="$REPO/work/dotnet-clean"
rm -rf "$STAGE"; mkdir -p "$STAGE/final" "$OUT"
cp "$BIN"/*.dll "$STAGE"/
# Clear COR_FLAGS 32BITREQUIRED so x86-only IL assemblies can be reflection-loaded in x64.
python3 - "$STAGE" <<'PY'
import struct, sys, glob
for p in glob.glob(sys.argv[1] + "/*.dll"):
    b = bytearray(open(p, "rb").read())
    try:
        pe = struct.unpack_from("<I", b, 0x3c)[0]
        if b[pe:pe+4] != b"PE\0\0": continue
        opt = pe + 24; magic = struct.unpack_from("<H", b, opt)[0]
        dd = opt + (96 if magic == 0x10b else 112)
        rva, size = struct.unpack_from("<II", b, dd + 14 * 8)
        if not rva: continue
        nsec = struct.unpack_from("<H", b, pe + 6)[0]; soh = struct.unpack_from("<H", b, pe + 20)[0]
        for i in range(nsec):
            s = opt + soh + i * 40
            vs, va, _, raw = struct.unpack_from("<IIII", b, s + 8)
            if va <= rva < va + max(vs, 1):
                off = rva - va + raw; fl = struct.unpack_from("<I", b, off + 16)[0]
                if fl & 2:
                    struct.pack_into("<I", b, off + 16, fl & ~2); open(p, "wb").write(b)
                break
    except Exception as e:
        print("skip", p, e)
PY
TARGETS=$(cd "$BIN" && ls EvniaServe.dll Zeasn.*.dll Bridge.Lib.dll NuGet.Lib.dll ManagedNativeWifi.dll)
for t in $TARGETS; do
  n=${t%.dll}
  (cd "$STAGE" && timeout 600 "$SLAYER" "$STAGE/$n.dll" --no-pause true >"$STAGE/$n.slayer.log" 2>&1 </dev/null)
  rc=$?
  if [ ! -f "$STAGE/${n}_Slayed.dll" ]; then
    # Fall back to no string decryption if the dynamic path still crashes
    (cd "$STAGE" && timeout 600 "$SLAYER" "$STAGE/$n.dll" --no-pause true --dec-strings false >"$STAGE/$n.slayer2.log" 2>&1 </dev/null)
    echo "$n: rc=$rc -> fallback(no-strings) $( [ -f "$STAGE/${n}_Slayed.dll" ] && echo ok || echo FAIL)"
  else
    echo "$n: $(grep -hoE '[0-9]+ Strings decrypted|Couldn.t find any encrypted string|Couldn.t load assembly using reflection' "$STAGE/$n.slayer.log" | tr '\n' ';')"
  fi
done
cp "$STAGE"/*.dll "$STAGE/final/" 2>/dev/null
for t in $TARGETS; do n=${t%.dll}; [ -f "$STAGE/${n}_Slayed.dll" ] && cp "$STAGE/${n}_Slayed.dll" "$STAGE/final/$n.dll"; done
rm -f "$STAGE"/final/*_Slayed.dll
for t in $TARGETS; do
  n=${t%.dll}; rm -rf "$OUT/$n"
  ilspycmd -p -r "$STAGE/final" -o "$OUT/$n" "$STAGE/final/$n.dll" >"$STAGE/$n.ilspy.log" 2>&1 || echo "ILSPY-FAIL $n"
done
echo done
