import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  ADAPTER_EXPORTS,
  ALLOWED_SOURCE,
  COMPLETED_FAMILIES,
  EXEMPT_UNTIL_ACTIVATION,
  RATCHET,
  VIEW_READERS,
  WORKER_MODULES,
} from "../player/engine-bridge/inventory.js";
import { mainRealmGraph, type MainRealmOffender } from "./helpers/main-realm-graph.js";

/*
 * The engine's ownership rule for the Player (the L5 series): the main realm loads only the `src/` modules in
 * `ALLOWED_SOURCE`, never Worker-side code; until each bridge family lands, its remaining imports are listed in
 * `RATCHET`. Every list in `player/engine-bridge/inventory.ts` is checked against the source here.
 */

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const key = (entry: MainRealmOffender) => `${entry.importer} → ${entry.target} ${entry.name}`;
const allowed = ALLOWED_SOURCE.flatMap((group) => group.modules);

const graph = mainRealmGraph({
  root: ROOT,
  entry: "player/vue/src/main.ts",
  aliasRoot: "player/vue/src",
  allowedSource: new Set(allowed),
  workerModules: new Set(WORKER_MODULES),
  exempt: new Set(EXEMPT_UNTIL_ACTIVATION),
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

test("the main realm loads exactly the src modules ALLOWED_SOURCE lists", () => {
  assert.equal(new Set(allowed).size, allowed.length, "ALLOWED_SOURCE lists a module twice");
  assert.deepEqual(
    graph.modules.filter((module) => module.startsWith("src/")),
    [...allowed].sort(),
  );
});

test("each export of runtime-adapter.ts and runtime-view.ts has its place in the inventory", async () => {
  const adapter = await import("../player/runtime-adapter.js");
  const view = await import("../player/runtime-view.js");
  assert.deepEqual(Object.keys(adapter).sort(), Object.keys(ADAPTER_EXPORTS).sort());
  assert.deepEqual(Object.keys(view).sort(), [...VIEW_READERS].sort());
});

test("the walk reads every import form once and stops at Worker-side code", () => {
  // Type-only imports, re-exports (also of no value), `import()`, side-effect imports, `.vue` scripts and templates (each
  // also by `src`), the `@/` alias and a cycle.
  const fixture = mainRealmGraph({
    root: fileURLToPath(new URL("../../tests/fixtures/main-realm-graph/", import.meta.url)),
    entry: "player/entry.ts",
    aliasRoot: "player/alias",
    allowedSource: new Set(["src/allowed.ts"]),
    workerModules: new Set(["player/worker-module.ts"]),
    exempt: new Set(),
  });
  assert.deepEqual(fixture.modules, [
    "player/alias/aliased.ts",
    "player/entry.ts",
    "player/external-script.ts",
    "player/external.vue",
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
    "player/external-script.ts → src/root.ts fromScript",
    "player/external.vue → src/template.ts *",
    "player/panel.vue → src/template.ts *",
    "player/side.ts → player/worker-module.ts inWorker",
  ]);
});
