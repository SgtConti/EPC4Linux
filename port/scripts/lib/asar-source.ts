// Read-only access to the vendor app.asar (01 §1 bundle anatomy). Files are extracted into memory
// one by one; nothing from the archive is executed and nothing outside the requested subtree is
// read. Every entry name of the header is validated when the archive is opened, so a crafted header
// cannot make the importer write outside its output directory.

import { existsSync, statSync } from 'node:fs';
import * as asar from '@electron/asar';
import { errnoOf, messageOf } from './io.ts';
import { ImportError } from './patch-engine.ts';

interface HeaderNode {
  files?: Record<string, HeaderNode>;
  link?: string;
  size?: number;
  unpacked?: boolean;
}

/** A single, non-empty path segment that is not `.` or `..` and has no separator or NUL. */
const SAFE_SEGMENT = /^(?!\.{1,2}$)[^/\\\0]+$/;

function unsafe(name: string, dir: string): ImportError {
  return new ImportError('ASAR_UNSAFE_PATH', `Refusing archive entry ${JSON.stringify(name)} in ${dir || '/'}`);
}

/** Throws ASAR_UNSAFE_PATH for the first entry name anywhere in the header that is not a safe segment. */
function validateNames(dir: HeaderNode, rel: string): void {
  for (const [name, child] of Object.entries(dir.files ?? {})) {
    if (!SAFE_SEGMENT.test(name)) throw unsafe(name, rel);
    if (child.files) validateNames(child, rel ? `${rel}/${name}` : name);
  }
}

export class AsarSource {
  readonly path: string;
  readonly #root: HeaderNode;

  constructor(asarPath: string) {
    if (!existsSync(asarPath) || !statSync(asarPath).isFile()) {
      throw new ImportError(
        'ASAR_MISSING',
        `Vendor archive not found: ${asarPath}. Pass --asar <path to "Evnia Precision Center/resources/app.asar"> or set EVNIA_VENDOR_ASAR.`,
      );
    }
    this.path = asarPath;
    let root: HeaderNode;
    try {
      root = asar.getRawHeader(asarPath).header as HeaderNode;
    } catch (err) {
      // @electron/asar 4.3 rejects "." and ".." and names containing "/" or "\" itself
      // (HeaderValidationError); report that as the refusal validateNames gives with versions that
      // do not validate, so the code does not depend on the installed minor version. Empty and NUL
      // names pass the library and are caught by validateNames.
      if ((err as Error).name === 'HeaderValidationError' && /invalid entry name/.test(messageOf(err))) {
        throw new ImportError('ASAR_UNSAFE_PATH', `Refusing ${asarPath}: ${messageOf(err)}`);
      }
      if (errnoOf(err)) throw new ImportError('ASAR_READ', `Cannot read ${asarPath}: ${messageOf(err)}`);
      throw new ImportError('ASAR_INVALID', `${asarPath} is not a readable asar archive: ${messageOf(err)}`);
    }
    validateNames(root, '');
    this.#root = root;
  }

  #node(path: string): HeaderNode | undefined {
    let node: HeaderNode | undefined = this.#root;
    for (const seg of path.split('/').filter(Boolean)) node = node?.files?.[seg];
    return node;
  }

  /** All regular files below `prefix` (e.g. "out/renderer"), as paths relative to `prefix`. */
  listFiles(prefix: string): string[] {
    const node = this.#node(prefix);
    if (!node?.files) throw new ImportError('ASAR_LAYOUT', `${this.path} has no directory ${prefix}; is this the Evnia Precision Center app.asar?`);
    const out: string[] = [];
    const walk = (dir: HeaderNode, rel: string): void => {
      for (const [name, child] of Object.entries(dir.files ?? {})) {
        const p = `${rel}${name}`;
        if (child.files) walk(child, `${p}/`);
        else if (child.link !== undefined) throw new ImportError('ASAR_LINK', `Unexpected symlink in vendor archive: ${prefix}/${p}`);
        else out.push(p);
      }
    };
    walk(node, '');
    return out.sort();
  }

  has(path: string): boolean {
    const node = this.#node(path);
    return node !== undefined && node.files === undefined && node.link === undefined;
  }

  read(path: string): Buffer {
    const node = this.#node(path);
    if (!node || node.files !== undefined || node.link !== undefined) {
      throw new ImportError('ASAR_FILE_MISSING', `${path} is missing from ${this.path}`);
    }
    try {
      return asar.extractFile(this.path, path, false);
    } catch (err) {
      const hint = node.unpacked
        ? ` The entry is stored outside the archive in ${this.path}.unpacked/; copy that directory together with app.asar.`
        : ' The archive may be truncated or damaged; copy it again from the Windows installation.';
      throw new ImportError('ASAR_READ', `Cannot read ${path} from ${this.path}: ${messageOf(err)}.${hint}`);
    }
  }
}
