import assert from "node:assert/strict";
import {
  copyFileSync,
  mkdirSync,
  readFileSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { build, optimizeDeps, resolveConfig } from "vite";
import { rekaScrollThumbPatch } from "../player/vue/reka-scroll-thumb-patch.ts";

// `player/vue/reka-scroll-thumb-patch.ts` claims: a module is reka-ui's when the nearest `package.json` with a `name`
// above its real path names `reka-ui`, and a build that bundles a module of a reka-ui root patches that root's
// `dist/ScrollArea/ScrollAreaThumb.js` or fails naming the root. A build that bundles no reka-ui module passes: the
// development server's dependency scan runs the plugin with every package external, and refusing it skipped the
// pre-bundling, so the server optimized dependencies while a page loaded and reloaded it (#2123). A module's file is
// whichever of its ID's two readings (whole, or cut at the first `?` or `#`) names a regular file, and the plugin judges
// only the ID shapes the Player's builds give it: an absolute path, perhaps with a query. The tests below generate the
// install shapes, thumb placements, ID shapes and both loaders, and derive each expected result from that claim.
const installed = (path) =>
  fileURLToPath(new URL(`../node_modules/reka-ui/${path}`, import.meta.url));
const PATCHED = /function settlingScrollListener/gu;

/** A scratch folder, real path, removed after the test. */
function scratch(t) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "reka-scroll-thumb-patch-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}
function write(path, text) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
}
function copy(from, to) {
  mkdirSync(dirname(to), { recursive: true });
  copyFileSync(from, to);
}
function link(target, path) {
  mkdirSync(dirname(path), { recursive: true });
  symlinkSync(target, path, "junction");
}

/**
 * Builds `entry.js` in `root`. Only the files the entry imports by path are bundled; a package it names, and whatever
 * those files import, are external.
 */
async function bundle(root, source, plugin = rekaScrollThumbPatch()) {
  const entry = join(root, "entry.js");
  writeFileSync(entry, source);
  const outputs = await build({
    configFile: false,
    root,
    logLevel: "silent",
    plugins: [plugin],
    build: {
      write: false,
      minify: false,
      rolldownOptions: {
        input: entry,
        preserveEntrySignatures: "strict",
        // Vite gives importers with `/`, also on Windows.
        external: (id, importer) =>
          importer !== entry.replaceAll("\\", "/") || !(id.startsWith(".") || isAbsolute(id)),
      },
    },
  });
  return [outputs].flat()[0].output[0].code;
}
// Each module as a namespace of its own, so two copies' equal export names do not cancel each other out.
const importing = (paths) =>
  paths.map((path, index) => `export * as m${index} from ${JSON.stringify(path)};\n`).join("");

/**
 * A copy of reka-ui in `folder`, named `name`, with a nameless inner `dist/package.json` as packages ship, its Label,
 * and its thumb where `thumb` puts it: "present" at `dist/ScrollArea/ScrollAreaThumb.js`, "moved" to
 * `lib/ScrollAreaThumb.mjs`, "absent" nowhere. `manifest: false` leaves out its own `package.json`. Returns the paths,
 * relative to `folder`, that a build of everything it holds imports.
 */
function rekaCopy(folder, thumb, { name = "reka-ui", manifest = true } = {}) {
  if (manifest) write(join(folder, "package.json"), JSON.stringify({ name, version: "2.10.4" }));
  write(join(folder, "dist/package.json"), JSON.stringify({ type: "module" }));
  copy(installed("dist/Label/Label.js"), join(folder, "dist/Label/Label.js"));
  const imports = ["dist/Label/Label.js"];
  const at = { present: "dist/ScrollArea/ScrollAreaThumb.js", moved: "lib/ScrollAreaThumb.mjs" }[
    thumb
  ];
  if (at !== undefined) {
    copy(installed("dist/ScrollArea/ScrollAreaThumb.js"), join(folder, at));
    imports.push(at);
  }
  return imports;
}

/**
 * Each install shape lays out a fixture `root` and returns the reka-ui copies it builds: where each lives (the root the
 * failure names, or `null` for a folder that is not reka-ui) and the path the entry imports it by.
 */
const SHAPES = {
  "installed under node_modules": (root, thumb) => [
    { lives: join(root, "node_modules/reka-ui"), via: "node_modules/reka-ui", thumb },
  ],
  "a node_modules link to a folder elsewhere (npm link)": (root, thumb) => {
    link(join(root, "elsewhere/fork"), join(root, "node_modules/reka-ui"));
    return [{ lives: join(root, "elsewhere/fork"), via: "node_modules/reka-ui", thumb }];
  },
  "a workspace member": (root, thumb) => {
    write(
      join(root, "package.json"),
      JSON.stringify({ name: "fixture", workspaces: ["packages/*"] }),
    );
    link(join(root, "packages/reka-ui"), join(root, "node_modules/reka-ui"));
    return [{ lives: join(root, "packages/reka-ui"), via: "node_modules/reka-ui", thumb }];
  },
  "a vendored copy outside node_modules": (root, thumb) => [
    { lives: join(root, "vendor/reka-ui"), via: "vendor/reka-ui", thumb },
  ],
  "a nested copy under another package's node_modules": (root, thumb) => {
    write(join(root, "node_modules/other/package.json"), JSON.stringify({ name: "other" }));
    const via = "node_modules/other/node_modules/reka-ui";
    return [{ lives: join(root, via), via, thumb }];
  },
  "two copies in one build": (root, thumb) => {
    write(join(root, "node_modules/other/package.json"), JSON.stringify({ name: "other" }));
    const nested = "node_modules/other/node_modules/reka-ui";
    return [
      { lives: join(root, "node_modules/reka-ui"), via: "node_modules/reka-ui", thumb: "present" },
      { lives: join(root, nested), via: nested, thumb },
    ];
  },
  "a project folder named reka-ui with another name in its manifest": (root, thumb) => [
    { lives: null, via: "reka-ui", thumb, name: "not-reka-ui" },
  ],
  "a project folder named reka-ui without a manifest": (root, thumb) => [
    { lives: null, via: "reka-ui", thumb, manifest: false },
  ],
};

/** The ID shapes the Player's builds give the plugin (queue job 111108091160ff): a plain path, and one with a query. */
const SPELLINGS = { "a plain path": "", "a query": "?probe" };

for (const [shape, layout] of Object.entries(SHAPES))
  for (const thumb of ["present", "moved", "absent"])
    for (const [spelling, suffix] of Object.entries(SPELLINGS))
      test(`${shape}, thumb ${thumb}, imported by ${spelling}`, async (t) => {
        const root = scratch(t);
        write(join(root, "package.json"), JSON.stringify({ name: "fixture" }));
        const copies = layout(root, thumb);
        const imports = copies.flatMap((copy) =>
          rekaCopy(copy.lives ?? join(root, copy.via), copy.thumb, copy).map(
            (path) => `./${copy.via}/${path}${suffix}`,
          ),
        );
        const packages = copies.filter((copy) => copy.lives !== null);
        const unpatched = packages.filter((copy) => copy.thumb !== "present");
        const built = bundle(root, importing(imports));
        if (unpatched.length > 0) {
          const message = await built.then(
            () => "",
            (error) => String(error.message),
          );
          assert.ok(
            unpatched.some((copy) => message.includes(`reka-ui at ${copy.lives} was bundled`)),
            `the failure names an unpatched root: ${message || "the build passed"}`,
          );
        } else assert.equal((await built).match(PATCHED)?.length ?? 0, packages.length);
      });

test("a build that bundles no reka-ui module, as the dependency scan, passes", async (t) => {
  const code = await bundle(scratch(t), 'import { Label } from "reka-ui";\nconsole.log(Label);\n');
  assert.doesNotMatch(code, PATCHED);
});

test("one plugin judges each build alone: a patched build does not admit a later unpatched one", async (t) => {
  const plugin = rekaScrollThumbPatch();
  const code = await bundle(
    scratch(t),
    importing([installed("dist/ScrollArea/ScrollAreaThumb.js")]),
    plugin,
  );
  assert.match(code, PATCHED);
  await assert.rejects(
    bundle(scratch(t), importing([installed("dist/Label/Label.js")]), plugin),
    /reka-ui at .* was bundled without its ScrollAreaThumb/u,
  );
});

// Both loaders, a file name that holds a `?` or none, and what lies at the reading cut at that `?`. A reka-ui copy is
// linked into `node_modules`, so each loader reaches it by its real path; its thumb holds the lines the plugin patches.
const THUMB = `export function thumb(viewport, scrollbarContextVisible, removeUnlinkedScrollListenerRef, addUnlinkedScrollListener) {
  const listener = addUnlinkedScrollListener(viewport.value, scrollbarContextVisible.onThumbPositionChange);
  removeUnlinkedScrollListenerRef.value = listener;
  scrollbarContextVisible.onThumbPositionChange();
}
`;
const THUMB_PATH = "dist/ScrollArea/ScrollAreaThumb.js";
const LOADERS = {
  "the production build": async (root, plugin) =>
    bundle(root, importing([`./node_modules/reka-ui/${THUMB_PATH}`]), plugin),
  "the forced dependency optimizer": async (root, plugin) => {
    const config = await resolveConfig(
      {
        root,
        configFile: false,
        logLevel: "silent",
        cacheDir: join(root, ".vite"),
        optimizeDeps: {
          include: [`reka-ui/${THUMB_PATH}`],
          noDiscovery: true,
          rolldownOptions: { plugins: [plugin] },
        },
      },
      "serve",
    );
    const metadata = await optimizeDeps(config, true);
    return Object.values(metadata.optimized)
      .map((dependency) => readFileSync(dependency.file, "utf8"))
      .join("\n");
  },
};
for (const [loader, load] of Object.entries(LOADERS))
  for (const name of ["reka-literal", "reka?literal"])
    for (const prefix of ["absent", "a file", "a folder"])
      test(`${loader}, a reka-ui copy in vendor/${name}, vendor/reka ${prefix}`, async (t) => {
        const root = scratch(t);
        write(join(root, "package.json"), JSON.stringify({ name: "fixture" }));
        const copy = join(root, "vendor", name);
        write(join(copy, "package.json"), JSON.stringify({ name: "reka-ui", version: "2.10.4" }));
        write(join(copy, THUMB_PATH), THUMB);
        if (prefix === "a file") write(join(root, "vendor/reka"), "export const marker = 1;\n");
        if (prefix === "a folder") mkdirSync(join(root, "vendor/reka/other"), { recursive: true });
        link(copy, join(root, "node_modules/reka-ui"));
        const id = join(copy, THUMB_PATH);
        // The rule: both readings name a regular file, so the build fails naming the ID; else the one is the thumb, which
        // is patched, unless the loader cannot reach that file at all and fails the build itself. Never silently unpatched.
        const ambiguous = name.includes("?") && prefix === "a file";
        const outcome = await load(root, rekaScrollThumbPatch()).then(
          (code) => (/function settlingScrollListener/u.test(code) ? "patched" : "not patched"),
          (error) => `failed: ${String(error.message)}`,
        );
        if (ambiguous) assert.ok(outcome.includes(`${id} names two files`), outcome);
        else if (loader === "the production build" || !name.includes("?"))
          assert.equal(outcome, "patched");
        else assert.match(outcome, /^(?:patched|failed: )/u);
      });
