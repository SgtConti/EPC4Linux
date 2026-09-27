// Types for the vendor-UI import pipeline (scripts/import-vendor-ui.mjs). The vendor-specific data
// (pinned files, patch table, removals, audit allowlist) lives in scripts/ui-patches.mjs; this
// directory holds the version-independent machinery. See docs/port/impl-vendor-ui.md.

/** A file of the vendor renderer that the pipeline modifies, pinned by exact name and SHA-256. */
export interface PinnedFile {
  /**
   * Glob relative to the renderer root (`out/renderer/` in the asar). Only `*` is supported and it
   * never matches `/`. Chunk names carry content hashes, so the glob (`assets/styles-*.js`) is what
   * identifies the chunk across vendor builds, while `path` pins the exact 1.13.0 file.
   */
  glob: string;
  /** Exact path relative to the renderer root, e.g. `assets/styles-DAnQi2A8.js`. */
  path: string;
  /** Lower-case hex SHA-256 of the unmodified vendor file. */
  sha256: string;
}

/** One literal (or anchored regular-expression) replacement. */
export interface PatchSpec {
  /** Stable identifier used in PATCHES.json, the impl notes and the touchpoint decisions. */
  id: string;
  /** Glob of the target file; must equal the `glob` of an entry in the pinned-file table. */
  file: string;
  /**
   * Literal text to find, or a RegExp (the `g` flag is added if missing). A RegExp is used only where
   * the anchor itself must not be committed to this repository (vendor cloud secrets).
   */
  find: string | RegExp;
  /** Literal replacement text. `$` sequences are never expanded, also for RegExp finds. */
  replace: string;
  /** Exact number of occurrences required (default 1). Any other count aborts the import. */
  expectCount?: number;
  /** Why the patch exists and why this form is safe. */
  rationale: string;
  /** Spec reference, e.g. "02 §L.3 P1; 14 N15". */
  spec: string;
}

/** A vendor file that is dropped from the imported UI (directories disappear once they are empty). */
export interface RemovalSpec {
  /** File path relative to the renderer root. */
  path: string;
  reason: string;
  spec: string;
  /**
   * Number of entries in vite `__vite__mapDeps` file tables that still name the removed file after
   * patching. Such an entry is inert only while no remaining `__vite__mapDeps([…])` preload call
   * uses its index, which the import verifies (removals.ts); any other reference to the file's
   * basename in the kept JS/HTML/CSS fails the import. The count must match exactly, so the table
   * documents what is left behind.
   */
  mapDepsEntries: number;
}

/** A vendor data file copied verbatim into build/vendor-data or build/vendor-assets. */
export interface CopySpec {
  /** Where the file comes from: the asar root, or the install's `resources/` directory next to the asar. */
  from: 'asar' | 'resources';
  /** Path relative to `from`. An asar source may use `*` in its last segment (e.g. `resources/*.png`). */
  source: string;
  /** Destination directory relative to the output directory (e.g. `vendor-data`). */
  destDir: string;
  /** Pinned SHA-256; omit only for globbed icon sets, which are copied without pinning. */
  sha256?: string;
}

/** A remote-looking URL that is allowed to remain in the imported UI because it is inert. */
export interface UrlAllowEntry {
  /** Exact URL text as it appears in the file (the scanner stops at quotes, whitespace and `)`). */
  url: string;
  reason: string;
}

/** A reviewed network-API call site that may remain in the imported UI. */
export interface ReviewedSite {
  /** Glob of the file (renderer-root relative). */
  file: string;
  /** API kind as reported by the audit scanner (see audit.ts `NETWORK_APIS`). */
  api: string;
  /** A literal substring identifying the site: it must occur between 160 characters before and 80 after the match. */
  context: string;
  /** Exact number of call sites this entry covers. */
  count: number;
  reason: string;
}

/**
 * A reviewed scheme-only literal (`"https://"`, `"ws://"`). Such a literal is how a URL is built by
 * concatenation (`"https://"+host+"/api"`), which the URL scanner cannot judge, so every one must be
 * covered by an entry explaining why it does not build a remote URL.
 */
export interface ReviewedScheme {
  /** Glob of the file (renderer-root relative). */
  file: string;
  /** A literal substring identifying the site: it must occur between 160 characters before and 80 after the literal. */
  context: string;
  /** Exact number of scheme-only literals this entry covers. */
  count: number;
  reason: string;
}

/** Recorded decision for one online touchpoint of 14-online-sweep.md (N01..N40). */
export interface TouchpointDecision {
  id: string;
  what: string;
  /**
   * `patched`: neutralized by patches in this table (and/or the CSP rewrite); `removed`: code dropped
   * from the UI; `main` / `backend` / `preload`: handled by that layer of the port; `harmless`: left
   * as is on purpose; `n/a`: not part of the renderer and nothing to do on Linux.
   */
  decision: 'patched' | 'removed' | 'main' | 'backend' | 'preload' | 'harmless' | 'n/a';
  patches: string[];
  note: string;
}

/** The complete vendor-specific table exported by scripts/ui-patches.mjs. */
export interface UiPatchTable {
  vendor: { product: string; version: string };
  csp: string;
  pinnedFiles: PinnedFile[];
  patches: PatchSpec[];
  /** HTML files (globs) whose CSP is rewritten; every *.html in the output must be listed. */
  cspFiles: string[];
  removals: RemovalSpec[];
  copies: CopySpec[];
  urlAllowlist: UrlAllowEntry[];
  reviewedSites: ReviewedSite[];
  reviewedSchemes: ReviewedScheme[];
  touchpoints: TouchpointDecision[];
}

/** Result of applying one patch. */
export interface AppliedPatch {
  id: string;
  file: string;
  count: number;
  rationale: string;
  spec: string;
}
