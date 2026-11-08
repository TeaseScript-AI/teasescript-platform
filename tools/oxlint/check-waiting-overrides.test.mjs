import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
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

/** The findings for `config` (the text of `.oxlintrc.json`) in `root`, as `line: message`; and the probe left over. */
function check(root, config, linted) {
  writeFileSync(join(root, ".oxlintrc.json"), config);
  const findings = checkWaitingOverrides(
    root,
    ".oxlintrc.json",
    config,
    new Set(linted),
    executable,
  );
  const lines = config.split("\n");
  return {
    findings: findings.map(({ fileName, line, column, message }) => {
      assert.equal(fileName, ".oxlintrc.json");
      return { at: lines[line - 1].slice(column - 1), message };
    }),
    leftover: readdirSync(root).filter((name) => name.startsWith(".oxlintrc.probe-")),
  };
}

const FILES = {
  // a finding only with the scope entry's option off (its pattern ignores the name)
  "src/allowed.ts": "const allowedName = 1;\nexport {};\n",
  // a finding of the scope entry's option (numbers refused in templates)
  "src/number.ts": "export const f = (value: number): string => `${value}`;\n",
  // a global the configuration declares
  "src/known.ts": "known;\nexport {};\n",
  // a bare rule name, which oxlint reports as `typescript(no-explicit-any)`
  "src/any.ts": "export const x: any = 1;\n",
  // a finding of a JS plugin given by its path alone
  "src/plugged.ts": "export const y = 1;\n",
  // a finding of rules on in both runs (`no-debugger`, and the plugin's in every file), none of the waiting rule's
  "src/other.ts": "debugger;\nexport {};\n",
  "src/clean.ts": "export const one = 1;\n",
  "plugin.mjs":
    'export default { meta: { name: "my-plugin" }, rules: { demo: { create: (context) => ({ Program: (node) => context.report({ node, message: "demo" }) }) } } };\n',
};

test(
  "a listed path is kept exactly when oxlint reports more in it without the entry",
  { timeout: 60_000 },
  () => {
    const root = project(FILES);
    try {
      const config = `{
  "categories": { "correctness": "off" },
  "globals": { "known": "readonly" },
  "jsPlugins": ["${join(root, "plugin.mjs")}"],
  "rules": { "no-explicit-any": "error", "no-debugger": "error", "no-undef": "error", "my-plugin/demo": "error" },
  "overrides": [
    {
      "files": ["src/**/*.ts"],
      "rules": {
        "no-unused-vars": ["error", { "varsIgnorePattern": "^allowedName" }],
        "typescript/restrict-template-expressions": ["error", { "allowNumber": false }]
      }
    },
    { "files": ["src/allowed.ts", "src/number.ts"], "rules": { "no-unused-vars": "allow", "typescript/restrict-template-expressions": 0 } },
    { "files": ["src/known.ts", "src/any.ts"], "rules": { "no-undef": ["allow", {}], "no-explicit-any": "off" } },
    { "files": ["src/plugged.ts"], "rules": { "my-plugin/demo": "off" } },
    { "files": ["src/other.ts", "src/gone.ts", "src/*.ts"], "rules": { "eqeqeq": "off" } }
  ]
}
`;
      const { findings, leftover } = check(
        root,
        config,
        Object.keys(FILES).filter((path) => path.endsWith(".ts")),
      );
      assert.deepEqual(findings, [
        {
          at: '"src/allowed.ts", "src/number.ts"], "rules": { "no-unused-vars": "allow", "typescript/restrict-template-expressions": 0 } },',
          message:
            "'src/allowed.ts' waits for no-unused-vars, typescript/restrict-template-expressions, but oxlint reports nothing more in it without that entry: remove it from the entry",
        },
        {
          at: '"src/known.ts", "src/any.ts"], "rules": { "no-undef": ["allow", {}], "no-explicit-any": "off" } },',
          message:
            "'src/known.ts' waits for no-undef, no-explicit-any, but oxlint reports nothing more in it without that entry: remove it from the entry",
        },
        {
          at: '"src/other.ts", "src/gone.ts", "src/*.ts"], "rules": { "eqeqeq": "off" } }',
          message:
            "'src/other.ts' waits for eqeqeq, but oxlint reports nothing more in it without that entry: remove it from the entry",
        },
        {
          at: '"src/gone.ts", "src/*.ts"], "rules": { "eqeqeq": "off" } }',
          message:
            "'src/gone.ts' is in an overrides entry that only turns rules off, but no linted file has that path: a waiting list names files, never patterns",
        },
        {
          at: '"src/*.ts"], "rules": { "eqeqeq": "off" } }',
          message:
            "'src/*.ts' is in an overrides entry that only turns rules off, but no linted file has that path: a waiting list names files, never patterns",
        },
      ]);
      assert.deepEqual(leftover, []);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);

test(
  "a finding points at its file's name in its own entry, and an unknown severity is refused",
  { timeout: 60_000 },
  () => {
    const root = project(FILES);
    try {
      // the first entry's options hold the strings "files" and "src/clean.ts"; the finding is the second entry's
      const config = `{
  "categories": { "correctness": "off" },
  "overrides": [
    { "files": ["src/clean.ts"], "rules": { "no-unused-vars": ["error", { "varsIgnorePattern": "files", "argsIgnorePattern": "src/clean.ts" }] } },
    { "files": ["src/clean.ts"], "rules": { "no-debugger": "off" } }
  ]
}
`;
      const { findings } = check(root, config, ["src/clean.ts"]);
      assert.deepEqual(findings, [
        {
          at: '"src/clean.ts"], "rules": { "no-debugger": "off" } }',
          message:
            "'src/clean.ts' waits for no-debugger, but oxlint reports nothing more in it without that entry: remove it from the entry",
        },
      ]);
      // a severity oxlint's schema does not have is refused, and oxlint, which cannot parse it, does not run
      const unknown = check(
        root,
        '{\n  "overrides": [\n    { "files": ["src/other.ts"], "rules": { "no-debugger": "of" } },\n    { "files": ["src/clean.ts"], "rules": { "no-debugger": "off" } }\n  ]\n}\n',
        ["src/other.ts", "src/clean.ts"],
      );
      assert.deepEqual(unknown.findings, [
        {
          at: '"src/other.ts"], "rules": { "no-debugger": "of" } },',
          message:
            'the overrides entry\'s rule \'no-debugger\' has the severity "of", which oxlint\'s AllowWarnDeny does not have: write "off" (or "allow" or 0) to turn it off, or "error"',
        },
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);

test("the check stops when oxlint's output holds no findings to read", { timeout: 60_000 }, () => {
  const root = project({ "src/clean.ts": "export const one = 1;\n" });
  try {
    const config =
      '{ "overrides": [{ "files": ["src/clean.ts"], "rules": { "no-debugger": "off" } }] }';
    writeFileSync(join(root, ".oxlintrc.json"), config);
    assert.throws(
      () =>
        checkWaitingOverrides(
          root,
          ".oxlintrc.json",
          config,
          new Set(["src/clean.ts"]),
          join(root, "missing"),
        ),
      /oxlint printed no findings to read/,
    );
    assert.deepEqual(
      readdirSync(root).filter((name) => name.startsWith(".oxlintrc.probe-")),
      [],
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
