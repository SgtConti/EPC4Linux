// Content-Security-Policy rewrite for the vendor HTML entry points (02 §1.2, 14 N31).
//
// The vendor policy allows the Zeasn cloud, *.amazonaws.com, *.jsdelivr.net, third-party avatar
// CDNs and 'wasm-unsafe-eval'; notice.html has no policy at all. Every HTML file of the imported UI
// gets the same local-only policy. A <meta> CSP is enough here because the pages are loaded from
// file:// (there are no HTTP response headers); the main process kill-switch is the second layer.

import { ImportError } from './patch-engine.ts';

const META_RE = /<meta\s+http-equiv\s*=\s*["']Content-Security-Policy["'][^>]*>/gi;

export type CspAction = 'replaced' | 'inserted';

/** Returns the HTML with exactly one CSP <meta> carrying `policy`. */
export function rewriteCsp(path: string, html: string, policy: string): { html: string; action: CspAction } {
  if (policy.includes('"')) throw new ImportError('CSP_INVALID', 'CSP policy must not contain double quotes');
  const meta = `<meta http-equiv="Content-Security-Policy" content="${policy}"/>`;
  const existing = html.match(META_RE) ?? [];
  if (existing.length > 1) {
    throw new ImportError('CSP_AMBIGUOUS', `${path}: found ${existing.length} CSP <meta> tags, expected at most one`);
  }
  if (existing.length === 1) {
    return { html: html.replace(META_RE, () => meta), action: 'replaced' };
  }
  // No policy (vendor notice.html): insert it as the first element after <meta charset>, or after
  // <head> if there is no charset declaration, so it applies before any script or stylesheet.
  const anchor = /<meta\s+charset\s*=\s*["']?[\w-]+["']?\s*\/?>/i.exec(html) ?? /<head(\s[^>]*)?>/i.exec(html);
  if (!anchor) throw new ImportError('CSP_NO_HEAD', `${path}: no <head> to insert the CSP into`);
  const at = anchor.index + anchor[0].length;
  return { html: html.slice(0, at) + meta + html.slice(at), action: 'inserted' };
}

/** Extracts the policies of all CSP <meta> tags (used by the audit and the tests). */
export function readCspPolicies(html: string): string[] {
  return (html.match(META_RE) ?? []).map((tag) => /content\s*=\s*"([^"]*)"/i.exec(tag)?.[1] ?? '');
}
