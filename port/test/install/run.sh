#!/bin/bash
# .deb install verification (ARCHITECTURE "Build and test pipeline" 5; impl-electron-shell "Packaging").
# Runs on the Docker host (Linux, or Git Bash on Windows with Docker Desktop):
#
#   test/install/run.sh [--skip-build] [--deb <file>] [--dist "debian:trixie ubuntu:24.04"]
#                       [--reuse-images] [--keep-images]
#
# 1. build     npm run import-ui && npm run build && npm run dist:deb in the evnia-port-dev container
#              (skipped with --skip-build or --deb)
# 2. inspect   package size, control fields, lintian (as a non-root user; E/W tags fail the run)
# 3. install   per distribution, docker/Dockerfile.install-test on the CLEAN image: apt-get install
#              ./pkg.deb resolves Depends from the archive, the shared-library check runs in that
#              Depends-only state, then the Recommends and the test tools are added (network: apt only)
# 4. verify    docker run --network none: files and permissions, udev rules, modules-load, .desktop, the
#              app launched as a non-root user under Xvfb with EVNIA_MOCK_MONITOR=34M2C8600 reaching
#              Home with the monitor card (default sandbox, then the setuid chrome-sandbox), apt-get purge
#              leaving only the user's config (test/install/in-container.sh verify)
#
# Results: test/install/artifacts/ (summary.txt, package-info.txt, lintian*.txt, and per distribution
# summary.txt, checks.log, launch-*/home.png, …). Exit status 1 when anything failed.
#
# The launch containers get CAP_SYS_ADMIN and no seccomp filter: Chromium's setuid sandbox creates PID and
# network namespaces, which Docker's default profile forbids even to setuid root. The network is off.
set -uo pipefail
export MSYS_NO_PATHCONV=1 MSYS2_ARG_CONV_EXCL='*'

PORT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
REPO_DIR=$(cd "$PORT_DIR/.." && pwd)
ART=$PORT_DIR/test/install/artifacts
STAGE=$PORT_DIR/dist/install-test
DEV_IMAGE=evnia-port-dev
DISTS="debian:trixie ubuntu:24.04"
BUILD=1
DEB=
REUSE=0
KEEP=0

usage() { sed -n '2,23p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; }
while [ $# -gt 0 ]; do
  case $1 in
    --skip-build) BUILD=0 ;;
    --deb) DEB=$2; BUILD=0; shift ;;
    --dist) DISTS=$2; shift ;;
    --reuse-images) REUSE=1 ;;
    --keep-images) KEEP=1 ;;
    -h | --help) usage; exit 0 ;;
    *) echo "unknown option $1" >&2; usage >&2; exit 2 ;;
  esac
  shift
done

# Host path for docker -v / build contexts (Git Bash paths → Windows paths).
hostpath() { if command -v cygpath >/dev/null 2>&1; then cygpath -w "$1"; else printf '%s' "$1"; fi; }
say() { printf '\n== %s\n' "$*"; }
dev() { docker run --rm -v "$(hostpath "$REPO_DIR"):/repo" -w /repo/port "$DEV_IMAGE" bash -c "$1"; }

docker image inspect "$DEV_IMAGE" >/dev/null 2>&1 || {
  echo "Docker image $DEV_IMAGE missing: docker build -t $DEV_IMAGE -f port/docker/Dockerfile.dev port/docker" >&2
  exit 2
}
for f in in-container.sh launch-check.mjs shlibs-check.mjs; do
  if grep -q $'\r' "$PORT_DIR/test/install/$f"; then echo "test/install/$f has CRLF line endings" >&2; exit 2; fi
done
mkdir -p "$ART"

if [ $BUILD = 1 ]; then
  say "build: npm run import-ui && npm run build && npm run dist:deb (in $DEV_IMAGE)"
  dev 'set -e; npm run import-ui -- --quiet; npm run build; npm run dist:deb' 2>&1 | tee "$ART/build.log"
  [ "${PIPESTATUS[0]}" = 0 ] || { echo "build failed, see $ART/build.log" >&2; exit 1; }
fi
if [ -z "$DEB" ]; then
  DEB=$(ls "$PORT_DIR"/dist/evnia-precision-center_*_amd64.deb 2>/dev/null | sort -V | tail -n 1)
  [ -n "$DEB" ] || { echo "no dist/evnia-precision-center_*_amd64.deb: run without --skip-build" >&2; exit 1; }
fi
DEB=$(cd "$(dirname "$DEB")" && pwd)/$(basename "$DEB")
DEB_NAME=$(basename "$DEB")

# Build contexts with exactly the package and the test scripts (nothing else is sent to the builder).
rm -rf "$STAGE"
mkdir -p "$STAGE/pkg" "$STAGE/tests"
cp "$DEB" "$STAGE/pkg/$DEB_NAME"
cp "$PORT_DIR"/test/install/{in-container.sh,launch-check.mjs,shlibs-check.mjs} "$STAGE/tests/"

say "inspect: $DEB_NAME"
dev "cp '/repo/${STAGE#"$REPO_DIR"/}/pkg/$DEB_NAME' /tmp/p.deb && chmod 644 /tmp/p.deb &&
  echo \"File: $DEB_NAME\" && echo \"Size: \$(stat -c %s /tmp/p.deb) bytes (\$(du -h /tmp/p.deb | cut -f1))\" &&
  echo \"Files: \$(dpkg-deb -c /tmp/p.deb | grep -vc '^d')\" && echo && dpkg-deb -I /tmp/p.deb" > "$ART/package-info.txt" 2>&1
cat "$ART/package-info.txt"
dev "useradd -m lint && cp '/repo/${STAGE#"$REPO_DIR"/}/pkg/$DEB_NAME' /tmp/p.deb && chmod 644 /tmp/p.deb &&
  runuser -u lint -- lintian --version && runuser -u lint -- lintian /tmp/p.deb; echo \"exit status \$?\"" > "$ART/lintian.txt" 2>&1
dev "useradd -m lint && cp '/repo/${STAGE#"$REPO_DIR"/}/pkg/$DEB_NAME' /tmp/p.deb && chmod 644 /tmp/p.deb &&
  runuser -u lint -- lintian --info --display-info --display-experimental --pedantic --show-overrides /tmp/p.deb" > "$ART/lintian-full.txt" 2>&1
LINTIAN_EW=$(grep -cE '^[EW]: ' "$ART/lintian.txt")
LINTIAN_OTHER=$(grep -cE '^[IPX]: ' "$ART/lintian-full.txt")
LINTIAN_OVERRIDDEN=$(grep -cE '^O: ' "$ART/lintian-full.txt")
cat "$ART/lintian.txt"
echo "lintian: $LINTIAN_EW error/warning tags; with --info --pedantic --display-experimental: $LINTIAN_OTHER more, $LINTIAN_OVERRIDDEN overridden (lintian-full.txt)"

RESULT=0
[ "$LINTIAN_EW" = 0 ] && grep -q '^exit status 0$' "$ART/lintian.txt" || RESULT=1
{
  echo "Package: $DEB_NAME"
  grep -E '^(Size|Files):|^ (Installed-Size|Depends|Recommends|Suggests|Maintainer):' "$ART/package-info.txt"
  echo "lintian (E/W): $LINTIAN_EW tags; info/pedantic/experimental not overridden: $LINTIAN_OTHER; overridden: $LINTIAN_OVERRIDDEN"
} > "$ART/summary.txt"

for image in $DISTS; do
  slug=$(tr ':/' '--' <<<"$image")
  tag=evnia-install-test:$slug
  out=$ART/$slug
  rm -rf "$out"
  mkdir -p "$out"
  if [ $REUSE = 1 ] && docker image inspect "$tag" >/dev/null 2>&1; then
    say "install: reusing image $tag"
  else
    say "install: $image (docker build, apt resolves Depends from the archive)"
    docker pull -q "$image" >/dev/null
    docker build -f "$(hostpath "$PORT_DIR/docker/Dockerfile.install-test")" --no-cache --progress=plain \
      --build-arg BASE="$image" --build-arg DEB="$DEB_NAME" \
      --build-context pkg="$(hostpath "$STAGE/pkg")" --build-context tests="$(hostpath "$STAGE/tests")" \
      -t "$tag" "$(hostpath "$PORT_DIR/docker")" > "$out/docker-build.log" 2>&1
    if [ $? != 0 ]; then
      tail -n 40 "$out/docker-build.log"
      echo "FAIL  $image: docker build (install) failed, see $out/docker-build.log" | tee -a "$ART/summary.txt"
      RESULT=1
      continue
    fi
  fi
  say "verify: $image (docker run --network none)"
  docker run --rm --network none --cap-add SYS_ADMIN --security-opt seccomp=unconfined --shm-size 1g \
    -v "$(hostpath "$STAGE/tests"):/test:ro" -v "$(hostpath "$out"):/results" \
    "$tag" bash /test/in-container.sh verify > "$out/verify.log" 2>&1
  [ $? = 0 ] || RESULT=1
  cat "$out/verify.log"
  { echo; cat "$out/summary.txt" 2>/dev/null || echo "FAIL  $image: no summary (see $out/verify.log)"; } >> "$ART/summary.txt"
  [ $KEEP = 1 ] || docker image rm "$tag" >/dev/null
done
rm -rf "$STAGE"

say "summary ($ART/summary.txt)"
cat "$ART/summary.txt"
exit $RESULT
