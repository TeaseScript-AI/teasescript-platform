import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { OXLINT_OPTIONS, repositoryRoot } from "./files.mjs";

// The names a JavaScript file reads, by `.oxlintrc.json` run with the options `npm run lint` gives oxlint, as
// docs/LINTING.md "Names in JavaScript files" says: an unbound name fails with its file, line and name; an ES module
// reads none of CommonJS's five names; the two tools that hand functions to a page may read the browser's globals.

const executable = fileURLToPath(
  new URL("./bin/oxlint", import.meta.resolve("oxlint/package.json")),
);

// A function that reads the browser's globals, as a page function does, and one Node name it does not import.
const PAGE =
  "export const title = () => document.title + window.name;\nexport const base = path.sep;\n";

// Each file, and the names that fail in it, as [line, rule, name].
const FILES = {
  // #2628's reproduction: a split's new file reads `path`, which only the file it came from imports
  "tools/b.mjs": [
    "// The basename helper, split out of `a.mjs`.",
    "",
    "export function basenameOf(file) {",
    "  return path.posix.basename(file, path.posix.extname(file));",
    "}",
    "",
  ].join("\n"),
  "tools/esm.mjs": [
    'import { createRequire } from "node:module";',
    "export const here = __dirname;",
    'export const fs = require("node:fs");',
    "export function load(require) {",
    '  return [require("node:fs"), createRequire(import.meta.url), process.argv, Buffer.alloc(0)];',
    "}",
    "",
  ].join("\n"),
  "tools/script.cjs":
    'const fs = require("node:fs");\nmodule.exports = { fs, here: __dirname, at: __filename };\n',
  "src/place.ts": "export const value: Missing | undefined = undefined;\n",
  "tools/player-preview-checks.mjs": PAGE,
  "tools/player-firefox-camera.mjs": PAGE,
  "tools/page.mjs": PAGE,
};
const EXPECTED = {
  "tools/b.mjs": [
    [4, "no-undef", "path"],
    [4, "no-undef", "path"],
  ],
  "tools/esm.mjs": [
    [2, "no-restricted-globals", "__dirname"],
    [3, "no-restricted-globals", "require"],
  ],
  "tools/script.cjs": [],
  "src/place.ts": [],
  "tools/player-preview-checks.mjs": [[2, "no-undef", "path"]],
  "tools/player-firefox-camera.mjs": [[2, "no-undef", "path"]],
  "tools/page.mjs": [
    [1, "no-undef", "document"],
    [1, "no-undef", "window"],
    [2, "no-undef", "path"],
  ],
};

test(
  "an unbound name in a JavaScript file fails by file, line and name; CommonJS's names fail in an ES module; the page tools read the browser's",
  { timeout: 60_000 },
  () => {
    const root = mkdtempSync(join(tmpdir(), "javascript-names-"));
    try {
      symlinkSync(join(repositoryRoot, "node_modules"), join(root, "node_modules"));
      const config = JSON.parse(readFileSync(join(repositoryRoot, ".oxlintrc.json"), "utf8"));
      for (const plugin of config.jsPlugins ?? [])
        plugin.specifier = resolve(repositoryRoot, plugin.specifier);
      const files = {
        ".oxlintrc.json": JSON.stringify(config),
        "tsconfig.json": JSON.stringify({
          compilerOptions: { module: "NodeNext", strict: true, types: ["node"], noEmit: true },
          include: ["**/*.ts"],
        }),
        ...FILES,
      };
      for (const [path, text] of Object.entries(files)) {
        mkdirSync(dirname(join(root, path)), { recursive: true });
        writeFileSync(join(root, path), text);
      }
      const result = spawnSync(
        process.execPath,
        [executable, ...OXLINT_OPTIONS, "-f", "json", ...Object.keys(FILES)],
        { cwd: root, encoding: "utf8" },
      );
      const { diagnostics } = JSON.parse(result.stdout);
      for (const [file, expected] of Object.entries(EXPECTED)) {
        const found = diagnostics
          .filter(
            ({ filename, code }) =>
              filename === file &&
              ["eslint(no-undef)", "eslint(no-restricted-globals)"].includes(code),
          )
          .map(({ code, message, labels }) => [
            labels[0].span.line,
            code.slice("eslint(".length, -1),
            /'([^']+)'/u.exec(message)[1],
          ])
          .sort((a, b) => a[0] - b[0] || a[2].localeCompare(b[2]));
        assert.deepEqual(found, expected, file);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);
