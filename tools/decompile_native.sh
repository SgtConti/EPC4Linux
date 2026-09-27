#!/usr/bin/env bash
# Decompile the native vendor DLLs with Ghidra headless. Output: work/native/<dll>.c / .symbols.txt
set -uo pipefail
source "$(dirname "$0")/wslenv.sh"
G=~/tools/ghidra/support/analyzeHeadless
R="$REPO/Evnia Precision Center/resources"
OUT="$REPO/work/native"; PROJ=~/work/ghidra_proj; mkdir -p "$OUT" "$PROJ"
decomp() {
  local f="$1" n; n=$(basename "$f")
  [ -f "$OUT/$n.c" ] && { echo "skip $n"; return; }
  "$G" "$PROJ" "p_${n//[^A-Za-z0-9]/_}" -import "$f" -overwrite -scriptPath "$REPO/tools/ghidra_scripts" \
     -postScript DumpAll.java "$OUT" -deleteProject -max-cpu 4 >"$OUT/$n.ghidra.log" 2>&1
  grep -h "DumpAll:" "$OUT/$n.ghidra.log" || echo "FAIL $n"
}
export -f decomp; export G OUT PROJ REPO
ls "$R"/bin/lib/*/*.dll "$R"/bin/DDCHelperLib.dll "$R"/elevate.exe | xargs -P 4 -I{} bash -c 'decomp "{}"'
