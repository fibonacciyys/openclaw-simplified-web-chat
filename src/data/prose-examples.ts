/**
 * Bundled OpenProse example programs.
 *
 * The `.prose` files under `./prose-examples/` are copied at repo-authoring
 * time from `extensions/open-prose/skills/prose/examples/` (the open-prose
 * plugin's shipped example set). Vite's `import.meta.glob` with `?raw`
 * inlines their contents into the bundle at build time, so the Examples
 * dropdown works with no File System Access permission, no symlink
 * traversal, and no network fetch — important because the on-disk path
 * (`~/.openclaw/plugin-skills/prose/examples/`) is a symlink target under
 * `AppData\Roaming\npm\node_modules\`, which Chrome's Windows file picker
 * refuses to grant access to ("contains system files").
 *
 * To update the bundled examples, copy the latest files from
 * `extensions/open-prose/skills/prose/examples/` into `./prose-examples/`.
 */
export interface BundledProseExample {
  /** Display label: relative path without `.prose` extension (e.g.
   *  `01-hello-world`, `roadmap/simple-pipeline`). */
  label: string;
  /** Full source text of the `.prose` file. */
  content: string;
}

const RAW_MODULES = import.meta.glob("./prose-examples/**/*.prose", {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;

/** All bundled `.prose` examples, sorted by path with natural numeric
 *  ordering so `01-` … `49-` come in numeric order, and `roadmap/` files
 *  sort after the numbered ones. */
export const bundledProseExamples: BundledProseExample[] = Object.entries(RAW_MODULES)
  .map(([modulePath, content]) => {
    // modulePath looks like "./prose-examples/01-hello-world.prose" or
    // "./prose-examples/roadmap/syntax/open-prose-syntax.prose". Strip the
    // "./prose-examples/" prefix and the ".prose" suffix to form the label.
    const stripped = modulePath.replace(/^\.\//, "").replace(/^prose-examples\//, "");
    const label = stripped.replace(/\.prose$/i, "");
    return { label, content };
  })
  .sort((a, b) => a.label.localeCompare(b.label, "en", { numeric: true }));
