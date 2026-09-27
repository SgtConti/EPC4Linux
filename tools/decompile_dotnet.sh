#!/usr/bin/env bash
# Decompile the vendor (non-framework) .NET assemblies of EvniaServe into C# projects.
set -uo pipefail
export DOTNET_SYSTEM_GLOBALIZATION_INVARIANT=1 DOTNET_ROOT=~/.dotnet PATH=~/.dotnet:~/.dotnet/tools:$PATH DOTNET_CLI_TELEMETRY_OPTOUT=1
REPO="${REPO:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
BIN="$REPO/Evnia Precision Center/resources/bin"
OUT="$REPO/work/dotnet"
mkdir -p "$OUT"
for f in "$BIN"/EvniaServe.dll "$BIN"/Zeasn.*.dll "$BIN"/Bridge.Lib.dll "$BIN"/NuGet.Lib.dll "$BIN"/ManagedNativeWifi.dll; do
  n=$(basename "$f" .dll)
  [ -d "$OUT/$n" ] && continue
  ilspycmd -p -r "$BIN" -o "$OUT/$n" "$f" >"$OUT/$n.log" 2>&1 && echo "ok $n" || echo "FAIL $n"
done
