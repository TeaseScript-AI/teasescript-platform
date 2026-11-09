import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  ADAPTER_EXPORTS,
  ALLOWED_SOURCE,
  COMPLETED_FAMILIES,
  RATCHET,
  VIEW_READERS,
  WORKER_MODULES,
} from "../../player/engine-bridge/inventory.js";
import { mainRealmGraph, type MainRealmOffender } from "../helpers/player/main-realm-graph.js";

/*
 * The engine's ownership rule for the Player (the L5 series): the main realm loads only the `src/` modules in
 * `ALLOWED_SOURCE`, never Worker-side code; the imports a bridge family still has are listed in `RATCHET`. Every list
 * in `player/engine-bridge/inventory.ts` is checked against the source here.
 */

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const key = (entry: MainRealmOffender) => `${entry.importer} → ${entry.target} ${entry.name}`;
const allowed = ALLOWED_SOURCE.flatMap((group) => group.modules);

const graph = mainRealmGraph({
  root: ROOT,
  entry: "player/vue/src/main.ts",
  aliasRoot: "player/vue/src",
  allowedSource: new Set(allowed),
  workerModules: new Set(WORKER_MODULES),
});

test("the main realm reaches Worker-side code only through the imports RATCHET lists", () => {
  const found = new Set(graph.offenders.map(key));
  const listed = new Set(RATCHET.map(key));
  assert.deepEqual(
    [...found].filter((entry) => !listed.has(entry)),
    [],
    "imports of Worker-side code that RATCHET does not list",
  );
  assert.deepEqual(
    [...listed].filter((entry) => !found.has(entry)),
    [],
    "RATCHET entries the source no longer has: remove them",
  );
  assert.equal(listed.size, RATCHET.length, "RATCHET lists an import twice");
  assert.deepEqual(
    RATCHET.filter((entry) => COMPLETED_FAMILIES.includes(entry.family)).map(key),
    [],
    "entries of a completed family",
  );
});

test("the main realm loads no reader of an exported file: the engine host reads it (L5h.2)", () => {
  assert.equal(graph.modules.includes("player/persistence/session-transfer-read.ts"), false);
  assert.equal(graph.modules.includes("player/engine-bridge/ops/transfer.ts"), false);
});

test("the main realm loads exactly the src modules ALLOWED_SOURCE lists", () => {
  assert.equal(new Set(allowed).size, allowed.length, "ALLOWED_SOURCE lists a module twice");
  assert.deepEqual(
    graph.modules.filter((module) => module.startsWith("src/")),
    [...allowed].sort(),
  );
});

test("each export of runtime-adapter.ts and runtime-view.ts has its place in the inventory", async () => {
  const adapter = await import("../../player/runtime/runtime-adapter.js");
  const view = await import("../../player/runtime/runtime-view.js");
  assert.deepEqual(Object.keys(adapter).sort(), Object.keys(ADAPTER_EXPORTS).sort());
  assert.deepEqual(Object.keys(view).sort(), [...VIEW_READERS].sort());
});

const FIXTURE = fileURLToPath(new URL("../../../tests/fixtures/main-realm-graph/", import.meta.url));
const fixtureGraph = (entry: string) =>
  mainRealmGraph({
    root: FIXTURE,
    entry,
    aliasRoot: "player/alias",
    allowedSource: new Set(["src/allowed.ts"]),
    workerModules: new Set(["player/worker-module.ts"]),
  });

test("the walk reads every import form once and stops at Worker-side code", () => {
  // Type-only imports, re-exports (also of no value), `import()`, side-effect imports, `.vue` scripts and templates, the
  // `@/` alias, a cycle, and the Vite forms the Player uses.
  const fixture = fixtureGraph("player/entry.ts");
  assert.deepEqual(fixture.modules, [
    "player/alias/aliased.ts",
    "player/entry.ts",
    "player/export-names.ts",
    "player/names.ts",
    "player/panel.vue",
    "player/side.ts",
    "src/allowed.ts",
  ]);
  assert.deepEqual(fixture.offenders.map(key), [
    "player/alias/aliased.ts → src/root.ts fromRoot",
    "player/entry.ts → src/dynamic.ts *",
    "player/entry.ts → src/empty.ts *",
    "player/entry.ts → src/root.ts fromRoot",
    "player/entry.ts → src/typed.ts *",
    "player/panel.vue → src/template.ts *",
    "player/side.ts → player/worker-module.ts inWorker",
  ]);
});

test("the walk refuses each loading form it does not model", () => {
  const unmodelled = (form: string) => `the main-realm walk does not model ${form}`;
  const named =
    "a binding or reference named `require`: the main-realm walk refuses CommonJS loading; rename it";
  for (const [file, failure] of [
    ["script-src.vue", unmodelled("<script src>")],
    ["setup-src.vue", 'SyntaxError: <script setup> cannot use the "src" attribute'],
    ["template-src.vue", unmodelled("<template src>")],
    ["style-src.vue", unmodelled("<style src>")],
    ["css-vars.vue", unmodelled("CSS v-bind()")],
    ["custom-block.vue", unmodelled("the custom block <docs>")],
    ["query.ts", unmodelled('the query of "./plain.js?worker"')],
    ["glob.ts", unmodelled('import.meta.glob without one literal query "?url"')],
    ["glob-spread.ts", unmodelled('import.meta.glob without one literal query "?url"')],
    [
      "local-module.ts",
      unmodelled('"./plain.mjs", a local specifier that names no .ts, .vue or .css file'),
    ],
    [
      "ambiguous.ts",
      unmodelled('"./sibling.js", which could name refused/sibling.js or refused/sibling.ts'),
    ],
    ["require.ts", named],
    ["require-alias.ts", named],
    ["require-import.ts", named],
    ["require-parameter.ts", named],
    ["require-export.ts", named],
    ["require-import-equals.vue", unmodelled("CommonJS require()")],
    ["url.ts", unmodelled("new URL(…, import.meta.url) outside new Worker(…)")],
    ["computed-import.ts", unmodelled("an import() of a computed specifier")],
  ])
    assert.throws(
      () => fixtureGraph(`refused/${file}`),
      (error: Error) => error.message.startsWith(`refused/${file}: ${failure}`),
      file,
    );
});
