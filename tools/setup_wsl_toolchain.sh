#!/usr/bin/env bash
# User-local reverse-engineering / build toolchain for WSL (no sudo needed).
# Installs into ~/tools: Node 22 LTS, .NET 8 SDK (+ ilspycmd), Temurin JDK 21, Ghidra.
set -euo pipefail
T=~/tools; mkdir -p "$T"; cd "$T"

if [ ! -x "$T/node/bin/node" ]; then
  NV=$(curl -fsSL https://nodejs.org/dist/latest-v22.x/SHASUMS256.txt | grep -oE 'node-v[0-9.]+-linux-x64\.tar\.xz' | head -1)
  curl -fsSL "https://nodejs.org/dist/latest-v22.x/$NV" -o node.tar.xz
  mkdir -p node && tar -xJf node.tar.xz -C node --strip-components=1 && rm node.tar.xz
fi
echo "node: $("$T/node/bin/node" --version)"

if [ ! -x ~/.dotnet/dotnet ]; then
  curl -fsSL https://dot.net/v1/dotnet-install.sh -o dotnet-install.sh
  bash dotnet-install.sh --channel 8.0 --install-dir ~/.dotnet >/dev/null
fi
export DOTNET_SYSTEM_GLOBALIZATION_INVARIANT=1 DOTNET_ROOT=~/.dotnet PATH=~/.dotnet:~/.dotnet/tools:$PATH DOTNET_CLI_TELEMETRY_OPTOUT=1
echo "dotnet: $(dotnet --version)"
command -v ilspycmd >/dev/null || dotnet tool install -g ilspycmd --version 9.1.0.7988 >/dev/null
echo "ilspycmd: $(ilspycmd --version | head -1)"

if [ ! -x "$T/jdk/bin/java" ]; then
  curl -fsSL "https://api.adoptium.net/v3/binary/latest/21/ga/linux/x64/jdk/hotspot/normal/eclipse" -o jdk.tar.gz
  mkdir -p jdk && tar -xzf jdk.tar.gz -C jdk --strip-components=1 && rm jdk.tar.gz
fi
echo "java: $("$T/jdk/bin/java" -version 2>&1 | head -1)"

if [ ! -d "$T/ghidra" ]; then
  GURL=$(curl -fsSL https://api.github.com/repos/NationalSecurityAgency/ghidra/releases/latest | grep -oE '"browser_download_url": *"[^"]+\.zip"' | head -1 | sed -E 's/.*"(https[^"]+)"/\1/')
  echo "ghidra from $GURL"
  curl -fsSL "$GURL" -o ghidra.zip
  python3 -c "import zipfile;zipfile.ZipFile('ghidra.zip').extractall('ghidra_x')" && rm ghidra.zip
  mv ghidra_x/* ghidra && rmdir ghidra_x
fi
echo "ghidra: $(ls "$T/ghidra/support/analyzeHeadless")"
# zipfile drops unix modes: restore exec bits on Ghidra launchers and native helpers
chmod +x "$T"/ghidra/ghidraRun "$T"/ghidra/support/*.sh "$T"/ghidra/support/analyzeHeadless "$T"/ghidra/support/launch.sh 2>/dev/null || true
find "$T"/ghidra/Ghidra -path '*/os/linux_x86_64/*' -type f -exec chmod +x {} + 2>/dev/null || true
