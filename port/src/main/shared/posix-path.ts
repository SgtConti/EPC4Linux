// POSIX `path.join` / `path.basename` for the sandboxed preload, where Node's `path` module is not
// available. The renderer only uses them through window.nodeApi.pathJoin / getBaseName (02 §2.1) to
// build paths under userData and to derive profile names from picked files. Semantics follow
// node:path.posix (verified against it in test/unit/main/helpers.test.ts).

function normalizeSegments(path: string, absolute: boolean): string {
  const out: string[] = [];
  for (const seg of path.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (out.length > 0 && out[out.length - 1] !== '..') out.pop();
      else if (!absolute) out.push('..');
      continue;
    }
    out.push(seg);
  }
  return out.join('/');
}

export function normalize(path: string): string {
  if (path.length === 0) return '.';
  const absolute = path.startsWith('/');
  const trailing = path.endsWith('/');
  let body = normalizeSegments(path, absolute);
  if (body.length === 0 && !absolute) body = '.';
  if (body.length > 0 && trailing) body += '/';
  return absolute ? `/${body}` : body;
}

export function join(...parts: string[]): string {
  for (const p of parts) {
    if (typeof p !== 'string') throw new TypeError(`The "path" argument must be of type string. Received ${typeof p}`);
  }
  const joined = parts.filter((p) => p.length > 0).join('/');
  return joined.length === 0 ? '.' : normalize(joined);
}

export function basename(path: string, ext?: string): string {
  if (typeof path !== 'string') throw new TypeError(`The "path" argument must be of type string. Received ${typeof path}`);
  if (typeof ext === 'string' && ext.length > 0 && ext === path) return '';
  let end = path.length;
  while (end > 1 && path[end - 1] === '/') end--;
  const trimmed = path.slice(0, end);
  const base = trimmed === '/' ? '' : trimmed.slice(trimmed.lastIndexOf('/') + 1);
  if (typeof ext === 'string' && ext.length > 0 && base !== ext && base.endsWith(ext)) {
    return base.slice(0, base.length - ext.length);
  }
  return base;
}
