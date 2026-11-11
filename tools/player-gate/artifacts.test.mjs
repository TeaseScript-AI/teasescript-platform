// The artifact inventory's classes (`artifacts.mjs`) over small builds of the Worker Player's shape.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { inventoryOf } from "./artifacts.mjs";

/** A build of `files` (path → text) in a folder of its own, removed after the test. */
function buildOf(context, files) {
  const app = mkdtempSync(join(tmpdir(), "artifacts-"));
  context.after(() => rmSync(app, { recursive: true, force: true }));
  for (const [path, body] of Object.entries(files)) {
    mkdirSync(join(app, path, ".."), { recursive: true });
    writeFileSync(join(app, path), body);
  }
  return app;
}

const PLAYER = {
  "index.html":
    '<script type="module" src="/player/assets/index-a.js"></script><link href="/player/assets/index-a.css">',
  "assets/index-a.css": "body{}",
  "assets/index-a.js":
    'import { v } from "./vue-b.js";\nnew Worker(new URL("engine.worker-c.js", import.meta.url), { type: "module" });\nconst preview = () => import("./preview-d.js");',
  "assets/vue-b.js": "export const v = 1;",
  "assets/preview-d.js": 'import { v } from "./vue-b.js";',
  "assets/engine.worker-c.js": 'import("./engine-host-e.js");',
  "assets/engine-host-e.js":
    'import { plan } from "./plan-f.js";\nconst compile = () => import(`./compiler-g.js`);',
  "assets/plan-f.js": "export const plan = 1;",
  "assets/compiler-g.js": "export const compile = 1;",
  "assets/photo.png": "png",
};

test("the engine Worker's entry, its host and its lazily loaded compiler are the Worker's; the page's import() is lazy", (context) => {
  const inventory = inventoryOf(buildOf(context, PLAYER), "worker");
  const classes = Object.fromEntries(inventory.files.map((file) => [file.file, file.classes]));
  assert.deepEqual(classes, {
    "assets/compiler-g.js": ["Worker"],
    "assets/engine-host-e.js": ["Worker"],
    "assets/engine.worker-c.js": ["Worker"],
    "assets/index-a.css": ["eager"],
    "assets/index-a.js": ["eager"],
    "assets/photo.png": ["lazy"],
    "assets/plan-f.js": ["Worker"],
    "assets/preview-d.js": ["lazy"],
    "assets/vue-b.js": ["eager"],
    "index.html": ["eager"],
  });
  assert.equal(
    inventory.totals.Worker.raw,
    ["compiler-g", "engine-host-e", "engine.worker-c", "plan-f"].reduce(
      (sum, name) => sum + PLAYER[`assets/${name}.js`].length,
      0,
    ),
  );
});

test("a JavaScript file no root reaches fails the inventory", (context) => {
  const app = buildOf(context, { ...PLAYER, "assets/stray-h.js": "export {};" });
  assert.throws(() => inventoryOf(app, "worker"), /no root reaches assets\/stray-h\.js/u);
});

test("an import() of a form the inventory does not read fails it", (context) => {
  // A variable; a template with a substitution, whose file the page also reaches (so no unreached file would show the
  // lost Worker edge); and a variable after a space or a comment.
  for (const call of [
    "import(name)",
    "import(`./${name}.js`)",
    "import (name)",
    "import/* chunk */(name)",
  ]) {
    const app = buildOf(context, {
      ...PLAYER,
      "assets/index-a.js": `${PLAYER["assets/index-a.js"]}\nimport "./compiler-g.js";`,
      "assets/engine-host-e.js": `import { plan } from "./plan-f.js";\nconst name = "compiler-g";\nconst compile = () => ${call};`,
    });
    assert.throws(
      () => inventoryOf(app, "worker"),
      /engine-host-e\.js: 1 import\(\) of a form/u,
      call,
    );
  }
});
