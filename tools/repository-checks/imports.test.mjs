import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";

import { checkImports } from "./imports.mjs";

/** A Git repository at a new folder holding `files` (path to text), none committed; its path. */
function repository(files) {
  const root = mkdtempSync(join(tmpdir(), "imports-"));
  execFileSync("git", ["init", "-q", root]);
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  return root;
}

/** Each finding of `checkImports` as `file:line: rule`, the rule its message opens with or `cycle`/`waiting`. */
const summary = ({ findings }) =>
  findings.map(({ fileName, line, message }) => {
    const rule =
      /^(B\d)\b/u.exec(message)?.[1] ?? (message.includes("value imports") ? "cycle" : "waiting");
    return `${fileName}:${line}: ${rule}`;
  });

test("each boundary is refused at each import form, type-only ones too, and admitted imports pass", () => {
  const root = repository({
    // B1, by each import form
    "src/b1.ts": [
      'import { a } from "../player/adapter.js";',
      'import type { B } from "../playground/server.js";',
      'export { c } from "../player/adapter.js";',
      'export type { D } from "../player/adapter.js";',
      'const e = await import("../player/adapter.js");',
      'type F = import("../playground/server.js").F;',
      "export { a, e };",
      "export type { B, F };",
    ].join("\n"),
    // B2: an admitted package, a refused one, a type-only refused one, a Node built-in
    "src/b2.ts":
      'import Color from "colorjs.io";\nimport { ref } from "vue";\nimport type { Ref } from "@vue/reactivity";\nimport { readFileSync } from "node:fs";\nexport { Color, ref, readFileSync };\nexport type { Ref };',
    // B3: the Vue folder, a refused package, a Node built-in outside the Node files, admitted packages
    "player/adapter.ts":
      'import { shown } from "./vue/src/shown.js";\nimport { computed } from "vue";\nimport { Worker } from "node:worker_threads";\nimport { chacha20poly1305 } from "@noble/ciphers/chacha.js";\nexport { shown, computed, Worker, chacha20poly1305 };',
    "player/engine-bridge/node-port.ts":
      'import { parentPort } from "node:worker_threads";\nexport { parentPort };',
    "player/vue/src/shown.ts": 'import { ref } from "vue";\nexport const shown = ref(0);',
    // an SFC reaching the framework-independent adapter through `@/`-free relative paths and `@/`
    "player/vue/src/Panel.vue":
      '<template><p /></template>\n<script setup lang="ts">\nimport { shown } from "@/shown";\nimport { a } from "../../adapter.js";\n</script>',
    "playground/server.ts": "export type F = number;\nexport const server = 1;",
    // a CommonJS require
    "src/legacy.cjs": 'const { a } = require("../player/adapter.js");\nmodule.exports = a;',
  });
  try {
    assert.deepEqual(summary(checkImports(root, [])), [
      "player/adapter.ts:1: B3",
      "player/adapter.ts:2: B3",
      "player/adapter.ts:3: B3",
      "src/b1.ts:1: B1",
      "src/b1.ts:2: B1",
      "src/b1.ts:3: B1",
      "src/b1.ts:4: B1",
      "src/b1.ts:5: B1",
      "src/b1.ts:6: B1",
      "src/b2.ts:2: B2",
      "src/b2.ts:3: B2",
      "src/b2.ts:4: B2",
      "src/legacy.cjs:1: B1",
    ]);
    // a listed crossing passes each import of its target by its file, and a listed one no longer found fails
    const crossings = [
      { file: "player/adapter.ts", imports: "vue", waits: "a cleanup" },
      { file: "src/b1.ts", imports: "player/adapter.ts", waits: "a cleanup" },
      { file: "src/b2.ts", imports: "lodash", waits: "a cleanup" },
    ];
    assert.deepEqual(summary(checkImports(root, crossings)), [
      "player/adapter.ts:1: B3",
      "player/adapter.ts:3: B3",
      "src/b1.ts:2: B1",
      "src/b1.ts:6: B1",
      "src/b2.ts:2: B2",
      "src/b2.ts:3: B2",
      "src/b2.ts:4: B2",
      "src/legacy.cjs:1: B1",
      "tools/repository-checks/imports-waiting.json:1: waiting",
    ]);
    const messages = checkImports(root, []).findings.map(({ message }) => message);
    assert.ok(
      messages.some((message) =>
        message.endsWith("(a type-only import, which couples the folders too)"),
      ),
    );
    assert.ok(
      messages.some((message) =>
        message.includes(
          "imports the package 'vue', which `PACKAGES` does not admit for `player/`",
        ),
      ),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a value cycle is refused unless listed, a listed one gone fails, a type-only cycle is counted only", () => {
  const files = {
    // a value cycle of three, by a static import and a dynamic one
    "src/one.ts": 'import { two } from "./two.js";\nexport const one = two;',
    "src/two.ts": 'import { three } from "./three.js";\nexport const two = three;',
    "src/three.ts": 'export const three = async () => (await import("./one.js")).one;',
    // a cycle that type-only imports close, which is not refused
    "src/caller.ts":
      'import { callee } from "./callee.js";\nexport interface Caller { run(): void }\nexport const c = callee;',
    "src/callee.ts":
      'import type { Caller } from "./caller.js";\nexport const callee = (caller: Caller) => caller.run();',
    // an SFC's script in a value cycle with a module, through `@/`
    "player/vue/src/Panel.vue":
      '<template><p /></template>\n<script setup lang="ts">\nimport { label } from "@/label";\n</script>',
    "player/vue/src/label.ts": 'import Panel from "./Panel.vue";\nexport const label = Panel;',
    // one that an `import("…")` type closes, which is erased too
    "src/holder.ts":
      'import { held } from "./held.js";\nexport interface Holder { held: unknown }\nexport const h = held;',
    "src/held.ts": 'export const held = (holder: import("./holder.js").Holder) => holder.held;',
    // a fixture's cycle is a deliberate shape
    "tests/fixtures/graph/a.ts": 'import "./b.js";',
    "tests/fixtures/graph/b.ts": 'import "./a.js";',
  };
  const root = repository(files);
  try {
    const plain = checkImports(root, []);
    assert.deepEqual(summary(plain), ["src/one.ts:1: cycle", "player/vue/src/Panel.vue:1: cycle"]);
    assert.match(
      plain.findings[0].message,
      /^3 files reach each other through value imports .* as src\/one\.ts → src\/two\.ts → src\/three\.ts → src\/one\.ts: /u,
    );
    assert.equal(plain.typeOnly.groups, 2);
    assert.equal(plain.typeOnly.largest.length, 2);
    const listed = [
      { cycle: ["src/two.ts", "src/one.ts", "src/three.ts"], waits: "a cleanup" },
      { cycle: ["player/vue/src/Panel.vue", "player/vue/src/label.ts"], waits: "a cleanup" },
    ];
    assert.deepEqual(summary(checkImports(root, listed)), []);
    // a listed group that is no longer exactly what the code has fails
    const gone = [...listed, { cycle: ["src/caller.ts", "src/callee.ts"], waits: "a cleanup" }];
    assert.deepEqual(summary(checkImports(root, gone)), [
      "tools/repository-checks/imports-waiting.json:1: waiting",
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
