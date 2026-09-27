#!/usr/bin/env bash
# Pretty-print the minified Electron bundles (main/preload/renderer) and the Matter controller for analysis.
set -uo pipefail
source "$(dirname "$0")/wslenv.sh"
mkdir -p ~/tools/jsfmt && cd ~/tools/jsfmt
[ -d node_modules/prettier ] || npm i --silent --no-audit --no-fund prettier@3 >/dev/null
SRC="$REPO/work/app/out"; OUT="$REPO/work/app-pretty"
rm -rf "$OUT"; mkdir -p "$OUT"
cp -r "$SRC"/. "$OUT"/
cp "$REPO/Evnia Precision Center/resources/matter/control.mjs" "$OUT/matter-control.mjs"
cd "$OUT" && find . -name '*.js' -o -name '*.mjs' | while read -r f; do
  ~/tools/jsfmt/node_modules/.bin/prettier --no-config --print-width 120 --write "$f" >/dev/null 2>&1 || echo "prettier failed: $f"
done
find "$OUT" -name '*.js' -o -name '*.mjs' | xargs wc -l | sort -n | tail -15
