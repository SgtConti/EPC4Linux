#!/bin/bash
# Install test of the evnia-precision-center .deb inside a clean distribution container (ARCHITECTURE "Build
# and test pipeline" 5). Driven by test/install/run.sh through docker/Dockerfile.install-test; runs as root.
#
#   in-container.sh install <deb>   apt-get install of the local .deb, Recommends off: apt resolves Depends
#                                   from the distribution archive (image build, network)
#   in-container.sh deps            in that Depends-only state: every ELF file of the package resolves its
#                                   libraries (ldd), each direct NEEDED library comes from a package that
#                                   Depends names, the native addons load (shlibs-check.mjs) (image build)
#   in-container.sh tools           the Recommends (each must exist in this distribution) and the test
#                                   tools (image build, network)
#   in-container.sh verify          docker run --network none: package state, files and permissions, udev
#                                   rules, modules-load, .desktop, two app launches as a non-root user,
#                                   apt-get purge; results in $RESULTS (default /results), summary.txt,
#                                   exit status 1 when a check failed
set -uo pipefail

PKG=evnia-precision-center
APP_DIR=/opt/$PKG
TEST_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
INSTALL_RESULTS=/install-results
RESULTS=${RESULTS:-/results}
TESTER=tester
DESKTOP=/usr/share/applications/$PKG.desktop
RULES=/usr/lib/udev/rules.d/70-$PKG.rules
MODULES=/usr/lib/modules-load.d/$PKG-i2c.conf
# The three files of the Electron runtime that stay executable (scripts/package-deb.mjs EXECUTABLES).
EXECUTABLES=("$APP_DIR/$PKG" "$APP_DIR/chrome-sandbox" "$APP_DIR/chrome_crashpad_handler")
# Electron fuse wire (scripts/lib/fuses.ts): sentinel, version 1, length, one '0'/'1' byte per fuse.
FUSE_SENTINEL=dL7pKGdnNz796PbbjQWNKmHXBZaB9tsX
FUSE_RUN_AS_NODE=0 FUSE_NODE_OPTIONS=2 FUSE_NODE_CLI_INSPECT=3 FUSE_FILE_PRIVILEGES=7
# The package's executable has RunAsNode off (package-deb.mjs hardenFuses). The test scripts (shlibs-check,
# launch-check) run on a copy of it with that one fuse back on, next to the package's own files, so they
# still exercise exactly the shipped Electron and its libraries. No "evnia" in any name: the purge check
# looks for leftovers by name.
NODE_RUNTIME_DIR=/tmp/electron-as-node
NODE_RUNTIME=$NODE_RUNTIME_DIR/electron

is_elf() { [ "$(head -c 4 "$1" 2>/dev/null | od -An -tx1 | tr -d ' \n')" = 7f454c46 ]; }

# Byte offset of the fuse wire's sentinel in an Electron executable (grep counts bytes with LC_ALL=C).
fuse_wire_offset() { LC_ALL=C grep -obUa -m1 "$FUSE_SENTINEL" "$1" | head -n 1 | cut -d: -f1; }
# fuse <executable> <index>: prints the fuse's state byte ('0', '1', 'r').
fuse() {
  local off
  off=$(fuse_wire_offset "$1") && [ -n "$off" ] || return 1
  dd if="$1" bs=1 skip=$((off + ${#FUSE_SENTINEL} + 2 + $2)) count=1 status=none
}

# The package's Electron with RunAsNode on, for the test scripts (see NODE_RUNTIME_DIR).
node_runtime() {
  local f off
  if [ ! -x "$NODE_RUNTIME" ]; then
    rm -rf "$NODE_RUNTIME_DIR"
    mkdir -p "$NODE_RUNTIME_DIR"
    for f in "$APP_DIR"/*; do [ "$f" = "$APP_DIR/$PKG" ] || ln -s "$f" "$NODE_RUNTIME_DIR/"; done
    cp "$APP_DIR/$PKG" "$NODE_RUNTIME"
    off=$(fuse_wire_offset "$NODE_RUNTIME") && [ -n "$off" ] || { echo "FAIL no fuse wire in $APP_DIR/$PKG" >&2; return 1; }
    printf 1 | dd of="$NODE_RUNTIME" bs=1 seek=$((off + ${#FUSE_SENTINEL} + 2 + FUSE_RUN_AS_NODE)) conv=notrunc status=none
    chmod -R a+rX "$NODE_RUNTIME_DIR"
  fi
  echo "$NODE_RUNTIME"
}

# ---------------------------------------------------------------------------------------------------------
# Image build phases

cmd_install() {
  local deb=$1 rc
  mkdir -p "$INSTALL_RESULTS"
  dpkg-query -W -f='${Package}\n' | sort > "$INSTALL_RESULTS/packages-before.txt"
  apt-get update || return 1
  echo "+ apt-get install -y --no-install-recommends $deb"
  apt-get install -y --no-install-recommends "$deb"
  rc=$?
  dpkg-query -W -f='${Package}\n' | sort > "$INSTALL_RESULTS/packages-after.txt"
  comm -13 "$INSTALL_RESULTS/packages-before.txt" "$INSTALL_RESULTS/packages-after.txt" > "$INSTALL_RESULTS/packages-added.txt"
  echo "packages added by the install: $(wc -l < "$INSTALL_RESULTS/packages-added.txt")"
  dpkg-query -W -f='${Package} ${Version}, Installed-Size ${Installed-Size} KiB\n' "$PKG"
  return $rc
}

cmd_deps() {
  local f out fail=0 n=0
  echo "== ldd over every ELF file of the package (Depends-only state)"
  while IFS= read -r f; do
    [ -f "$f" ] && [ ! -L "$f" ] && is_elf "$f" || continue
    n=$((n + 1))
    out=$(ldd "$f" 2>&1)
    if grep -q 'not found' <<<"$out"; then
      echo "FAIL $f"
      grep 'not found' <<<"$out" | sed 's/^/     /'
      fail=1
    else
      echo "ok   $f ($(grep -c '=>' <<<"$out") libraries)"
    fi
  done < <(dpkg -L "$PKG")
  echo "$n ELF files"
  echo
  echo "== direct NEEDED libraries vs Depends, native addons (the package's Electron as Node)"
  local node
  node=$(node_runtime) || return 1
  ELECTRON_RUN_AS_NODE=1 "$node" "$TEST_DIR/shlibs-check.mjs" || fail=1
  return $fail
}

# First alternative of a relation clause ("a (>= 1) | b") that this distribution's archive has.
available_alternative() {
  local clause=$1 alt
  local -a alts
  IFS='|' read -ra alts <<<"$clause"
  for alt in "${alts[@]}"; do
    alt=$(sed -E 's/\([^)]*\)//g; s/^[[:space:]]+//; s/[[:space:]]+$//' <<<"$alt")
    if [ -n "$(apt-cache show --no-all-versions "$alt" 2>/dev/null)" ]; then
      echo "$alt"
      return 0
    fi
  done
  return 1
}

cmd_tools() {
  local field clause chosen status=0
  local -a clauses recommends=()
  for field in Recommends Suggests; do
    IFS=',' read -ra clauses <<<"$(dpkg-query -W -f="\${$field}" "$PKG")"
    for clause in "${clauses[@]}"; do
      if chosen=$(available_alternative "$clause"); then
        echo "$field: ${clause# } -> $chosen"
        [ "$field" = Recommends ] && recommends+=("$chosen")
      else
        echo "FAIL $field: no alternative of '${clause# }' exists in this distribution"
        status=1
      fi
    done
  done
  echo "$status" > "$INSTALL_RESULTS/tools.status"
  echo "+ apt-get install -y --no-install-recommends ${recommends[*]}"
  apt-get install -y --no-install-recommends "${recommends[@]}" || return 1
  # Test tools: X server for the launch, .desktop validator, udevadm. procps for ps in the logs.
  apt-get install -y --no-install-recommends xvfb xauth desktop-file-utils udev procps || return 1
  rm -rf /var/lib/apt/lists/*
}

# ---------------------------------------------------------------------------------------------------------
# verify

SUMMARY=
FAILS=0
KNOWN=0
log_block() { printf '### %s\n%s\n\n' "$1" "$2" >> "$RESULTS/checks.log"; }
pass() { echo "PASS  $1" | tee -a "$SUMMARY"; }
fail() { echo "FAIL  $1${2:+ -- $2}" | tee -a "$SUMMARY"; FAILS=$((FAILS + 1)); }
# check <name> <command…>: runs the command, records its output in checks.log, PASS/FAIL in summary.txt.
check() {
  local name=$1 out rc line
  shift
  out=$("$@" 2>&1)
  rc=$?
  log_block "$name" "$out"
  if [ $rc -eq 0 ]; then pass "$name"; else fail "$name" "$(grep -E '^(FAIL|ERROR)' <<<"$out" | head -n 3 | tr '\n' ' ')"; fi
  # Documented defects outside the packaging (launch-check.mjs KNOWN_*): listed, not counted as failures.
  while IFS= read -r line; do
    echo "XFAIL   $line" | tee -a "$SUMMARY"
    KNOWN=$((KNOWN + 1))
  done < <(grep '^KNOWN-ISSUE ' <<<"$out" | sed 's/^KNOWN-ISSUE //; s/ -- .*//' | sort -u)
}

# dpkg's path-exclude/path-include filters (the ubuntu image drops /usr/share/man and most of /usr/share/doc).
declare -a DPKG_FILTERS=()
load_dpkg_filters() {
  local f line
  for f in /etc/dpkg/dpkg.cfg /etc/dpkg/dpkg.cfg.d/*; do
    [ -f "$f" ] || continue
    while IFS= read -r line; do
      case $line in path-exclude=* | path-include=*) DPKG_FILTERS+=("$line") ;; esac
    done < "$f"
  done
}
# True when dpkg's filters keep the path off the disk (the last matching rule decides).
dpkg_excluded() {
  local path=$1 rule pattern excluded=1
  for rule in "${DPKG_FILTERS[@]}"; do
    pattern=${rule#*=}
    # shellcheck disable=SC2254 # the glob in $pattern is intended (dpkg uses fnmatch without FNM_PATHNAME)
    case $path in $pattern) [ "${rule%%=*}" = path-exclude ] && excluded=0 || excluded=1 ;; esac
  done
  return $excluded
}

check_package_state() {
  local status
  status=$(dpkg-query -W -f='${Status}' "$PKG" 2>&1)
  echo "Status: $status"
  dpkg-query -W -f='Version: ${Version}\nInstalled-Size: ${Installed-Size} KiB\nDepends: ${Depends}\nRecommends: ${Recommends}\n' "$PKG"
  echo "packages added by apt for Depends: $(tr '\n' ' ' < "$INSTALL_RESULTS/packages-added.txt")"
  [ "$status" = "install ok installed" ] || { echo "FAIL not installed"; return 1; }
}

check_deps() {
  cat "$INSTALL_RESULTS/deps.log"
  [ "$(cat "$INSTALL_RESULTS/deps.status" 2>/dev/null)" = 0 ]
}

check_relations() {
  cat "$INSTALL_RESULTS/tools.log"
  [ "$(cat "$INSTALL_RESULTS/tools.status" 2>/dev/null)" = 0 ]
}

check_md5sums() {
  local out line path fail=0
  out=$(dpkg --verify "$PKG" 2>&1)
  echo "dpkg --verify $PKG: ${out:-no differences}"
  while IFS= read -r line; do
    [ -n "$line" ] || continue
    path=${line##* }
    # A file dpkg's own path-exclude kept off the disk (the minimized ubuntu image) is not a defect.
    if [[ $line == missing* ]] && dpkg_excluded "$path"; then echo "  (kept off the disk by dpkg path-exclude: $path)"; continue; fi
    echo "FAIL $line"
    fail=1
  done <<<"$out"
  return $fail
}

check_files() {
  local path mode owner want fail=0 n=0 skipped=0 exe
  local -A is_exe=()
  for exe in "${EXECUTABLES[@]}"; do is_exe[$exe]=1; done
  while IFS= read -r path; do
    [ "$path" = /. ] && continue
    if [ ! -e "$path" ] && [ ! -L "$path" ]; then
      if dpkg_excluded "$path"; then skipped=$((skipped + 1)); continue; fi
      echo "FAIL missing: $path"
      fail=1
      continue
    fi
    [ -L "$path" ] && continue
    n=$((n + 1))
    # Directories of the package's own tree; shared directories (/usr/share/...) belong to others too.
    if [ -d "$path" ]; then
      case $path in "$APP_DIR" | "$APP_DIR"/*) ;; *) continue ;; esac
      want=755
    elif [ "$path" = "$APP_DIR/chrome-sandbox" ]; then
      want=4755
    elif [ -n "${is_exe[$path]:-}" ]; then
      want=755
    else
      want=644
    fi
    mode=$(stat -c '%a' "$path")
    owner=$(stat -c '%U:%G' "$path")
    if [ "$mode" != "$want" ] || [ "$owner" != root:root ]; then
      echo "FAIL $path is $mode $owner, expected $want root:root"
      fail=1
    fi
  done < <(dpkg -L "$PKG")
  echo "$n paths checked, $skipped kept off the disk by dpkg path-exclude"
  stat -c '%A %U:%G %n' "$APP_DIR/chrome-sandbox" "${EXECUTABLES[0]}" "${EXECUTABLES[2]}"
  path=$(readlink /usr/bin/$PKG)
  echo "/usr/bin/$PKG -> $path"
  [ "$path" = "$APP_DIR/$PKG" ] || { echo "FAIL /usr/bin/$PKG points to $path"; fail=1; }
  # No other setuid/setgid file, nothing group- or world-writable anywhere in the package.
  while IFS= read -r path; do
    [ "$path" = "$APP_DIR/chrome-sandbox" ] && continue
    echo "FAIL special permission bits: $(stat -c '%A %n' "$path")"
    fail=1
  done < <(find "$APP_DIR" \( -perm -4000 -o -perm -2000 -o -perm -0002 -o -perm -0020 \) ! -type l)
  for path in "$DESKTOP" "$RULES" "$MODULES" /usr/share/doc/$PKG/copyright /usr/share/doc/$PKG/changelog.Debian.gz \
    /usr/share/doc/$PKG/README.Debian.gz /usr/share/man/man1/$PKG.1.gz /usr/share/lintian/overrides/$PKG \
    /usr/share/icons/hicolor/64x64/apps/$PKG.png /usr/share/icons/hicolor/16x16/apps/$PKG.png; do
    if [ -f "$path" ]; then echo "present: $path"
    elif dpkg_excluded "$path"; then echo "present in the package, kept off the disk by dpkg path-exclude: $path"
    else echo "FAIL missing: $path"; fail=1; fi
  done
  return $fail
}

# The installed executable cannot be used as a Node runtime (20-online-sweep-tail §12 fuse checks):
# RunAsNode, NODE_OPTIONS and --inspect off; the file: privileges the vendor UI needs stay on.
check_fuses() {
  local exe=$APP_DIR/$PKG fail=0 name index want got
  echo "fuse wire at byte $(fuse_wire_offset "$exe") of $exe"
  for spec in RunAsNode:$FUSE_RUN_AS_NODE:0 EnableNodeOptionsEnvironmentVariable:$FUSE_NODE_OPTIONS:0 \
    EnableNodeCliInspectArguments:$FUSE_NODE_CLI_INSPECT:0 GrantFileProtocolExtraPrivileges:$FUSE_FILE_PRIVILEGES:1; do
    IFS=: read -r name index want <<<"$spec"
    got=$(fuse "$exe" "$index")
    echo "$name=$got"
    [ "$got" = "$want" ] || { echo "FAIL fuse $name is '$got', expected '$want'"; fail=1; }
  done
  # And in practice: with RunAsNode off, ELECTRON_RUN_AS_NODE is ignored and the executable does not run the
  # script (it starts as the app instead and ends without a display; as $TESTER with a throwaway HOME).
  local home
  home=$(mktemp -d /tmp/fuse-home.XXXXXX) && chown "$TESTER:" "$home"
  if runuser -u "$TESTER" -- env -i HOME="$home" PATH=/usr/bin:/bin ELECTRON_RUN_AS_NODE=1 \
    timeout 20 "$exe" -e 'process.stdout.write("node-runtime\n"); process.exit(0)' 2>/dev/null | grep -q node-runtime; then
    echo "FAIL ELECTRON_RUN_AS_NODE=1 still runs a script"
    fail=1
  else
    echo "ELECTRON_RUN_AS_NODE=1 $exe -e …: no script ran"
  fi
  rm -rf "$home"
  return $fail
}

check_udev_rules() {
  local fail=0 line
  cat "$RULES"
  echo
  if udevadm verify --help >/dev/null 2>&1; then
    echo "+ udevadm verify --resolve-names=never $RULES ($(udevadm --version))"
    udevadm verify --resolve-names=never "$RULES" || fail=1
  else
    # systemd < 254 has no "udevadm verify": syntax-check every rule line (KEY op "value", comma-separated).
    echo "udevadm verify unavailable ($(udevadm --version 2>&1)): checking the rule syntax"
    while IFS= read -r line; do
      [[ $line =~ ^[[:space:]]*(#|$) ]] && continue
      [[ $line =~ ^([A-Za-z_]+(\{[^}]+\})?[[:space:]]*(==|!=|=|\+=|-=|:=)[[:space:]]*\"[^\"]*\"[[:space:]]*(,[[:space:]]*|$))+$ ]] || { echo "FAIL rule syntax: $line"; fail=1; }
    done < "$RULES"
  fi
  # uaccess only, exactly the two USB functions and display-adapter i2c buses; applied before 73-seat-late.
  grep -q 'ATTR{idVendor}=="2109", ATTR{idProduct}=="8884", TAG+="uaccess", ATTR{power/control}="on"' "$RULES" || { echo "FAIL VIA bridge rule"; fail=1; }
  grep -q 'ATTR{idVendor}=="0cf2", ATTR{idProduct}=="a201", TAG+="uaccess"' "$RULES" || { echo "FAIL ENE rule"; fail=1; }
  [ "$(grep -c 'SUBSYSTEM=="i2c-dev".*TAG+="uaccess"' "$RULES")" = 2 ] || { echo "FAIL i2c-dev rules"; fail=1; }
  ! grep -Eq '^[^#]*(MODE=|GROUP=|OWNER=|RUN)' "$RULES" || { echo "FAIL rules must grant access through uaccess only"; fail=1; }
  [ -f /usr/lib/udev/rules.d/73-seat-late.rules ] && echo "73-seat-late.rules (uaccess) sorts after 70-$PKG.rules"
  return $fail
}

check_modules_load() {
  local line fail=0 found=0
  cat "$MODULES"
  while IFS= read -r line; do
    [[ $line =~ ^[[:space:]]*([#\;]|$) ]] && continue
    [[ $line =~ ^[A-Za-z0-9_-]+$ ]] || { echo "FAIL not a module name: $line"; fail=1; }
    [ "$line" = i2c-dev ] && found=1
  done < "$MODULES"
  [ $found = 1 ] || { echo "FAIL i2c-dev is not listed"; fail=1; }
  [ "$(stat -c '%a %U' "$MODULES")" = "644 root" ] || { echo "FAIL mode $(stat -c '%a %U' "$MODULES")"; fail=1; }
  return $fail
}

check_desktop_entry() {
  local fail=0 exec_cmd icon
  cat "$DESKTOP"
  echo "+ desktop-file-validate $DESKTOP"
  desktop-file-validate "$DESKTOP" || fail=1
  exec_cmd=$(sed -n 's/^Exec=\([^ ]*\).*/\1/p' "$DESKTOP")
  command -v "$exec_cmd" >/dev/null || { echo "FAIL Exec=$exec_cmd is not in PATH"; fail=1; }
  icon=$(sed -n 's/^Icon=//p' "$DESKTOP")
  compgen -G "/usr/share/icons/hicolor/*/apps/$icon.png" >/dev/null || { echo "FAIL Icon=$icon not in hicolor"; fail=1; }
  echo "Exec=$exec_cmd -> $(command -v "$exec_cmd"), Icon=$icon -> $(compgen -G "/usr/share/icons/hicolor/*/apps/$icon.png" | tr '\n' ' ')"
  return $fail
}

TUID=
setup_tester() {
  id "$TESTER" >/dev/null 2>&1 || useradd -m -s /bin/bash "$TESTER"
  TUID=$(id -u "$TESTER")
  # What logind provides in a real session: a private runtime directory.
  mkdir -p "/run/user/$TUID"
  chown "$TESTER:" "/run/user/$TUID"
  chmod 0700 "/run/user/$TUID"
}

# Sandbox of a running app: renderers in their own PID namespace but the browser's user namespace are
# confined by the setuid helper (chrome-sandbox); a new user namespace means the namespace sandbox.
# /proc/<pid>/ns/* of another user's (non-dumpable) process needs CAP_SYS_PTRACE, which a container lacks,
# so the world-readable NSpid (one pid per nested PID namespace) and uid_map are compared instead.
sandbox_report() {
  local browser=$1 bdepth bmap p cmd depth map mode kinds=""
  nspid_depth() { awk '/^NSpid:/ { print NF - 1 }' "$1/status" 2>/dev/null; }
  bdepth=$(nspid_depth "/proc/$browser")
  bmap=$(tr -s ' ' < "/proc/$browser/uid_map" 2>/dev/null | xargs)
  echo "browser pid $browser: PID namespace depth $bdepth, uid_map '$bmap'"
  for p in /proc/[0-9]*; do
    cmd=$(tr '\0' ' ' < "$p/cmdline" 2>/dev/null) || continue
    case $cmd in "$APP_DIR"/*--type=renderer*) ;; *) continue ;; esac
    depth=$(nspid_depth "$p")
    map=$(tr -s ' ' < "$p/uid_map" 2>/dev/null | xargs)
    if [ -z "$depth" ] || [ "$depth" -le "$bdepth" ]; then mode=none
    elif [ "$map" = "$bmap" ]; then mode=setuid
    else mode=namespace; fi
    echo "renderer pid ${p#/proc/}: PID namespace depth $depth, uid_map '$map' -> $mode"
    kinds="$kinds $mode"
  done
  kinds=$(tr ' ' '\n' <<<"$kinds" | sed '/^$/d' | sort -u | tr '\n' ' ')
  echo "sandbox: ${kinds:-no renderer found}"
}

# run_launch <name> <expected sandbox: setuid|any> [app args…]: the app as $TESTER under Xvfb with the
# simulated monitor, driven by launch-check.mjs through the package's own Electron as Node.
run_launch() {
  local name=$1 expect=$2
  shift 2
  local work=/home/$TESTER/launch-$name sync=/run/user/$TUID/launch-$name out=$RESULTS/launch-$name drv rc i sandbox node
  node=$(node_runtime) || return 1
  rm -rf "$work" "$sync"
  mkdir -p "$out"
  runuser -u "$TESTER" -- mkdir -p "$work" "$sync"
  runuser -u "$TESTER" -- env -i HOME="/home/$TESTER" USER="$TESTER" LOGNAME="$TESTER" SHELL=/bin/bash \
    PATH=/usr/local/bin:/usr/bin:/bin LANG=C.UTF-8 XDG_RUNTIME_DIR="/run/user/$TUID" XDG_SESSION_TYPE=x11 \
    EVNIA_MOCK_MONITOR=34M2C8600 ELECTRON_RUN_AS_NODE=1 \
    xvfb-run -a -s "-screen 0 1920x1080x24" "$node" "$TEST_DIR/launch-check.mjs" \
    --out "$work" --sync "$sync" --desktop "$DESKTOP" -- "$@" > "$out/driver.log" 2>&1 &
  drv=$!
  for ((i = 0; i < 180; i++)); do
    [ -s "$sync/ready" ] && break
    kill -0 "$drv" 2>/dev/null || break
    sleep 1
  done
  if [ -s "$sync/ready" ]; then
    sandbox_report "$(cat "$sync/ready")" > "$out/sandbox.txt" 2>&1
    ps -o user,pid,ppid,args -u "$TESTER" > "$out/processes.txt" 2>&1
    touch "$sync/done"
  fi
  wait "$drv"
  rc=$?
  cp -r "$work/." "$out/" 2>/dev/null
  cat "$out/driver.log"
  [ -f "$out/sandbox.txt" ] && cat "$out/sandbox.txt"
  [ $rc -eq 0 ] || { echo "FAIL launch-check exited with $rc"; return 1; }
  sandbox=$(sed -n 's/^sandbox: //p' "$out/sandbox.txt" 2>/dev/null | xargs)
  case $expect:$sandbox in
    setuid:setuid | any:setuid | any:namespace) echo "renderer sandbox: $sandbox" ;;
    *) echo "FAIL renderer sandbox is '$sandbox', expected $expect"; return 1 ;;
  esac
}

check_user_data() {
  local home=/home/$TESTER fail=0
  (cd "$home" && find .config -maxdepth 3 | sort)
  [ -s "$home/.config/evnia/config.json" ] || { echo "FAIL no ~/.config/evnia/config.json"; fail=1; }
  compgen -G "$home/.config/evnia/logs/*.log" >/dev/null || { echo "FAIL no main log"; fail=1; }
  [ -d "$home/.config/EvniaServe" ] || { echo "FAIL no ~/.config/EvniaServe"; fail=1; }
  # autoStartup defaults to false on Linux: a fresh install writes no login autostart entry.
  [ ! -e "$home/.config/autostart/$PKG.desktop" ] || { echo "FAIL autostart entry written"; fail=1; }
  return $fail
}

check_purge() {
  local out rc
  dpkg -L "$PKG" > "$RESULTS/dpkg-L.txt"
  echo "+ apt-get purge -y $PKG"
  out=$(apt-get purge -y "$PKG" 2>&1)
  rc=$?
  echo "$out"
  [ $rc -eq 0 ] || { echo "FAIL apt-get purge exited with $rc"; return 1; }
  ! grep -q '^dpkg: warning' <<<"$out" || { echo "FAIL dpkg warnings during the purge"; return 1; }
}

check_leftovers() {
  local path fail=0 owner status
  status=$(dpkg-query -W -f='${Status}' "$PKG" 2>/dev/null)
  echo "dpkg status after purge: ${status:-unknown (no record)}"
  case $status in "" | "unknown ok not-installed" | "purge ok not-installed") ;; *) echo "FAIL package state: $status"; fail=1 ;; esac
  compgen -G "/var/lib/dpkg/info/$PKG.*" >/dev/null && { echo "FAIL dpkg info files left: $(ls /var/lib/dpkg/info/$PKG.*)"; fail=1; }
  while IFS= read -r path; do
    [ "$path" = /. ] && continue
    [ -e "$path" ] || [ -L "$path" ] || continue
    if [ -d "$path" ] && [ ! -L "$path" ]; then
      owner=$(dpkg -S "$path" 2>/dev/null | head -n 1)
      if [ -n "$owner" ]; then echo "kept (shared directory, also in $(awk -F", " '{ print $1 (NF > 1 ? " and " NF - 1 " more" : "") }' <<<"${owner%%: *}")): $path"; continue; fi
      if [ -n "$(ls -A "$path")" ]; then echo "kept (directory with other files): $path"; continue; fi
    fi
    echo "FAIL left behind: $path"
    fail=1
  done < "$RESULTS/dpkg-L.txt"
  # Anything named after the program outside the user's home and runtime directory (and the test mounts).
  while IFS= read -r path; do
    echo "FAIL left behind: $path"
    fail=1
  done < <(find / -xdev \( -path /proc -o -path /sys -o -path /dev -o -path "/home/$TESTER" -o -path "/run/user/$TUID" \
    -o -path /install-results -o -path "$RESULTS" -o -path "$TEST_DIR" \) -prune -o -iname '*evnia*' -print 2>/dev/null)
  echo "user data kept, as Debian policy requires (remove by hand):"
  (cd "/home/$TESTER" && find .config -maxdepth 2 \( -iname '*evnia*' -o -path './.config/autostart/*' \) | sort | sed 's/^/  ~\//')
  [ -d "/home/$TESTER/.config/evnia" ] && [ -d "/home/$TESTER/.config/EvniaServe" ] || { echo "FAIL user config removed"; fail=1; }
  return $fail
}

cmd_verify() {
  mkdir -p "$RESULTS"
  cp -r "$INSTALL_RESULTS/." "$RESULTS/"
  SUMMARY=$RESULTS/summary.txt
  : > "$SUMMARY"
  : > "$RESULTS/checks.log"
  . /etc/os-release
  echo "== $PRETTY_NAME" | tee -a "$SUMMARY"
  load_dpkg_filters
  setup_tester

  check "apt-get install ./pkg.deb resolved Depends from the archive" check_package_state
  check "shared libraries resolve with Depends only; NEEDED libraries come from Depends; addons load" check_deps
  check "every Recommends and Suggests exists in this distribution" check_relations
  check "installed files match DEBIAN/md5sums (dpkg --verify)" check_md5sums
  check "files and permissions (chrome-sandbox 4755 root)" check_files
  check "Electron fuses: no Node runtime (RunAsNode, NODE_OPTIONS, --inspect off)" check_fuses
  check "udev rules" check_udev_rules
  check "modules-load.d" check_modules_load
  check ".desktop entry (desktop-file-validate)" check_desktop_entry
  check "launch as $TESTER: Home with the PHL 34M2C8600 card (default sandbox)" run_launch default any
  check "launch as $TESTER: Home with the card under the setuid sandbox (chrome-sandbox)" run_launch suid-sandbox setuid --disable-namespace-sandbox
  check "user data in ~/.config, no autostart entry by default" check_user_data
  check "apt-get purge" check_purge
  check "purge leaves no files except the user's config" check_leftovers

  local known=""
  [ "$KNOWN" -eq 0 ] || known=" ($KNOWN known issue(s) outside the packaging, XFAIL above)"
  if [ "$FAILS" -eq 0 ]; then echo "RESULT: all checks passed$known" | tee -a "$SUMMARY"; else echo "RESULT: $FAILS check(s) failed$known" | tee -a "$SUMMARY"; fi
  [ "$FAILS" -eq 0 ]
}

case ${1:-} in
  install) shift; cmd_install "$@" ;;
  deps) cmd_deps ;;
  tools) cmd_tools ;;
  verify) cmd_verify ;;
  *) echo "usage: $0 install <deb> | deps | tools | verify" >&2; exit 2 ;;
esac
