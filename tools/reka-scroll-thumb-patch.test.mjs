import assert from "node:assert/strict";
import {
  copyFileSync,
  mkdirSync,
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
import { build } from "vite";
import { rekaScrollThumbPatch } from "../player/vue/reka-scroll-thumb-patch.ts";

// `player/vue/reka-scroll-thumb-patch.ts` claims: a module is reka-ui's when the nearest `package.json` with a `name`
// above its real path names `reka-ui`, and a build that bundles a module of a reka-ui root patches that root's
// `dist/ScrollArea/ScrollAreaThumb.js` or fails naming the root. A build that bundles no reka-ui module passes: the
// development server's dependency scan runs the plugin with every package external, and refusing it skipped the
// pre-bundling, so the server optimized dependencies while a page loaded and reloaded it (#2123). The tests below
// generate the install shapes and thumb placements and derive each expected result from that claim.
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

for (const [shape, layout] of Object.entries(SHAPES))
  for (const thumb of ["present", "moved", "absent"])
    test(`${shape}, thumb ${thumb}`, async (t) => {
      const root = scratch(t);
      write(join(root, "package.json"), JSON.stringify({ name: "fixture" }));
      const copies = layout(root, thumb);
      const imports = copies.flatMap((copy) =>
        rekaCopy(copy.lives ?? join(root, copy.via), copy.thumb, copy).map(
          (path) => `./${copy.via}/${path}`,
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
