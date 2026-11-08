import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { OXLINT_OPTIONS, repositoryRoot } from "./files.mjs";

// The type-aware rules of `.oxlintrc.json`, run with the options `npm run lint` gives oxlint (`OXLINT_OPTIONS`), where
// docs/LINTING.md "Type-aware rules" says they apply: the promise rules on every file, the coercion rules on the
// TypeScript in `src/`, `player/` and `tests/helpers/` alone, and node:test's calls exempt.

const executable = fileURLToPath(
  new URL("./bin/oxlint", import.meta.resolve("oxlint/package.json")),
);

const PROMISES = ["no-floating-promises", "no-misused-promises"];
const COERCIONS = ["restrict-template-expressions", "no-base-to-string"];

// One source, valid TypeScript and JavaScript alike: a floating promise, an `async` listener, an object in a template
// literal (both coercion rules) and in `String()` (no-base-to-string), and node:test's calls, none awaited.
const SOURCE = `import test, { describe } from "node:test";
async function save() {}
export function use() {
  const target = new EventTarget();
  const value = { a: 1 };
  save();
  target.addEventListener("stop", async () => {});
  return [\`\${value}\`, String(value)];
}
test("outer", async (t) => {
  t.test("inner", () => {});
});
describe("suite", () => {});
`;

// Each place, and whether the coercion rules apply there.
const PLACES = {
  "src/place.ts": true,
  "player/place.ts": true,
  "player/vue/src/place.ts": true,
  "tests/helpers/place.ts": true,
  "tests/place.test.ts": false,
  "tests/families/place.mjs": false,
  "tools/place.mjs": false,
  "src/place.mts": true,
  "src/place.mjs": false,
};

test(
  "each type-aware rule finds its sites where the section says, and node:test's calls pass",
  { timeout: 60_000 },
  () => {
    const root = mkdtempSync(join(tmpdir(), "type-aware-rules-"));
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
        ...Object.fromEntries(Object.keys(PLACES).map((place) => [place, SOURCE])),
      };
      for (const [path, text] of Object.entries(files)) {
        mkdirSync(dirname(join(root, path)), { recursive: true });
        writeFileSync(join(root, path), text);
      }
      const result = spawnSync(
        process.execPath,
        [executable, ...OXLINT_OPTIONS, "-f", "json", ...Object.keys(PLACES)],
        { cwd: root, encoding: "utf8" },
      );
      const { diagnostics } = JSON.parse(result.stdout);
      const found = (place, rule) =>
        diagnostics
          .filter(({ filename, code }) => filename === place && code === `typescript(${rule})`)
          .map(({ labels }) => labels[0].span.line);
      for (const [place, coerced] of Object.entries(PLACES)) {
        // the floating `save()` and the listener only: node:test's `test`, `t.test` and `describe` are exempt
        assert.deepEqual(found(place, "no-floating-promises"), [6], place);
        assert.deepEqual(found(place, "no-misused-promises"), [7], place);
        assert.deepEqual(found(place, "restrict-template-expressions"), coerced ? [8] : [], place);
        assert.deepEqual(found(place, "no-base-to-string"), coerced ? [8, 8] : [], place);
      }
      // each rule finds something somewhere, and the coercion rules are absent somewhere
      for (const rule of [...PROMISES, ...COERCIONS])
        assert.ok(
          Object.keys(PLACES).some((place) => found(place, rule).length > 0),
          rule,
        );
      for (const rule of COERCIONS)
        assert.ok(
          Object.keys(PLACES).some((place) => found(place, rule).length === 0),
          rule,
        );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);
