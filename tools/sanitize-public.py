#!/usr/bin/env python3
"""Make the repository safe to publish: replace what identifies the owner, their machine and their monitor
unit with deterministic, obviously synthetic but format-valid values, and check that nothing is left.

Python 3.8+, standard library only. Deterministic and idempotent: a second run changes nothing, and every
run verifies that per file (a rule that is not idempotent aborts the run before anything is written).

USAGE
  python3 tools/sanitize-public.py [--tree DIR] [--map FILE] [--public-only] [--dry-run] [--quiet]
  python3 tools/sanitize-public.py --check [--tree DIR] [--map FILE | --public-only]
  python3 tools/sanitize-public.py --stdin [--check] [--map FILE | --public-only]
  python3 tools/sanitize-public.py --self-test

  On Windows, "python3" in Git Bash is often the Microsoft Store stub, which runs nothing: use
  "py -3 tools/sanitize-public.py ..." there (or run in WSL/Linux).

  --tree DIR     Tree to process. Default: the repository that contains this script. When DIR is a git work
                 tree (DIR/.git exists) the files are the tracked plus the untracked-but-not-ignored ones
                 (git ls-files); otherwise DIR is walked.
  --check        Change nothing. List every remaining identifier as "path:line: rule: excerpt" and exit 1 on
                 any hit, 0 when clean: the private map's identifiers and the generic patterns below, which
                 need no map. In a git work tree it also scans the git-ignored files that are present (outside
                 the directories listed below), marked "[git-ignored]": git never publishes them, but a zip of
                 the checkout or a Docker build context would.
  --stdin        Filter standard input to standard output instead of a tree: the commit-message filter of a
                 history rewrite (git filter-branch --msg-filter). With --check: check standard input.
  --map FILE     The private mapping table. Default: $SANITIZE_PUBLIC_MAP; else <checkout>-private/
                 sanitize-public.local.json next to the checkout that contains this script (the recommended
                 place: outside the checkout); else sanitize-public.local.json next to this script.
  --public-only  Use the generic rules only (a public checkout, CI). Without this flag every mode except
                 --self-test refuses to run when the private map is missing (exit 2), so neither a rewrite nor
                 a check can silently do less than it should.
  --dry-run      Report the files a rewrite would change, write nothing.
  --self-test    Run the built-in tests of the special handlers and exit.

  Never touched or checked: .git/, node_modules/, build/, dist/ (at any depth), work/ and
  "Evnia Precision Center/" (the vendor installation), port/test/e2e/artifacts/, port/test/install/artifacts/,
  binary files (a NUL byte, or not UTF-8) and symlinks. Never rewritten: this script and the private map
  (--check scans the script, and reports the map if it is inside the tree, ignored or not).

HISTORY REWRITE (every commit of the branch; docs/port/MAINTAINING.md "Rewriting the history" has the
  whole procedure). Commit the sanitized tree first (filter-branch refuses a dirty work tree), then rewrite
  in a fresh clone (git clone --no-local), in Linux or WSL, with absolute paths: filter-branch runs the tree
  filter in a temporary checkout without .git (walk mode), and the message filter on each commit message:
    git update-ref -d refs/original/refs/heads/main     # only in an old checkout: a backup blocks a rewrite
    git -c core.autocrlf=false filter-branch \
      --tree-filter 'python3 /abs/tools/sanitize-public.py --map /abs/map.json --tree . --quiet' \
      --msg-filter  'python3 /abs/tools/sanitize-public.py --map /abs/map.json --stdin' -- main
  (Author, committer and their time zones are not content: rewrite them with --env-filter if needed.)
  Afterwards check every commit (--check --tree on each "git archive", and "git log --format=%B | --stdin
  --check"), delete refs/original/, the remote-tracking refs of the old remote and the reflogs
  (git reflog expire --expire=now --all && git gc --prune=now), and push only the rewritten branch to a NEW
  repository: a force-push over an existing GitHub repository leaves the old commits reachable through the
  read-only refs/pull/* of its pull requests, which only GitHub Support can remove.

THE MAPPING TABLE
  One table, in two parts. The public part is this file: the synthetic values below and generic rules that
  need no knowledge of the real values. The private part holds the owner's identifiers (old -> new) and
  lives OUTSIDE the repository and its history (see --map; tools/*.local.json is git-ignored as a fallback),
  because publishing the table would publish exactly what it removes. Its format:
      {"replace": [[old, new], ...], "check": [token, ...], "check_ci": [token, ...], "check_re": [regex, ...]}
  "replace" is applied literally, longest match first, in one pass; no "new" value may contain an "old" key
  (checked when loading). --check reports every "old" key and "check" token (case-sensitive), every
  "check_ci" token (case-insensitive) and every match of a "check_re" regular expression (Python syntax; use
  (?i) for case-insensitive), e.g. the unit's numeric EDID serial number in any notation.

  Synthetic values (the private map maps the real ones onto these):
    monitor serial (EDID 0xFF text, TPV GetSN, DisplaySN) AU00000000001; test-invented serials keep their
    tail with the prefix AU0000; EDID serial number = the serial's numeric tail (1), manufacture week 1 (the
    year is the model's); ENE USB serial 0000000002 (0000000001 is the shipped simulator's); peripherals
    0000:0001 keyboard, 0000:0002 mouse, 0000:0003 audio device, 0000:0004/0005 other HID devices, with USB
    serials serialkeyboard01 / serialmouse1 / serialaudiodevice1; Windows instance-ID hashes 0000001 ...
    0000000d (same length); Windows user name "user"; GPU "AMD Radeon Graphics"; OS "Windows 11 Pro".

WHAT IS REWRITTEN (text files)
  - Windows home paths, also JSON-escaped (C:\\Users\\<name>\\..., C:/Users/<name>/..., /mnt/c/Users/<name>/...,
    /c/Users/<name>/...): <name> -> user. In Markdown, C:/Users/<name>/AppData/Roaming|Local becomes %APPDATA% /
    %LOCALAPPDATA%, other home paths %USERPROFILE%, a backticked checkout path "the repository root", and a
    WSL checkout path <repo>. Docker bind mounts "C:\\Users\\<name>\\...:/repo" become "C:\\path\\to\\repo:/repo".
  - Shell scripts: a hard-coded REPO=/mnt/<drive>/Users/<name>/... is derived from the script's own location
    (an exported REPO still wins); a CRLF line ending (a checkout with core.autocrlf=true) is kept.
  - EDID base blocks written as hex (00FFFFFFFFFFFF00 + 120 bytes, valid checksum): the 0xFF serial
    descriptor text goes through the private map; for a unit with a synthetic serial (AU0000..., MOCK...)
    the 32-bit serial number becomes the serial's numeric tail and the manufacture week 1; the checksum is
    recomputed; the hex case is kept. Blocks with a bad checksum (deliberate test data) are left alone.
  - The vendor's signed capability cache (EvniaServe/Config/data.json: {"data": ..., "sign": ...}): the
    "data" string is sanitized and the file re-signed like src/backend/ddc/cap-cache.ts
    (base64 HMAC-SHA256 with the vendor key, Newtonsoft string escaping), so it still verifies; the file
    is untouched when its data does not change.
  - Everything else through the private map. Byte-exact fixtures stay byte-exact apart from the replaced
    values: the UTF-8 BOM, CRLF/LF/mixed line endings and a missing final newline are preserved, fixture
    values keep their length, and no replacement introduces a character JSON would escape, so values inside
    nested JSON strings (Default.pcenter ProfileContent) are rewritten in place. Guards, per file: a file
    that parsed as JSON must still parse, with the same nested JSON strings parseable; *.json, *.pcenter,
    *.cfg and *.data under fixtures/ must keep their byte length.

GENERIC CHECKS (--check, no map needed)
  home-path       a Windows/WSL/Git-Bash home path or /home/<name> with a real-looking user name
  monitor-serial  AU + digits not starting with AU0000, or a 2 letters + 11 digits token without four
                  leading zeros (the synthetic ones)
  edid            a hex EDID whose 0xFF serial is not synthetic, or a synthetic unit with week or serial
                  number not normalized
  usb-serial      a USB serial in a Windows device path (usb#vid_...&pid_...#SERIAL#) that is not a known
                  synthetic or generic firmware value
  instance-id     a Windows device-instance ParentIdPrefix hash (N&HASH&n) that is not synthetic (0...0x)
  device          a Windows device path of a third-party USB/HID device (VID not 2109, 0cf2, 25aa, 0000)
  mac, email      MAC addresses; e-mail addresses outside example domains and the Debian copyright file
  gpu, os         a specific GPU model; a Windows "N" edition or a full build number with UBR
  private-map     the private map is inside the tree (git-ignored or not)
  A line containing the marker "sanitize-public: allow" is exempt from the generic checks (for synthetic
  test inputs, as in --self-test); the private map's identifiers are reported everywhere. The rewrite never
  touches this script or the private map. The self-test's values are arbitrary and must stay so: never
  derive a test value from a real one.

EXIT STATUS
  0 done / clean; 1 --check found something, or a verification failed (nothing written); 2 usage error or
  missing private map (without --public-only).
"""

import argparse
import base64
import hmac
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
from pathlib import Path

SCRIPT = Path(__file__).resolve()
MAP_NAME = 'sanitize-public.local.json'
MAP_ENV = 'SANITIZE_PUBLIC_MAP'


def default_map():
    """$SANITIZE_PUBLIC_MAP; else <checkout>-private/<MAP_NAME> beside the checkout; else next to the script."""
    env = os.environ.get(MAP_ENV)
    if env:
        return Path(env)
    checkout = SCRIPT.parent.parent
    sibling = checkout.parent / (checkout.name + '-private') / MAP_NAME
    return sibling if sibling.is_file() else SCRIPT.with_name(MAP_NAME)

SKIP_DIR_NAMES = {'.git', '.git-rewrite', 'node_modules', 'build', 'dist', '__pycache__'}
SKIP_PREFIXES = ('work/', 'Evnia Precision Center/', 'port/test/e2e/artifacts/', 'port/test/install/artifacts/')

# ---------------------------------------------------------------------------------------------------------
# Public part of the mapping table: synthetic values and allowlists.
# ---------------------------------------------------------------------------------------------------------

FAKE_USER = 'user'
# EDID / TPV serials that are synthetic: the anonymized captured unit and test twins (AU0000...), and the
# shipped simulator (MOCK000000001, src/backend/ddc/transports/mock-34m2c8600.ts).
FAKE_MONITOR_SERIAL = re.compile(r'^(?:AU0000\d+|MOCK\d+)$')
# Serial-shaped tokens (2 letters + 11 digits) that are obviously invented: four or more leading zeros.
SYNTHETIC_SERIAL13 = re.compile(r'^[A-Z]{2}0000\d{7}$')
# USB serial strings allowed in Windows device paths: synthetic ones, and generic firmware values of the
# monitor's own VIA hub/bridge (the same on every unit).
ALLOWED_USB_SERIALS = {
    '0000000002', 'serialkeyboard01', 'serialmouse1', 'serialaudiodevice1',
    'msft30000000000', 'msft20000000000', '0000000000000001',
}
# USB vendor IDs allowed in captured Windows device paths: the monitor's own functions (VIA 2109, ENE 0cf2),
# the vendor's peripherals quoted from its code (25aa), synthetic devices (0000).
ALLOWED_DEVICE_VIDS = {'2109', '0cf2', '25aa', '0000'}
ALLOWED_HOME_NAMES = {'user', 'u', 'public', 'default', 'default user', 'all users', 'username', '...', '\u2026'}
ALLOWED_LINUX_HOMES = {'user', 'u', 'tester', 'runner', 'username', '...', '…'}
EMAIL_ALLOWED_DOMAIN = re.compile(r'(?i)(?:^|\.)(?:example\.(?:org|com|net)|[a-z0-9-]*\.?example|localhost|invalid|test|\d+\.service)$')
EMAIL_ALLOWED_FILES = ('port/packaging/deb/copyright',)  # public upstream copyright holders
EMAIL_ALLOWED = {
    'appindicatorsupport@rgcjonas.gmail.com',  # a GNOME Shell extension UUID, not a mailbox
    'noreply@anthropic.com',  # the Co-Authored-By trailer of AI-assisted commits (commit messages)
}

# A line containing this marker is exempt from the generic checks (not from the private map): synthetic
# test inputs such as the ones of --self-test below.
ALLOW_PRAGMA = 'sanitize-public: allow'

# The vendor's HMAC key for the capability cache (src/backend/ddc/cap-cache.ts CAP_CACHE_HMAC_KEY).
CAP_CACHE_KEY = b'WhaleTV_Serizlize_2026'


class SanitizeError(Exception):
    pass


# ---------------------------------------------------------------------------------------------------------
# Private map
# ---------------------------------------------------------------------------------------------------------

class Table:
    """The literal old -> new table: longest match first, one pass (so replaced text is never re-matched)."""

    def __init__(self, pairs=(), check=(), check_ci=(), check_re=()):
        self.map = {}
        for pair in pairs:
            if not (isinstance(pair, (list, tuple)) and len(pair) == 2 and all(isinstance(x, str) for x in pair)):
                raise SanitizeError('map: every "replace" entry must be [old, new] strings: %r' % (pair,))
            old, new = pair
            if not old:
                raise SanitizeError('map: empty "old" key')
            if old in self.map and self.map[old] != new:
                raise SanitizeError('map: "%s" is mapped twice' % old)
            self.map[old] = new
        for old, new in self.map.items():
            for key in self.map:
                if key in new:
                    raise SanitizeError('map: the replacement of "%s" contains the key "%s" (not idempotent)' % (old, key))
        keys = sorted(self.map, key=lambda k: (-len(k), k))
        self._rx = re.compile('|'.join(re.escape(k) for k in keys)) if keys else None
        cs = sorted(set(list(self.map) + [t for t in check if t]), key=lambda k: (-len(k), k))
        ci = sorted({t for t in check_ci if t}, key=lambda k: (-len(k), k))
        self.check_rx = re.compile('|'.join(re.escape(t) for t in cs)) if cs else None
        self.check_ci_rx = re.compile('|'.join(re.escape(t) for t in ci), re.IGNORECASE) if ci else None
        self.check_res = []
        for pattern in check_re:
            if not isinstance(pattern, str) or not pattern:
                raise SanitizeError('map: every "check_re" entry must be a non-empty string: %r' % (pattern,))
            try:
                self.check_res.append(re.compile(pattern))
            except re.error as e:
                raise SanitizeError('map: bad "check_re" pattern %r: %s' % (pattern, e))

    @property
    def empty(self):
        return self._rx is None

    def apply(self, text):
        if self._rx is None:
            return text
        return self._rx.sub(lambda m: self.map[m.group(0)], text)


def load_table(path):
    try:
        raw = json.loads(Path(path).read_text(encoding='utf-8-sig'))
    except FileNotFoundError:
        return None
    except (OSError, ValueError) as e:
        raise SanitizeError('cannot read the private map %s: %s' % (path, e))
    if not isinstance(raw, dict):
        raise SanitizeError('map: top level must be an object')
    return Table(raw.get('replace', []), raw.get('check', []), raw.get('check_ci', []), raw.get('check_re', []))


# ---------------------------------------------------------------------------------------------------------
# Special handlers
# ---------------------------------------------------------------------------------------------------------

EDID_RE = re.compile(r'(?<![0-9A-Fa-f])00[Ff]{12}00[0-9A-Fa-f]{240}')
FF_OFFSETS = (54, 72, 90, 108)


def edid_serial_text(block):
    """(offset, text) of the 0xFF (serial) display descriptor of a 128-byte base block, or (None, None)."""
    for off in FF_OFFSETS:
        d = block[off:off + 18]
        if d[0] == 0 and d[1] == 0 and d[2] == 0 and d[3] == 0xFF:
            text = bytes(d[5:18]).decode('latin-1')
            end = text.find('\n')
            return off, (text if end < 0 else text[:end]).rstrip(' ')
    return None, None


def serial_tail(serial):
    m = re.search(r'(\d+)$', serial)
    return int(m.group(1)) & 0xFFFFFFFF if m else 0


def fix_edid_hex(hexstr, table):
    """Sanitize one base block given as 256 hex digits (see the module doc). Returns the new hex."""
    b = bytearray.fromhex(hexstr)
    if sum(b) & 0xFF:
        return hexstr
    changed = False
    off, serial = edid_serial_text(b)
    if off is not None:
        new = table.apply(serial)
        if new != serial:
            if len(new) > 13:
                raise SanitizeError('EDID serial replacement "%s" is longer than 13 characters' % new)
            field = new if len(new) == 13 else (new + '\n' + ' ' * 12)[:13]
            b[off + 5:off + 18] = field.encode('latin-1')
            serial = new
            changed = True
        if FAKE_MONITOR_SERIAL.match(serial):
            n = serial_tail(serial)
            if int.from_bytes(b[12:16], 'little') != n:
                b[12:16] = n.to_bytes(4, 'little')
                changed = True
            if b[16] not in (0, 1, 0xFF):
                b[16] = 1
                changed = True
    if not changed:
        return hexstr
    b[127] = (-sum(b[:127])) & 0xFF
    out = b.hex()
    return out if re.search(r'[a-f]', hexstr) else out.upper()


def fix_edids(text, table):
    return EDID_RE.sub(lambda m: fix_edid_hex(m.group(0), table), text)


def net_string(s):
    """Newtonsoft's default string escaping (= JSON.stringify plus NEL/LS/PS), as cap-cache.ts writes it."""
    j = json.dumps(s, ensure_ascii=False)
    return j.replace('\u0085', '\\u0085').replace('\u2028', '\\u2028').replace('\u2029', '\\u2029')


def cap_cache_sign(data):
    return base64.b64encode(hmac.new(CAP_CACHE_KEY, data.encode('utf-8'), hashlib.sha256).digest()).decode('ascii')


def signed_cache(text):
    """The parsed {"data", "sign"} object when text is a vendor-signed capability cache that verifies."""
    body = text.lstrip('\ufeff')
    if not body.startswith('{'):
        return None
    try:
        o = json.loads(body)
    except ValueError:
        return None
    if not isinstance(o, dict) or set(o) != {'data', 'sign'} or not all(isinstance(v, str) for v in o.values()):
        return None
    if not hmac.compare_digest(cap_cache_sign(o['data']), o['sign']):
        return None
    return o


def resign_cache(text, o, new_data):
    bom = text[:len(text) - len(text.lstrip('\ufeff'))]
    body = text[len(bom):]
    stripped = body.rstrip()
    trailer = body[len(stripped):]
    old = '{"data":%s,"sign":%s}' % (net_string(o['data']), net_string(o['sign']))
    if stripped != old:
        raise SanitizeError('signed cache: cannot reproduce its encoding, so it cannot be re-signed safely')
    return bom + '{"data":%s,"sign":%s}' % (net_string(new_data), net_string(cap_cache_sign(new_data))) + trailer


# ---------------------------------------------------------------------------------------------------------
# Generic path rules
# ---------------------------------------------------------------------------------------------------------

NAME = r'[^\\/\s"\'`<>|*?:%$&;,()\[\]{}]+'
WIN_HOME = re.compile(r'(?P<pre>(?<![A-Za-z])[A-Za-z]:(?P<sep>\\+|/)Users(?P=sep))(?P<name>' + NAME + ')', re.IGNORECASE)
UNIX_HOME = re.compile(r'(?P<pre>(?:/mnt/[a-z]|(?<![\w.~-])/[a-z])/Users/)(?P<name>' + NAME + ')', re.IGNORECASE)
LINUX_HOME = re.compile(r'(?<![\w.~-])/home/(?P<name>' + NAME + ')')
# (?P<cr>) keeps a CRLF ending: '$' matches only before '\n', and a Windows checkout with core.autocrlf=true
# (as filter-branch makes for commits older than .gitattributes) has '\r' there.
SH_REPO = re.compile(r'^(?P<indent>[ \t]*)(?P<export>export[ \t]+)?REPO=["\']?/mnt/[a-z]/Users/[^\s"\']+["\']?[ \t]*(?P<cr>\r?)$', re.MULTILINE)
DOCKER_MOUNT = re.compile(r'(?<![A-Za-z])[A-Za-z]:\\Users\\' + NAME + r'(?:\\[^\\":\s]+)*(?=:/repo\b)')
MD_CHECKOUT = re.compile(r'`[A-Za-z]:/Users/' + NAME + r'/GitHub/[^/`\s]+/?`')
MD_WSL_CHECKOUT = re.compile(r'/mnt/[a-z]/Users/' + NAME + r'/GitHub/[^/`\s"\']+')
MD_APPDATA = re.compile(r'(?<![A-Za-z])[A-Za-z]:(?P<s>[\\/])Users(?P=s)(?P<name>' + NAME + r')(?P=s)AppData(?P=s)(?P<which>Roaming|Local)(?![A-Za-z])')
MD_PROFILE = re.compile(r'(?<![A-Za-z])[A-Za-z]:(?P<s>[\\/])Users(?P=s)(?P<name>' + NAME + r')(?=[\\/`"\'\s]|$)', re.MULTILINE)


def real_home_name(name):
    return name.lower() not in ALLOWED_HOME_NAMES


def generic_paths(rel, text):
    if rel.endswith('.sh'):
        depth = rel.count('/')

        def sh_repl(m):
            up = '/'.join(['..'] * depth)
            where = '"$(dirname "${BASH_SOURCE[0]}")' + ('/' + up if up else '') + '"'
            return '%s%sREPO="${REPO:-$(cd %s && pwd)}"%s' % (m.group('indent'), m.group('export') or '', where, m.group('cr'))

        text = SH_REPO.sub(sh_repl, text)
    text = DOCKER_MOUNT.sub(lambda m: 'C:\\path\\to\\repo', text)
    if rel.endswith('.md'):
        text = MD_CHECKOUT.sub('the repository root', text)
        text = MD_WSL_CHECKOUT.sub('<repo>', text)
        text = MD_APPDATA.sub(lambda m: '%APPDATA%' if m.group('which') == 'Roaming' else '%LOCALAPPDATA%', text)
        text = MD_PROFILE.sub(lambda m: '%USERPROFILE%' if real_home_name(m.group('name')) else m.group(0), text)

    def home_repl(m):
        return m.group('pre') + (FAKE_USER if real_home_name(m.group('name')) else m.group('name'))

    text = WIN_HOME.sub(home_repl, text)
    text = UNIX_HOME.sub(home_repl, text)
    return text


# ---------------------------------------------------------------------------------------------------------
# The pipeline
# ---------------------------------------------------------------------------------------------------------

def sanitize_text(rel, text, table):
    o = signed_cache(text)
    if o is not None:
        new_data = sanitize_text(rel + '#data', o['data'], table)
        return text if new_data == o['data'] else resign_cache(text, o, new_data)
    text = fix_edids(text, table)
    text = generic_paths(rel, text)
    return table.apply(text)


def json_shape(text):
    """None if text is not a JSON document; else, in traversal order, which string values hold JSON."""
    body = text.lstrip('\ufeff').strip()
    if not body[:1] in ('{', '['):
        return None
    try:
        root = json.loads(body)
    except ValueError:
        return None
    flags = []

    def walk(v):
        if isinstance(v, dict):
            for x in v.values():
                walk(x)
        elif isinstance(v, list):
            for x in v:
                walk(x)
        elif isinstance(v, str) and v.strip()[:1] in ('{', '['):
            try:
                inner = json.loads(v)
            except ValueError:
                flags.append(False)
                return
            flags.append(True)
            walk(inner)

    walk(root)
    return flags


FIXTURE_EXTS = ('.json', '.pcenter', '.cfg', '.data')


def sanitize_file(rel, text, table):
    """New text for one file, verified (idempotence, JSON shape, fixture length)."""
    new = sanitize_text(rel, text, table)
    if new == text:
        return text
    again = sanitize_text(rel, new, table)
    if again != new:
        raise SanitizeError('%s: the rules are not idempotent here (a second run changes it again)' % rel)
    before = json_shape(text)
    if before is not None and json_shape(new) != before:
        raise SanitizeError('%s: the file (or a nested JSON string in it) no longer parses as before' % rel)
    if ('/' + rel).find('/fixtures/') >= 0 and rel.endswith(FIXTURE_EXTS):
        if len(new.encode('utf-8')) != len(text.encode('utf-8')):
            raise SanitizeError('%s: a byte-exact fixture would change its length' % rel)
    return new


# ---------------------------------------------------------------------------------------------------------
# Checks
# ---------------------------------------------------------------------------------------------------------

AU_SERIAL = re.compile(r'(?i)(?<![A-Za-z0-9])AU(?!0000)\d{4,}')
SERIAL13 = re.compile(r'(?<![A-Za-z0-9])[A-Z]{2}\d{11}(?![0-9])')
USB_PATH_SERIAL = re.compile(r'(?i)usb#vid_[0-9a-f]{4}&pid_[0-9a-f]{4}#(?P<serial>[^#\s{}]+)#')
INSTANCE_ID = re.compile(r'(?i)(?<![0-9a-z&])[0-9a-f]&(?P<hash>[0-9a-f]{5,8})&\d')
DEVICE_PATH = re.compile(r'(?i)(?:hid|usb)#vid_(?P<vid>[0-9a-f]{4})&pid_[0-9a-f]{4}')
MAC = re.compile(r'(?i)(?<![0-9a-f:.-])(?:[0-9a-f]{2}([:-]))(?:[0-9a-f]{2}\1){4}[0-9a-f]{2}(?![0-9a-f:.-])')
# Not preceded by ':' or '/': URL userinfo (http://u:p@host) and systemd unit names (/user@1000.service).
EMAIL = re.compile(r'(?<![:/\w.%+-])[A-Za-z0-9._%+-]+@(?P<domain>[A-Za-z0-9.-]+\.[A-Za-z]{2,})')
GPU = re.compile(r'(?i)\b(?:radeon\s+(?:rx|pro|vii|r[579])\s*[0-9]\w*|rx\s?[4-9]\d{3}\b|g[e]force|rtx\s?\d{3,4}\b|gtx\s?\d{3,4}\b|q[u]adro|arc\s+[ab]\d{3}\b)')
WIN_EDITION = re.compile(r'(?i)\bwindows\s+1[01]\s+(?:pro|home|enterprise|education)(?:\s+for\s+workstations)?\s+N\b|\b10\.0\.\d{5}\.\d{2,5}\b')


def line_of(text, pos):
    return text.count('\n', 0, pos) + 1


def excerpt(text, start, end):
    a = max(text.rfind('\n', 0, start) + 1, start - 30)
    b = text.find('\n', end)
    b = len(text) if b < 0 else b
    b = min(b, end + 30)
    return text[a:b].replace('\t', ' ').strip()[:160]


def check_text(rel, text, table):
    hits = []

    def hit(rule, m, start=None, end=None):
        s = m.start() if start is None else start
        e = m.end() if end is None else end
        if rule != 'private-map':
            eol = text.find('\n', s)
            if ALLOW_PRAGMA in text[text.rfind('\n', 0, s) + 1:len(text) if eol < 0 else eol]:
                return
        hits.append((line_of(text, s), rule, excerpt(text, s, e)))

    for rx in (WIN_HOME, UNIX_HOME):
        for m in rx.finditer(text):
            if real_home_name(m.group('name')):
                hit('home-path', m)
    for m in LINUX_HOME.finditer(text):
        if m.group('name').lower() not in ALLOWED_LINUX_HOMES:
            hit('home-path', m)
    for m in AU_SERIAL.finditer(text):
        hit('monitor-serial', m)
    for m in SERIAL13.finditer(text):
        if not SYNTHETIC_SERIAL13.match(m.group(0)) and not AU_SERIAL.match(m.group(0)):
            hit('monitor-serial', m)
    for m in EDID_RE.finditer(text):
        b = bytes.fromhex(m.group(0))
        off, serial = edid_serial_text(b)
        n = int.from_bytes(b[12:16], 'little')
        if serial is not None and not FAKE_MONITOR_SERIAL.match(serial):
            hit('edid', m, m.start(), m.start() + 60)
        elif serial is not None and (n != serial_tail(serial) or b[16] not in (0, 1, 0xFF)):
            hit('edid', m, m.start(), m.start() + 60)
        elif serial is None and n not in (0, 1):
            hit('edid', m, m.start(), m.start() + 60)
    for m in USB_PATH_SERIAL.finditer(text):
        s = m.group('serial')
        if s.lower() not in ALLOWED_USB_SERIALS and not re.match(r'(?i)^[0-9a-f]&[0-9a-f]+(?:&[0-9a-f]+)*$', s) \
                and not re.match(r'(?i)^root_hub', s):
            hit('usb-serial', m)
    for m in INSTANCE_ID.finditer(text):
        if not re.match(r'(?i)^0+[1-9a-f]$', m.group('hash')):
            hit('instance-id', m)
    for m in DEVICE_PATH.finditer(text):
        if m.group('vid').lower() not in ALLOWED_DEVICE_VIDS:
            hit('device', m)
    for m in MAC.finditer(text):
        if m.group(0).lower().replace('-', ':') not in ('00:00:00:00:00:00', 'ff:ff:ff:ff:ff:ff'):
            hit('mac', m)
    if not rel.endswith(EMAIL_ALLOWED_FILES):
        for m in EMAIL.finditer(text):
            if not EMAIL_ALLOWED_DOMAIN.search(m.group('domain')) and m.group(0).lower() not in EMAIL_ALLOWED:
                hit('email', m)
    for m in GPU.finditer(text):
        hit('gpu', m)
    for m in WIN_EDITION.finditer(text):
        hit('os', m)
    if table is not None:
        for rx in [table.check_rx, table.check_ci_rx] + table.check_res:
            if rx is not None:
                for m in rx.finditer(text):
                    hit('private-map', m)
    return hits


# ---------------------------------------------------------------------------------------------------------
# Files
# ---------------------------------------------------------------------------------------------------------

def skipped(rel):
    parts = rel.split('/')
    if any(p in SKIP_DIR_NAMES for p in parts[:-1]):
        return True
    return rel.startswith(SKIP_PREFIXES)


def walk_files(root, start=''):
    """Relative POSIX paths of the files below root/start, pruning the skipped directories."""
    rels = []
    for dirpath, dirnames, filenames in os.walk(str(root / start) if start else str(root)):
        reld = os.path.relpath(dirpath, str(root)).replace(os.sep, '/')
        reld = '' if reld == '.' else reld + '/'
        dirnames[:] = sorted(d for d in dirnames
                             if d not in SKIP_DIR_NAMES and not (reld + d + '/').startswith(SKIP_PREFIXES))
        rels.extend(reld + f for f in sorted(filenames))
    return rels


def git_ls(root, *args):
    """git ls-files -z <args> in root, as a list of paths, or None when git is not usable there."""
    if not (root / '.git').exists() or not shutil.which('git'):
        return None
    env = dict(os.environ)
    for k in ('GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE'):
        env.pop(k, None)
    try:
        out = subprocess.run(['git', '-C', str(root), 'ls-files', '-z'] + list(args),
                             check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE, env=env).stdout
    except (OSError, subprocess.CalledProcessError):
        return None
    return [p for p in out.decode('utf-8', 'surrogateescape').split('\0') if p]


def list_files(root):
    """Relative POSIX paths of the candidate files, and the listing mode ('git' or 'walk')."""
    rels = git_ls(root, '--cached', '--others', '--exclude-standard')
    mode = 'git'
    if rels is None:
        rels, mode = walk_files(root), 'walk'
    return sorted({r for r in rels if not skipped(r)}), mode


def list_ignored(root):
    """The git-ignored files present in a git work tree, outside the skipped directories (walk mode: none)."""
    entries = git_ls(root, '--others', '--ignored', '--exclude-standard', '--directory')
    rels = set()
    for entry in entries or ():
        if entry.endswith('/'):
            if not skipped(entry + 'x'):
                rels.update(walk_files(root, entry.rstrip('/')))
        else:
            rels.add(entry)
    return sorted(r for r in rels if not skipped(r))


def read_text(path):
    try:
        if path.is_symlink() or not path.is_file():
            return None
        data = path.read_bytes()
    except OSError:
        return None
    if b'\0' in data[:8192]:
        return None
    try:
        return data.decode('utf-8')
    except UnicodeDecodeError:
        return None


# ---------------------------------------------------------------------------------------------------------
# Self-test
# ---------------------------------------------------------------------------------------------------------

def self_test():
    ok = True

    def expect(cond, what):
        nonlocal ok
        print(('ok    ' if cond else 'FAIL  ') + what)
        ok = ok and cond

    table = Table([['XX12345678901', 'AU00000000001'], ['secret-token', 'hidden-token']],  # sanitize-public: allow
                  check_ci=['xx1234'], check_re=[r'(?i)\bq7-\d{3}\b'])
    # EDID of an invented unit (arbitrary values, unrelated to any real one: product, serial number 4321,
    # week 37 of 2023) whose serial number and week are not normalized yet.
    base = bytearray(128)
    base[0:8] = bytes.fromhex('00FFFFFFFFFFFF00')
    base[8:12] = bytes.fromhex('41 0C 34 12')
    base[12:16] = (4321).to_bytes(4, 'little')
    base[16], base[17], base[18], base[19] = 37, 2023 - 1990, 1, 4
    base[72:77] = bytes([0, 0, 0, 0xFF, 0])
    base[77:90] = b'XX12345678901'  # sanitize-public: allow
    base[127] = (-sum(base[:127])) & 0xFF
    src = 'RAW DUMP: ' + base.hex().upper() + '\r\n'
    out = sanitize_file('x/log.txt', src, table)
    b = bytes.fromhex(out[len('RAW DUMP: '):len('RAW DUMP: ') + 256])
    expect(b[77:90] == b'AU00000000001', 'EDID: serial descriptor mapped')
    expect(int.from_bytes(b[12:16], 'little') == 1 and b[16] == 1 and b[17] == 2023 - 1990,
           'EDID: serial number 1, week 1, year kept')
    expect(sum(b) & 0xFF == 0, 'EDID: checksum recomputed')
    expect(out.endswith('\r\n') and out[10:12] == '00' and out == out.upper(), 'EDID: CRLF and hex case kept')
    expect(sanitize_file('x/log.txt', out, table) == out, 'EDID: idempotent')
    bad = bytearray(base)
    bad[20] ^= 1
    broken = 'RAW DUMP: ' + bad.hex().upper()
    expect(sanitize_text('x/log.txt', broken, table) == broken, 'EDID: a block with a bad checksum is left alone')
    # Signed capability cache.
    data = '[{"Name":"PHL secret-token","Datas":[{"Key":"k","Vcp":"(a \\"b\\")"}]}]'
    cache = '\ufeff{"data":%s,"sign":%s}' % (net_string(data), net_string(cap_cache_sign(data)))
    new = sanitize_file('fixtures/Config/data.json', cache, table)
    o = json.loads(new.lstrip('\ufeff'))
    expect('hidden-token' in o['data'] and 'secret-token' not in new, 'data.json: signed data sanitized')
    expect(new.startswith('\ufeff') and cap_cache_sign(o['data']) == o['sign'], 'data.json: BOM kept and re-signed')
    expect(sanitize_file('fixtures/Config/data.json', cache.replace('secret', 'public'), table) == cache.replace('secret', 'public'),
           'data.json: untouched when nothing changes')
    # Nested JSON (ProfileContent) and byte-exact fixture.
    inner = json.dumps({'sSerialNumber': 'XX12345678901', 'path': 'C:\\Users\\alice\\x'}, separators=(',', ':'))  # sanitize-public: allow
    outer = '\ufeff' + json.dumps({'Profiles': [{'ProfileContent': inner}]}, separators=(',', ':'), ensure_ascii=False)
    new = sanitize_file('a/theme/Default.pcenter', outer, table)
    content = json.loads(json.loads(new.lstrip('\ufeff'))['Profiles'][0]['ProfileContent'])
    expect(content['sSerialNumber'] == 'AU00000000001' and content['path'] == 'C:\\Users\\user\\x',
           'nested JSON: values replaced in place, still parses')
    expect(len(sanitize_file('a/fixtures/Default.pcenter', outer.replace('alice', 'user'), table)) == len(outer) - 1,
           'fixture length guard: same-length replacements pass')
    try:
        sanitize_file('a/fixtures/Default.pcenter', outer, table)
        expect(False, 'fixture length guard')
    except SanitizeError:
        expect(True, 'fixture length guard: a length change in a byte-exact fixture is refused')
    # Paths.
    md = 'See `C:/Users/alice/AppData/Roaming/EvniaServe/logs/x.txt` and `C:/Users/alice/GitHub/proj/`, `C:\\Users\\<you>\\x`.\n'  # sanitize-public: allow
    got = sanitize_file('docs/a.md', md, Table())
    expect(got == 'See `%APPDATA%/EvniaServe/logs/x.txt` and the repository root, `C:\\Users\\<you>\\x`.\n', 'Markdown paths: ' + got.strip())
    sh = '#!/usr/bin/env bash\nexport REPO=/mnt/c/Users/alice/GitHub/proj\n'  # sanitize-public: allow
    got = sanitize_file('tools/env.sh', sh, Table())
    expect('REPO="${REPO:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"' in got and 'alice' not in got, 'shell REPO derived from the script location')
    crlf = sanitize_file('tools/env.sh', sh.replace('\n', '\r\n'), Table())
    expect(crlf == got.replace('\n', '\r\n'), 'shell REPO: a CRLF checkout gets the same result, CRLF kept')
    got = sanitize_file('port/t.txt', 'x C:\\\\Users\\\\alice\\\\AppData y /mnt/c/Users/alice/z', Table())  # sanitize-public: allow
    expect(got == 'x C:\\\\Users\\\\user\\\\AppData y /mnt/c/Users/user/z', 'escaped and WSL home paths: ' + got)
    hits = check_text('port/t.txt', 'C:\\Users\\alice\\x usb#vid_1234&pid_5678#abc123#{x} 9&1a2b3c4&0&0000 xx12345', table)  # sanitize-public: allow
    rules = sorted({h[1] for h in hits})
    expect(rules == ['device', 'home-path', 'instance-id', 'private-map', 'usb-serial'], 'check rules: %s' % rules)
    expect(check_text('port/t.txt', 'C:\\Users\\user\\x usb#vid_2109&pid_8884#0000000000000001#{x} 7&0000005&0&UID1', table) == [],
           'check: synthetic values are clean')
    expect([h[1] for h in check_text('port/t.txt', 'id Q7-123 here\n', table)] == ['private-map'],
           'check: the private map\'s check_re patterns are reported')
    # Commit messages (--stdin, the filter-branch --msg-filter).
    msg = 'Merge pull request #1 from secret-token/topic\n\nSee C:\\Users\\alice\\x\n'  # sanitize-public: allow
    expect(sanitize_file('<stdin>', msg, table) == 'Merge pull request #1 from hidden-token/topic\n\nSee C:\\Users\\user\\x\n',
           'commit message: map and home paths applied')
    try:
        Table([['a', 'xab']])
        expect(False, 'map validation')
    except SanitizeError:
        expect(True, 'map validation: a replacement containing a key is refused')
    try:
        Table(check_re=['(unclosed'])
        expect(False, 'map validation: check_re')
    except SanitizeError:
        expect(True, 'map validation: a bad check_re pattern is refused')
    return ok


# ---------------------------------------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------------------------------------

def filter_stdin(table, check):
    """--stdin: sanitize standard input to standard output (byte-exact apart from the replacements), or check it."""
    data = sys.stdin.buffer.read()
    try:
        text = data.decode('utf-8')
    except UnicodeDecodeError:
        text = None
    if check:
        hits = check_text('<stdin>', data.decode('utf-8', 'replace') if text is None else text, table)
        for ln, rule, ex in hits:
            print('<stdin>:%d: %s: %s' % (ln, rule, ex))
        print('sanitize-public --check --stdin: %d hit(s)%s' % (len(hits), '' if table is not None else ' [generic patterns only]'),
              file=sys.stderr)
        return 1 if hits else 0
    if text is None:
        print('sanitize-public: --stdin: the input is not UTF-8', file=sys.stderr)
        return 1
    try:
        new = sanitize_file('<stdin>', text, table or Table())
    except SanitizeError as e:
        print('sanitize-public: %s' % e, file=sys.stderr)
        return 1
    sys.stdout.buffer.write(new.encode('utf-8'))
    sys.stdout.buffer.flush()
    return 0


def main(argv):
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding='utf-8', errors='replace')
        except (AttributeError, ValueError):
            pass
    ap = argparse.ArgumentParser(description='Sanitize the repository for publication (see the module doc).')
    ap.add_argument('--tree', default=None, help='tree to process (default: the repository of this script)')
    ap.add_argument('--map', default=None,
                    help='private mapping table (default: $%s, else %s)' % (MAP_ENV, default_map()))
    ap.add_argument('--check', action='store_true', help='report remaining identifiers, change nothing')
    ap.add_argument('--stdin', action='store_true',
                    help='filter (or with --check: check) standard input, e.g. as git filter-branch --msg-filter')
    ap.add_argument('--public-only', action='store_true',
                    help='generic rules only: do not load or require the private map')
    ap.add_argument('--dry-run', action='store_true', help='report what a rewrite would change')
    ap.add_argument('--quiet', action='store_true', help='print only errors and the summary of --check')
    ap.add_argument('--self-test', action='store_true', help='run the built-in handler tests')
    args = ap.parse_args(argv)

    if args.self_test:
        return 0 if self_test() else 1

    map_arg = Path(args.map) if args.map else default_map()
    table = None
    if not args.public_only:
        try:
            table = load_table(map_arg)
        except SanitizeError as e:
            print('sanitize-public: %s' % e, file=sys.stderr)
            return 2
        if table is None:
            print('sanitize-public: the private map %s is missing; pass --map FILE or set %s, or pass --public-only '
                  'to use the generic rules alone' % (map_arg, MAP_ENV), file=sys.stderr)
            return 2

    if args.stdin:
        return filter_stdin(table, args.check)

    root = Path(args.tree).resolve() if args.tree else SCRIPT.parent.parent
    if not root.is_dir():
        print('sanitize-public: --tree %s is not a directory' % root, file=sys.stderr)
        return 2

    files, mode = list_files(root)
    try:
        map_path = map_arg.resolve()
    except OSError:
        map_path = None

    def is_map(rel):
        return Path(rel).name == MAP_NAME or (map_path is not None and (root / rel).resolve() == map_path)

    if args.check:
        ignored = list_ignored(root) if mode == 'git' else []
        hits = []
        for rel, where in [(r, '') for r in files] + [(r, ' [git-ignored]') for r in ignored]:
            if is_map(rel):
                hits.append((rel, 0, 'private-map' + where, 'the private mapping table is inside the tree: move it '
                             'outside the checkout (see --map)'))
            for (ln, rule, ex) in check_text(rel, rel, table):
                hits.append((rel, 0, rule + ' (file name)' + where, ex))
            text = read_text(root / rel)
            if text is None:
                continue
            for (ln, rule, ex) in check_text(rel, text, table):
                hits.append((rel, ln, rule + where, ex))
        for rel, ln, rule, ex in hits:
            print('%s:%d: %s: %s' % (rel, ln, rule, ex))
        n_files = len({h[0] for h in hits})
        print('sanitize-public --check: %d file(s) scanned (%s)%s, %d hit(s) in %d file(s)%s'
              % (len(files), mode, ', and %d git-ignored' % len(ignored) if mode == 'git' else '',
                 len(hits), n_files, '' if table is not None else ' [generic patterns only]'),
              file=sys.stderr)
        return 1 if hits else 0

    table = table or Table()
    changes = []
    for rel in files:
        path = root / rel
        # Never rewrite the private map, or this script (its --self-test inputs are synthetic identifiers;
        # --check still scans it).
        if Path(rel).name == SCRIPT.name or is_map(rel):
            continue
        text = read_text(path)
        if text is None:
            continue
        try:
            new = sanitize_file(rel, text, table)
        except SanitizeError as e:
            print('sanitize-public: %s' % e, file=sys.stderr)
            return 1
        if new != text:
            changes.append((rel, path, new))
    if not args.dry_run:
        for rel, path, new in changes:
            with open(str(path), 'wb') as f:
                f.write(new.encode('utf-8'))
    if not args.quiet:
        for rel, _, _ in changes:
            print(('would change ' if args.dry_run else 'changed ') + rel)
        print('sanitize-public: %d file(s) %s, %d scanned (%s)' % (len(changes), 'to change' if args.dry_run else 'changed',
                                                                    len(files), mode), file=sys.stderr)
    return 0


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
