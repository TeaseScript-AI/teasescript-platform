import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { checkWaitingOverrides } from "./check-waiting-overrides.mjs";
import { repositoryRoot } from "./files.mjs";

const executable = fileURLToPath(
  new URL("./bin/oxlint", import.meta.resolve("oxlint/package.json")),
);

/** A project holding `files` (path to text), with the repository's `node_modules`; its folder. */
function project(files) {
  const root = mkdtempSync(join(tmpdir(), "waiting-overrides-test-"));
  symlinkSync(join(repositoryRoot, "node_modules"), join(root, "node_modules"));
  const tsconfig = {
    compilerOptions: { module: "NodeNext", strict: true, types: ["node"], noEmit: true },
    include: ["**/*.ts"],
  };
  for (const [path, text] of Object.entries({
    "tsconfig.json": JSON.stringify(tsconfig),
    ...files,
  })) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  return root;
}

const CONFIG = `{
  "rules": { "no-unused-vars": ["error", { "varsIgnorePattern": "^_" }] },
  "overrides": [
    {
      "files": ["src/coerces.ts", "src/clean.ts"],
      "rules": { "typescript/restrict-template-expressions": "off", "typescript/no-base-to-string": "off" }
    },
    { "files": ["src/**/*.ts"], "rules": { "typescript/restrict-template-expressions": "error" } },
    {
      "files": ["src/unused.ts", "src/ignored.ts", "src/clean.ts", "src/*.ts", "src/gone.ts"],
      "rules": { "no-unused-vars": "off", "no-debugger": "off", "eqeqeq": "off", "no-empty": "off" }
    }
  ]
}
`;

test(
  "a listed file that still has a finding of its entry's rules passes, and a clean one is reported",
  { timeout: 60_000 },
  () => {
    const root = project({
      "src/coerces.ts": "export const text = (value: { a: number }): string => `${value}`;\n",
      "src/clean.ts": "export const one = 1;\n",
      "src/unused.ts": "const unused = 1;\nexport {};\n",
      // the configuration's own option ignores it, so its entry no longer needs it
      "src/ignored.ts": "const _ignored = 1;\nexport {};\n",
    });
    try {
      const linted = new Set(["src/coerces.ts", "src/clean.ts", "src/unused.ts", "src/ignored.ts"]);
      const findings = checkWaitingOverrides(root, CONFIG, linted, executable);
      const lines = CONFIG.split("\n");
      assert.deepEqual(
        findings.map(({ fileName, line, column, message }) => {
          assert.equal(fileName, ".oxlintrc.json");
          // each finding points at its file's name in its own entry
          assert.ok(lines[line - 1].slice(column - 1).startsWith('"'), `${line}:${column}`);
          return `${line}: ${message}`;
        }),
        [
          "5: 'src/clean.ts' waits for typescript/restrict-template-expressions and typescript/no-base-to-string, but none of them finds anything in it: remove it from that overrides entry",
          "10: 'src/ignored.ts' waits for the 4 rules its overrides entry turns off, but none of them finds anything in it: remove it from that overrides entry",
          "10: 'src/clean.ts' waits for the 4 rules its overrides entry turns off, but none of them finds anything in it: remove it from that overrides entry",
          "10: 'src/*.ts' is in an overrides entry that only turns rules off, but no linted file has that path: a waiting list names files, never patterns",
          "10: 'src/gone.ts' is in an overrides entry that only turns rules off, but no linted file has that path: a waiting list names files, never patterns",
        ],
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);

test("the check stops when oxlint's output holds no findings to read", { timeout: 60_000 }, () => {
  const root = project({ "src/clean.ts": "export const one = 1;\n" });
  try {
    assert.throws(
      () => checkWaitingOverrides(root, CONFIG, new Set(["src/clean.ts"]), join(root, "missing")),
      /oxlint printed no findings to read/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
