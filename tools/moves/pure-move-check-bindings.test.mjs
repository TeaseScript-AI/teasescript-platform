import assert from "node:assert/strict";
import { test } from "node:test";

import { helper, main, moveOf, split, splitFamily } from "./pure-move-check-fixture.mjs";

test(
  "a pure move keeps every import's binding: an alias dropped or an export renamed fails",
  { timeout: 60_000 },
  () => {
    const server = (importLine) =>
      `${importLine}\nexport const makeServerWithLongIdentifier = createNetServer;\n`;
    const before = {
      "a.ts": `${server('import { createServer as createNetServer } from "node:net";')}\n${helper("kept")}\n`,
    };
    const moved = (importLine) => ({ "a.ts": `${helper("kept")}\n`, "b.ts": server(importLine) });
    const dropped = moveOf(before, moved('import { createNetServer } from "node:net";'));
    try {
      const { status, out } = dropped.run("--renames", dropped.renames(splitFamily));
      assert.equal(status, 1, out);
      assert.match(
        out,
        /binding only before: a\.ts:1 import from "node:net": createServer as createNetServer/u,
      );
      assert.match(out, /binding only after: b\.ts:1 import from "node:net": createNetServer/u);
    } finally {
      dropped.done();
    }
    const kept = moveOf(
      before,
      moved('import { createServer as createNetServer } from "node:net";'),
    );
    try {
      const passed = kept.run("--renames", kept.renames(splitFamily));
      assert.equal(passed.status, 0, passed.out);
      assert.match(passed.out, /bindings differing 0/u);
    } finally {
      kept.done();
    }
    // a split whose kept file imports its new sibling: without the family, that binding is new, and the flag is named
    const unnamed = moveOf({ "a.ts": main }, split);
    try {
      const { status, out } = unnamed.run();
      assert.equal(status, 1, out);
      assert.match(out, /binding only after: a\.ts:1 import from "\.\/b\.js": weighted/u);
      assert.match(out, /the move relocates or adds b\.ts: name its family with --renames FILE/u);
      assert.doesNotMatch(out, /both change/u);
    } finally {
      unnamed.done();
    }
    const reexport = moveOf(
      {
        "a.ts": 'export { helperName } from "./c.js";\n',
        "c.ts": "export const helperName = 1;\n",
      },
      {
        "a.ts": 'export { helperName as renamed } from "./c.js";\n',
        "c.ts": "export const helperName = 1;\n",
      },
    );
    try {
      const { status, out } = reexport.run();
      assert.equal(status, 1, out);
      assert.match(
        out,
        /binding only after: a\.ts:1 re-export from "\.\/c\.js": helperName as renamed/u,
      );
      // c.ts is not edited, so no family is named
      assert.doesNotMatch(out, /both change/u);
    } finally {
      reexport.done();
    }
  },
);

test(
  "code moved between two files one of which imports the other fails naming the family that admits it",
  { timeout: 60_000 },
  () => {
    const other = "export const other = 1;\n";
    const apart = { "a.ts": main, "c.ts": other };
    const together = {
      "a.ts": `import { weighted } from "./c.js";\n\n${helper("sumOfSquares")}\n\nexport const used = sumOfSquares([1]) + weighted([2]);\n`,
      "c.ts": `${other}\nexport ${helper("weighted")}\n`,
    };
    // out of a file that still calls it, into a file already there, which the family admits; and back in, the import
    // gone (where the dropped `export` stays unadmitted)
    for (const [before, after, side] of [
      [apart, together, "after"],
      [together, apart, "before"],
    ]) {
      const move = moveOf(before, after);
      try {
        const failed = move.run();
        assert.equal(failed.status, 1, failed.out);
        assert.match(
          failed.out,
          new RegExp(`binding only ${side}: a\\.ts:1 import from "\\./c\\.js": weighted`, "u"),
        );
        assert.ok(
          failed.out.includes(
            'a.ts and c.ts both change, and a binding between them is on one side only: if the move took code from one into the other, name them one family with --renames FILE, as {"renames":{"a.ts":["a.ts","c.ts"]}}',
          ),
          failed.out,
        );
        assert.doesNotMatch(failed.out, /relocates or adds/u);
        const admitted = move.run("--renames", move.renames({ "a.ts": ["a.ts", "c.ts"] }));
        assert.match(admitted.out, /bindings differing 0/u);
        assert.doesNotMatch(admitted.out, /both change/u);
        if (side === "after") assert.equal(admitted.status, 0, admitted.out);
      } finally {
        move.done();
      }
    }
  },
);

test(
  "a binding's target is the file it resolves to, a bare module or a missing one, in every static form",
  { timeout: 60_000 },
  () => {
    const run = (before, after, map) => {
      const move = moveOf(before, after);
      try {
        return map === undefined ? move.run() : move.run("--renames", move.renames(map));
      } finally {
        move.done();
      }
    };
    const importer = (from) =>
      `import { value as selectedValue } from "${from}";\nexport const resultWithLongIdentifier = selectedValue;\n`;
    const exporter = "export const value = 1234567890;\n";
    // both files renamed, the import left pointing at the old, now missing, module
    const missing = run(
      { "src/a.js": importer("./old.js"), "src/old.js": exporter },
      {
        "src/a.js": null,
        "src/b.js": importer("./old.js"),
        "src/old.js": null,
        "src/new.js": exporter,
      },
      { "src/a.js": "src/b.js", "src/old.js": "src/new.js" },
    );
    assert.equal(missing.status, 1, missing.out);
    assert.match(
      missing.out,
      /refused: src\/b\.js:1 \(added\) "\.\/old\.js": resolves to no file under the committed configuration/u,
    );
    // a package's module and a repository file of the same path are different targets
    const bare = run(
      { "a.mjs": importer("pkg/x.js"), "pkg/x.js": exporter },
      { "a.mjs": importer("./pkg/x.js"), "pkg/x.js": exporter },
    );
    assert.equal(bare.status, 1, bare.out);
    assert.match(bare.out, /binding only before: a\.mjs:1 import from "pkg\/x\.js"/u);
    // `import x = require()` and an empty clause name their target too
    const required =
      'import dependencyWithLongIdentifier = require("./dep.js");\nexport const resultWithLongIdentifier = dependencyWithLongIdentifier.value;\n';
    const equals = run(
      { "src/a.ts": required, "src/dep.ts": exporter, "src/nested/dep.ts": exporter },
      {
        "src/a.ts": null,
        "src/nested/a.ts": required,
        "src/dep.ts": exporter,
        "src/nested/dep.ts": exporter,
      },
      { "src/a.ts": "src/nested/a.ts" },
    );
    assert.equal(equals.status, 1, equals.out);
    assert.match(
      equals.out,
      /binding only after: src\/nested\/a\.ts:1 import from "\.\/dep\.js": = as dependencyWithLongIdentifier/u,
    );
    const empty = run(
      { "a.mjs": 'import {} from "./first.mjs";\n', "first.mjs": exporter, "second.mjs": exporter },
      {
        "a.mjs": 'import {} from "./second.mjs";\n',
        "first.mjs": exporter,
        "second.mjs": exporter,
      },
    );
    assert.equal(empty.status, 1, empty.out);
    assert.match(
      empty.out,
      /binding only after: a\.mjs:1 import from "\.\/second\.mjs": \(side effect\) as \{\}/u,
    );
    // a changed file with no changed line (its mode) keeps its bindings in the comparison
    const loader =
      'import { marker as selectedMarkerWithLongIdentifier } from "./dep.mjs";\nconsole.log(selectedMarkerWithLongIdentifier);\n';
    const modeOnly = run(
      { "src/loader.mjs": loader, "src/dep.mjs": exporter },
      { "src/loader.mjs": { executable: loader }, "src/dep.mjs": null, "src/moved.mjs": exporter },
      { "src/dep.mjs": "src/moved.mjs" },
    );
    assert.equal(modeOnly.status, 1, modeOnly.out);
    assert.match(
      modeOnly.out,
      /refused: src\/loader\.mjs:1 \(added\) "\.\/dep\.mjs": resolves to no file/u,
    );
    // a declaration file renamed with its map is a pure rename
    const declarations = "export interface SomeType {\n  readonly value: number;\n}\n";
    const typed = (from) =>
      `import type { SomeType } from "${from}";\nexport const typedWithLongIdentifier: SomeType = { value: 1 };\n`;
    const renamed = run(
      { "src/a.ts": typed("./old.js"), "src/old.d.ts": declarations },
      { "src/a.ts": typed("./new.js"), "src/old.d.ts": null, "src/new.d.ts": declarations },
      { "src/old.d.ts": "src/new.d.ts" },
    );
    assert.equal(renamed.status, 0, renamed.out);
    assert.match(renamed.out, /bindings differing 0/u);
  },
);

test(
  "a target resolves as TypeScript resolves it, and a correct import-equals update is an import line",
  { timeout: 60_000 },
  () => {
    const run = (before, after, map) => {
      const move = moveOf(before, after);
      try {
        return move.run("--renames", move.renames(map));
      } finally {
        move.done();
      }
    };
    const importer = (from) =>
      `import { value as selectedValue } from "${from}";\nexport const resultWithLongIdentifier = selectedValue;\n`;
    const [ts1, js1, js2] = [
      "export const value = 1234567890;\n",
      "export const value = 9876543210;\n",
      "export const value = 5555555555;\n",
    ];
    // `./old.js` is `old.ts` before; with `old.ts` renamed away it is `old.js` after: a changed binding
    const switched = run(
      { "src/a.ts": importer("./old.js"), "src/old.ts": ts1, "src/old.js": js1 },
      {
        "src/a.ts": null,
        "src/b.ts": importer("./old.js"),
        "src/old.ts": null,
        "src/new.ts": ts1,
        "src/old.js": js1,
      },
      { "src/a.ts": "src/b.ts", "src/old.ts": "src/new.ts" },
    );
    assert.equal(switched.status, 1, switched.out);
    assert.match(switched.out, /bindings differing 2/u);
    // the `.ts` renamed beside unrelated `.js` files of both names, its import updated: the same binding
    const beside = run(
      { "src/a.ts": importer("./old.js"), "src/old.ts": ts1, "src/old.js": js1, "src/new.js": js2 },
      {
        "src/a.ts": importer("./new.js"),
        "src/new.ts": ts1,
        "src/old.js": js1,
        "src/new.js": js2,
        "src/old.ts": null,
      },
      { "src/old.ts": "src/new.ts" },
    );
    assert.equal(beside.status, 0, beside.out);
    // an extensionless specifier resolves to its JavaScript file
    const bare = run(
      { "src/a.ts": importer("./old"), "src/old.js": js1 },
      { "src/a.ts": importer("./new"), "src/old.js": null, "src/new.js": js1 },
      { "src/old.js": "src/new.js" },
    );
    assert.equal(bare.status, 0, bare.out);
    // `import x = require()` and `export import x = require()`, their specifier updated with the rename: import lines
    for (const keyword of ["import", "export import"]) {
      const required = (from) =>
        `${keyword} dependencyWithLongIdentifier = require("${from}");\nexport const resultWithLongIdentifier = dependencyWithLongIdentifier.value;\n`;
      const updated = run(
        { "src/a.ts": required("./old.js"), "src/old.ts": ts1 },
        { "src/a.ts": required("./new.js"), "src/old.ts": null, "src/new.ts": ts1 },
        { "src/old.ts": "src/new.ts" },
      );
      assert.equal(updated.status, 0, `${keyword}: ${updated.out}`);
      assert.match(updated.out, /admitted import 2,/u);
    }
  },
);

test(
  "resolution follows the importer's package context: an ESM import's extension, a folder's main",
  { timeout: 60_000 },
  () => {
    const run = (before, after, map) => {
      const move = moveOf(before, after);
      try {
        return move.run("--renames", move.renames(map));
      } finally {
        move.done();
      }
    };
    const esm = '{ "type": "module" }\n';
    const [one, two] = ["export const value = 1234567890;\n", "export const value = 9876543210;\n"];
    // in an ESM package, `./new` names no file where `./old.js` named `old.ts`: resolved to missing
    const importer = (from) =>
      `import { value as selectedValue } from "${from}";\nexport const resultWithLongIdentifier = selectedValue;\n`;
    const extensionless = run(
      { "package.json": esm, "src/a.ts": importer("./old.js"), "src/old.ts": one },
      { "package.json": esm, "src/a.ts": importer("./new"), "src/old.ts": null, "src/new.ts": one },
      { "src/old.ts": "src/new.ts" },
    );
    assert.equal(extensionless.status, 1, extensionless.out);
    assert.match(
      extensionless.out,
      /refused: src\/a\.ts:1 \(added\) "\.\/new": resolves to no file/u,
    );
    // a CommonJS require of a folder follows its package.json's main; with the entry moved away, it reaches index.ts
    const required =
      'import dependencyWithLongIdentifier = require("./dep");\nexport const resultWithLongIdentifier = dependencyWithLongIdentifier.value;\n';
    const main = '{ "type": "commonjs", "main": "entry.js" }\n';
    const retarget = run(
      {
        "package.json": esm,
        "src/a.cts": required,
        "src/dep/package.json": main,
        "src/dep/entry.ts": one,
        "src/dep/index.ts": two,
      },
      {
        "package.json": esm,
        "src/a.cts": null,
        "src/b.cts": required,
        "src/dep/package.json": main,
        "src/dep/entry.ts": null,
        "src/moved.ts": one,
        "src/dep/index.ts": two,
      },
      { "src/a.cts": "src/b.cts", "src/dep/entry.ts": "src/moved.ts" },
    );
    assert.equal(retarget.status, 1, retarget.out);
    assert.match(retarget.out, /bindings differing 2/u);
    // the folder renamed whole, its require updated: its main reached on both sides, the same binding
    const folder = (from) =>
      `import dependencyWithLongIdentifier = require("${from}");\nexport const resultWithLongIdentifier = dependencyWithLongIdentifier.value;\n`;
    const renamed = run(
      {
        "package.json": esm,
        "src/a.cts": folder("./old"),
        "src/old/package.json": main,
        "src/old/entry.ts": one,
      },
      {
        "package.json": esm,
        "src/a.cts": folder("./new"),
        "src/old/package.json": null,
        "src/old/entry.ts": null,
        "src/new/package.json": main,
        "src/new/entry.ts": one,
      },
      { "src/old/package.json": "src/new/package.json", "src/old/entry.ts": "src/new/entry.ts" },
    );
    assert.equal(renamed.status, 0, renamed.out);
    assert.match(renamed.out, /bindings differing 0/u);
  },
);

test(
  "each configuration the tree does not establish refuses by name; a file no config owns otherwise resolves as Node runs it",
  { timeout: 60_000 },
  () => {
    const run = (before, after, ...args) => {
      const move = moveOf(before, after);
      try {
        return move.run(...args.map((arg) => (typeof arg === "function" ? arg(move) : arg)));
      } finally {
        move.done();
      }
    };
    const importer = (from) =>
      `import { value as selectedValue } from "${from}";\nexport const resultWithLongIdentifier = selectedValue;\n`;
    const value = "export const value = 1234567890;\n";
    const esm = '{ "type": "module" }\n';
    const nodeNext = (include) =>
      `{ "compilerOptions": { "module": "NodeNext", "moduleResolution": "NodeNext" }, "include": ${JSON.stringify(include)} }\n`;
    // Codex r4's first case: a nearer config whose include leaves the importer out; the root's NodeNext applies, and
    // `./new` resolves to nothing
    const nearer = {
      "package.json": esm,
      "tsconfig.json": nodeNext(["src/**/*"]),
      "src/lib/tsconfig.json":
        '{ "compilerOptions": { "module": "ESNext", "moduleResolution": "Bundler" }, "include": ["unrelated/**/*"] }\n',
    };
    const notOwned = run(
      { ...nearer, "src/lib/a.ts": importer("./old.js"), "src/lib/old.ts": value },
      {
        ...nearer,
        "src/lib/a.ts": importer("./new"),
        "src/lib/old.ts": null,
        "src/lib/new.ts": value,
      },
      "--renames",
      (move) => move.renames({ "src/lib/old.ts": "src/lib/new.ts" }),
    );
    assert.equal(notOwned.status, 1, notOwned.out);
    assert.match(
      notOwned.out,
      /refused: src\/lib\/a\.ts:1 \(added\) "\.\/new": resolves to no file/u,
    );
    // Codex r4's second case: an `extends` the committed tree does not hold; refused by name on both sides, passed only
    // when declared, each declaration printed with the refusal reason it covers
    const inherited = {
      "package.json": esm,
      "tsconfig.json": '{ "extends": "@fixture/config/base.json", "include": ["src/**/*.ts"] }\n',
    };
    const before = { ...inherited, "src/a.ts": importer("./old.js"), "src/old.ts": value };
    const after = {
      ...inherited,
      "src/a.ts": importer("./new"),
      "src/old.ts": null,
      "src/new.ts": value,
    };
    const map = (move) => move.renames({ "src/old.ts": "src/new.ts" });
    const unestablished = run(before, after, "--renames", map);
    assert.equal(unestablished.status, 1, unestablished.out);
    assert.match(
      unestablished.out,
      /refused: src\/a\.ts:1 \(removed\) "\.\/old\.js": tsconfig\.json: /u,
    );
    assert.match(unestablished.out, /refused: src\/a\.ts:1 \(added\) "\.\/new": tsconfig\.json: /u);
    const reason =
      "the configuration extends an installed package; the move's compiler run resolves it";
    const declared = run(before, after, "--renames", map, "--declare", (move) =>
      move.declare([
        { file: "src/a.ts", side: "removed", text: importer("./old.js").split("\n")[0], reason },
        { file: "src/a.ts", side: "added", text: importer("./new").split("\n")[0], reason },
      ]),
    );
    assert.equal(declared.status, 0, declared.out);
    assert.match(declared.out, /refused 0/u);
    assert.match(
      declared.out,
      /declared refusal: src\/a\.ts:1 \(removed\) "\.\/old\.js": tsconfig\.json: .*; declared: the configuration extends/u,
    );
    // a true rename of `tools/old.ts`, its import updated, under each place a file's configuration can come from
    const rename = (configs, ext, from, to) =>
      run(
        { ...configs, [`tools/a.${ext}`]: importer(from), [`tools/old.${ext}`]: value },
        {
          ...configs,
          [`tools/a.${ext}`]: importer(to),
          [`tools/old.${ext}`]: null,
          [`tools/new.${ext}`]: value,
        },
        "--renames",
        (move) => move.renames({ [`tools/old.${ext}`]: `tools/new.${ext}` }),
      );
    // a TypeScript file the nearest config's include leaves out, and no config above includes: refused by name
    const leftOut = rename(
      { "tsconfig.json": nodeNext(["src/**/*"]) },
      "ts",
      "./old.js",
      "./new.js",
    );
    assert.equal(leftOut.status, 1, leftOut.out);
    assert.match(
      leftOut.out,
      /refused: tools\/a\.ts:1 \(added\) "\.\/new\.js": no committed tsconfig\.json includes it \(the nearest, tsconfig\.json, leaves it out\)/u,
    );
    // a TypeScript file with no config above it, in a tree that has one: refused by name
    const none = rename({ "src/tsconfig.json": nodeNext(["**/*"]) }, "ts", "./old.js", "./new.js");
    assert.equal(none.status, 1, none.out);
    assert.match(
      none.out,
      /refused: tools\/a\.ts:1 \(added\) "\.\/new\.js": no committed tsconfig\.json is above it/u,
    );
    // a JavaScript file no config owns resolves as Node runs it: in an ESM package `./new` names no file, `./new.js` does
    const js = { "package.json": esm, "tsconfig.json": nodeNext(["src/**/*"]) };
    const jsExtensionless = rename(js, "js", "./old.js", "./new");
    assert.equal(jsExtensionless.status, 1, jsExtensionless.out);
    assert.match(
      jsExtensionless.out,
      /refused: tools\/a\.js:1 \(added\) "\.\/new": resolves to no file/u,
    );
    const jsRenamed = rename(js, "js", "./old.js", "./new.js");
    assert.equal(jsRenamed.status, 0, jsRenamed.out);
    assert.match(jsRenamed.out, /bindings differing 0; refused 0/u);
    // a tree with no tsconfig.json resolves a TypeScript file as Node runs it too (its ESM extensionless case is in the
    // package-context test)
    const unconfigured = rename({ "package.json": esm }, "ts", "./old.js", "./new.js");
    assert.equal(unconfigured.status, 0, unconfigured.out);
    assert.match(unconfigured.out, /bindings differing 0; refused 0/u);
  },
);

test(
  "every other module reference is refused by name, and a changed file the check does not parse is listed",
  { timeout: 60_000 },
  () => {
    // each file moved unchanged into `src/nested/`, its family named: only the module references can fail
    const run = (files) => {
      const before = { "package.json": '{ "type": "module" }\n' };
      const after = { ...before };
      const map = {};
      for (const [name, text] of Object.entries(files)) {
        before[`src/${name}`] = text;
        after[`src/${name}`] = null;
        after[`src/nested/${name}`] = text;
        map[`src/${name}`] = `src/nested/${name}`;
      }
      const move = moveOf(before, after);
      try {
        return move.run("--renames", move.renames(map));
      } finally {
        move.done();
      }
    };
    const refusedAt = (out, file, line, what) =>
      assert.match(
        out,
        new RegExp(
          `refused: src/nested/${file.replaceAll(".", "\\.")}:${line} \\(added\\) ".*": ${what}, a module reference the binding rule does not compare`,
          "u",
        ),
      );
    // (a) an `import` keyword outside a compared statement: a type import and a dynamic one; `import.meta` is none
    const imports = run({
      "a.ts": [
        'export type Result = import("./dep.js").RecordType;',
        'export const load = async () => await import("./dep.js");',
        "export const here = import.meta.url;",
        "",
      ].join("\n"),
    });
    assert.equal(imports.status, 1, imports.out);
    refusedAt(imports.out, "a.ts", 1, "an `import`");
    refusedAt(imports.out, "a.ts", 2, "an `import`");
    assert.match(imports.out, /refused 4/u);
    // (b) a `require` identifier
    const required = run({
      "a.cjs": 'const selected = require("./dep.cjs");\nmodule.exports = selected;\n',
    });
    assert.equal(required.status, 1, required.out);
    refusedAt(required.out, "a.cjs", 1, "a `require`");
    // (c) the parser's triple-slash reference directives
    const directives = run({
      "a.ts":
        '/// <reference path="./dep.d.ts" />\n/// <reference types="./dep.d.ts" />\n/// <reference lib="es2024" />\nexport const value = 1;\n',
    });
    assert.equal(directives.status, 1, directives.out);
    refusedAt(directives.out, "a.ts", 1, "a `/// <reference path>`");
    refusedAt(directives.out, "a.ts", 2, "a `/// <reference types>`");
    refusedAt(directives.out, "a.ts", 3, "a `/// <reference lib>`");
    // (d) a comment, JSDoc included, holding `import(` or `@import`
    const comments = run({
      "a.js":
        '// loaded later through import("./dep.js")\nexport const value = null;\n/** @import { RecordType } from "./dep.js" */\n',
    });
    assert.equal(comments.status, 1, comments.out);
    refusedAt(comments.out, "a.js", 1, "a comment's `import\\(`");
    refusedAt(comments.out, "a.js", 3, "a comment's `@import`");
    // a JSDoc type's `import` keyword is (a)'s, however it is spaced, and on a compared statement too
    const spaced = run({
      "a.js": [
        '/** @type {import ("./dep.js").RecordType} */',
        "export const value = null;",
        "/**",
        " * @returns {typeof import",
        ' *   ("./dep.js")}',
        " */",
        "export const load = () => null;",
        '/** @type {import\t("./dep.js").RecordType} */',
        'export { other } from "./other.js";',
        '/** @typedef {import ("./dep.js").RecordType} RecordType */',
        "",
      ].join("\n"),
    });
    assert.equal(spaced.status, 1, spaced.out);
    refusedAt(spaced.out, "a.js", 1, "an `import`");
    refusedAt(spaced.out, "a.js", 4, "an `import`");
    refusedAt(spaced.out, "a.js", 8, "an `import`");
    // after the last statement, held by the end-of-file token (Codex r7)
    refusedAt(spaced.out, "a.js", 10, "an `import`");
    // a `.jsx` file is parsed
    const jsx = run({
      "a.jsx": 'export const element = <div>{await import("./dep.cjs")}</div>;\n',
    });
    assert.equal(jsx.status, 1, jsx.out);
    refusedAt(jsx.out, "a.jsx", 1, "an `import`");
    // a file the check does not parse is outside the rule, and listed
    const unparsed = run({
      "view.vue": '<script setup>\nimport Dep from "./dep.vue";\n</script>\n',
    });
    assert.equal(unparsed.status, 0, unparsed.out);
    assert.match(
      unparsed.out,
      /not compared \(unparsed\): src\/view\.vue → src\/nested\/view\.vue/u,
    );
  },
);

test(
  "a declared refusal binds its declaration to its own line, as Git counts lines: one declaration covers one line (#2461)",
  { timeout: 60_000 },
  () => {
    const missing = 'import "./missing.js";';
    const run = (before, after, declared) => {
      const move = moveOf({ "a.js": before }, { "a.js": after });
      try {
        const entries = declared.map(([side, text]) => ({
          file: "a.js",
          side,
          text,
          reason: "a witness",
        }));
        return move.run("--declare", move.declare(entries));
      } finally {
        move.done();
      }
    };
    const twice = `${missing}\n${missing}\n`;
    const pair = [
      ["removed", missing],
      ["added", missing],
    ];
    // two unchanged equal refused lines: one declaration per side covers one of them, two cover both
    const one = run(twice, `${twice}\n`, pair);
    assert.equal(one.status, 1, one.out);
    assert.match(one.out, /declared 2; unadmitted 0; bindings differing 0; refused 2/u);
    const both = run(twice, `${twice}\n`, [...pair, ...pair]);
    assert.equal(both.status, 0, both.out);
    // a declaration a changed line takes does not also cover an unchanged equal line
    const added = run(`${missing}\n`, twice, pair);
    assert.equal(added.status, 1, added.out);
    assert.match(added.out, /refused 1/u);
    // two refusals on one line share its declaration
    const oneLine = 'import "./one.js"; import "./two.js";';
    const shared = run(`${oneLine}\n`, `\n${oneLine}\n`, [
      ["removed", oneLine],
      ["added", oneLine],
    ]);
    assert.equal(shared.status, 0, shared.out);
    assert.match(shared.out, /declared 2; unadmitted 0; bindings differing 0; refused 0/u);
    // a lone CR or U+2028 ends no line for Git: the refusal's line is the one holding both, and another line's text
    // does not declare it
    for (const separator of ["\r", "\u2028"]) {
      const text = `// heading${separator}${missing}`;
      const exact = run(text, `\n${text}`, [
        ["removed", text],
        ["added", text],
      ]);
      assert.equal(exact.status, 0, `${JSON.stringify(separator)}: ${exact.out}`);
      const footer = `${text}\n// unrelated footer`;
      const other = run(footer, `\n${footer}`, [
        ["removed", "// unrelated footer"],
        ["added", "// unrelated footer"],
      ]);
      assert.equal(other.status, 1, `${JSON.stringify(separator)}: ${other.out}`);
    }
  },
);

test(
  "an unchanged dynamic import in a file the change edits in place is printed as not judged; changed or in a renamed file it is refused (#2583)",
  { timeout: 60_000 },
  () => {
    const loader = (dynamic, value = "weighted([1])") =>
      [
        'import { pathToFileURL } from "node:url";',
        'import { weighted } from "./a.js";',
        dynamic,
        `export const value = ${value};`,
        "",
      ].join("\n");
    const unchanged = "export const load = (p: string) => import(pathToFileURL(p).href);";
    const before = {
      "src/a.ts": `export ${helper("sumOfSquares")}\n\nexport ${helper("weighted")}\n`,
      "src/loader.ts": loader(unchanged),
    };
    const moved = {
      "src/a.ts": `export ${helper("sumOfSquares")}\n`,
      "src/b.ts": `export ${helper("weighted")}\n`,
    };
    const run = (after) => {
      const move = moveOf(before, { ...moved, ...after });
      try {
        return move.run("--renames", move.renames({ "src/a.ts": ["src/a.ts", "src/b.ts"] }));
      } finally {
        move.done();
      }
    };
    // the loader edited only where it imports the moved function: its dynamic import's line is unchanged
    const passed = run({ "src/loader.ts": loader(unchanged).replace("./a.js", "./b.js") });
    assert.equal(passed.status, 0, passed.out);
    assert.deepEqual(
      passed.out.split("\n").filter((line) => line.includes("not judged:")),
      ["  not judged: unchanged dynamic import, src/loader.ts:3"],
    );
    assert.match(passed.out, /; refused 0; declared whole 0; not judged 1$/mu);
    // the same reference on a changed line is refused, on both sides
    const changed = run({
      "src/loader.ts": loader(
        unchanged.replace("pathToFileURL(p)", "pathToFileURL(String(p))"),
      ).replace("./a.js", "./b.js"),
    });
    assert.equal(changed.status, 1, changed.out);
    assert.match(changed.out, /^ {2}refused: src\/loader\.ts:3 \(removed\) "import\(/mu);
    assert.match(changed.out, /^ {2}refused: src\/loader\.ts:3 \(added\) "import\(/mu);
    assert.doesNotMatch(changed.out, /not judged/u);
    // an unchanged one in a file the change renames (its folder, which a relative path is read from, moved) is refused
    const renamed = run({
      "src/loader.ts": null,
      "src/load/loader.ts": loader(unchanged).replace("./a.js", "../b.js"),
    });
    assert.equal(renamed.status, 1, renamed.out);
    assert.match(renamed.out, /^ {2}refused: src\/load\/loader\.ts:3 \(added\) "import\(/mu);
    assert.doesNotMatch(renamed.out, /not judged/u);
  },
);

test(
  "an unchanged line is not judged only when it is a dynamic import on both sides and nothing else (#2616 r1)",
  { timeout: 60_000 },
  () => {
    const run = (before, after) => {
      const move = moveOf({ "src/loader.ts": before }, { "src/loader.ts": after });
      try {
        return move.run();
      } finally {
        move.done();
      }
    };
    // (the change puts the unchanged line inside a template literal: at HEAD it is no reference, so it stays refused)
    const line = "export const load = (p: string) => import(p);";
    const quoted = run(`const a = 1;\n${line}\nconst b = 2;\n`, `const a = \`\n${line}\n\`;\n`);
    assert.equal(quoted.status, 1, quoted.out);
    assert.match(quoted.out, /^ {2}refused: src\/loader\.ts:2 \(removed\) "import\(p\)"/mu);
    assert.doesNotMatch(quoted.out, /not judged/u);
    // (a dynamic import beside a `require` or a type import on one unchanged line is refused)
    for (const mixed of [
      "export const both = (p: string) => [import(p), require(p)];",
      'export const both = (p: string) => import(p) as Promise<typeof import("./x.js")>;',
    ]) {
      const result = run(`${mixed}\nconst b = 1;\n`, `${mixed}\nconst b = 2;\n`);
      assert.equal(result.status, 1, result.out);
      assert.match(result.out, /^ {2}refused: src\/loader\.ts:1 \(added\) /mu);
      assert.doesNotMatch(result.out, /not judged/u);
    }
  },
);
