import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawn, spawnSync } from "node:child_process";
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
async function check(root, config, linted) {
  writeFileSync(join(root, ".oxlintrc.json"), config);
  const findings = await checkWaitingOverrides(
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
  async () => {
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
      const { findings, leftover } = await check(
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
  async () => {
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
      const { findings } = await check(root, config, ["src/clean.ts"]);
      assert.deepEqual(findings, [
        {
          at: '"src/clean.ts"], "rules": { "no-debugger": "off" } }',
          message:
            "'src/clean.ts' waits for no-debugger, but oxlint reports nothing more in it without that entry: remove it from the entry",
        },
      ]);
      // a severity oxlint's schema does not have is refused, and oxlint, which cannot parse it, does not run
      const unknown = await check(
        root,
        '{\n  "overrides": [\n    { "files": ["src/other.ts"], "rules": { "no-debugger": "of" } },\n    { "files": ["src/clean.ts"], "rules": { "no-debugger": "off" } }\n  ]\n}\n',
        ["src/other.ts", "src/clean.ts"],
      );
      assert.deepEqual(unknown.findings, [
        {
          at: '"of" } },',
          message:
            'the overrides entry\'s rule \'no-debugger\' has the severity "of", which oxlint\'s AllowWarnDeny does not have: write "off" (or "allow" or 0) to turn it off, or "error"',
        },
      ]);
      // the root rules too, and an entry with no files to point at
      const rootRules = await check(
        root,
        '{\n  "rules": { "eqeqeq": "of" },\n  "overrides": [\n    {\n      "files": [],\n      "rules": { "no-debugger": 3 }\n    }\n  ]\n}\n',
        [],
      );
      // a severity in an array, the last of a repeated key, and a configuration that extends another
      const array = await check(
        root,
        JSON.stringify({ rules: { eqeqeq: ["of", {}] } }, null, 2),
        [],
      );
      assert.deepEqual(
        array.findings.map(({ at }) => at),
        ['"of",'],
      );
      const repeated = await check(
        root,
        '{\n "rules":{\n  "no-debugger":"error",\n  "no-debugger":"of"\n }\n}\n',
        [],
      );
      assert.deepEqual(
        repeated.findings.map(({ at }) => at),
        ['"of"'],
      );
      const extended = await check(root, '{ "extends": ["./extra.json"] }', []);
      assert.deepEqual(extended.findings, [
        {
          at: '["./extra.json"] }',
          message:
            "the configuration extends another, whose rules the waiting check does not read: write its rules into this file",
        },
      ]);
      assert.deepEqual(rootRules.findings, [
        {
          at: '"of" },',
          message:
            'the configuration\'s rule \'eqeqeq\' has the severity "of", which oxlint\'s AllowWarnDeny does not have: write "off" (or "allow" or 0) to turn it off, or "error"',
        },
        {
          at: "3 }",
          message:
            'the overrides entry\'s rule \'no-debugger\' has the severity 3, which oxlint\'s AllowWarnDeny does not have: write "off" (or "allow" or 0) to turn it off, or "error"',
        },
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);

test(
  "the check stops when oxlint's output holds no findings to read",
  { timeout: 60_000 },
  async () => {
    const root = project({ "src/clean.ts": "export const one = 1;\n" });
    try {
      const config =
        '{ "overrides": [{ "files": ["src/clean.ts"], "rules": { "no-debugger": "off" } }] }';
      writeFileSync(join(root, ".oxlintrc.json"), config);
      await assert.rejects(
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
  },
);

// A JS plugin whose one finding per file differs, between the two runs, in exactly one part: its message, its place or
// its length. The difference comes from a global that only the waiting entry declares.
const MARKER_PLUGIN = `export default {
  meta: { name: "marker" },
  rules: {
    demo: {
      create: (context) => ({
        Program(node) {
          const marked = context.sourceCode.getScope(node).variables.some((variable) => variable.name === "marker");
          const [first, second] = node.body;
          if (context.filename.endsWith("message.ts"))
            context.report({ node: first, message: marked ? "with marker" : "without marker" });
          if (context.filename.endsWith("place.ts")) context.report({ node: marked ? first : second, message: "same" });
          if (context.filename.endsWith("length.ts"))
            context.report({ node: marked ? first : first.expression, message: "same" });
        },
      }),
    },
  },
};
`;

test(
  "a finding is the whole diagnostic: a change in its message, place or length alone keeps the entry, and the file comes from its field",
  { timeout: 60_000 },
  async () => {
    const root = project({
      "marker.mjs": MARKER_PLUGIN,
      "src/message.ts": "a = 1; b = 2;\nexport {};\n",
      "src/place.ts": "a = 1; b = 2;\nexport {};\n",
      "src/length.ts": "a = 1; b = 2;\nexport {};\n",
      // a name with a newline, which a line-joined identity would cut at `src/a`
      "src/a\nb.ts": "debugger;\nexport {};\n",
    });
    try {
      const config = `{
  "categories": { "correctness": "off" },
  "jsPlugins": ["${join(root, "marker.mjs")}"],
  "rules": { "marker/demo": "error", "no-debugger": "error" },
  "overrides": [
    { "files": ["src/message.ts", "src/place.ts", "src/length.ts"], "globals": { "marker": "readonly" }, "rules": { "eqeqeq": "off" } },
    { "files": ["src/a\\nb.ts"], "rules": { "no-debugger": "off" } }
  ]
}
`;
      const { findings, leftover } = await check(root, config, [
        "src/message.ts",
        "src/place.ts",
        "src/length.ts",
        "src/a\nb.ts",
      ]);
      assert.deepEqual(findings, []);
      assert.deepEqual(leftover, []);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);

const checker = fileURLToPath(new URL("./check-waiting-overrides.mjs", import.meta.url));
/** A script that runs the check in `root` on its `.oxlintrc.json` and prints `done`. */
const runner = (root, linted) => `import { readFileSync } from "node:fs";
import { checkWaitingOverrides } from ${JSON.stringify(checker)};
const config = readFileSync(".oxlintrc.json", "utf8");
await checkWaitingOverrides(${JSON.stringify(root)}, ".oxlintrc.json", config, new Set(${JSON.stringify(linted)}), ${JSON.stringify(executable)});
console.log("done");
`;

const probes = (root) => readdirSync(root).filter((name) => name.startsWith(".oxlintrc.probe-"));
const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
/** Runs `run.mjs` in `root` until its plugin holds oxlint, then sends it `signal`: its pid, how it ended, its output, the
 * probes there when the signal came, and oxlint's pid. */
async function interrupt(root, signal) {
  rmSync(join(root, "started"), { force: true });
  const run = spawn(process.execPath, ["run.mjs"], {
    cwd: root,
    stdio: ["ignore", "pipe", "ignore"],
  });
  let stdout = "";
  run.stdout.on("data", (chunk) => (stdout += chunk));
  const ended = new Promise((resolve) =>
    run.on("close", (status, signal) => resolve({ status, signal })),
  );
  // oxlint's pid, whole, before the signal: the plugin publishes it by a rename
  const deadline = Date.now() + 30_000;
  while (!existsSync(join(root, "started")) && Date.now() < deadline)
    await new Promise((resolve) => setTimeout(resolve, 20));
  const oxlint = existsSync(join(root, "started"))
    ? Number(readFileSync(join(root, "started"), "utf8"))
    : 0;
  if (!(Number.isSafeInteger(oxlint) && oxlint > 0)) {
    run.kill("SIGKILL");
    await ended;
    assert.fail(`oxlint did not start: ${oxlint}`);
  }
  const held = probes(root);
  run.kill(signal);
  const end = await ended;
  return { pid: run.pid, end, stdout, held, oxlint };
}

test(
  "a SIGINT, SIGTERM or SIGHUP removes the probe and stops oxlint and the check by that signal; after a SIGKILL, the next run removes a dead owner's probe and leaves a live one's",
  { timeout: 120_000 },
  async () => {
    // a plugin that marks the run as started with its process, then holds it
    const root = project({
      "slow.mjs": `import { renameSync, writeFileSync } from "node:fs";
export default { meta: { name: "slow" }, rules: { hold: { create: () => ({ Program() {
  writeFileSync("started.tmp", String(process.pid));
  renameSync("started.tmp", ${JSON.stringify("started")});
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5000);
} }) } } };
`,
      "src/a.ts": "export const a = 1;\n",
    });
    try {
      writeFileSync(
        join(root, ".oxlintrc.json"),
        JSON.stringify({
          categories: { correctness: "off" },
          jsPlugins: [join(root, "slow.mjs")],
          rules: { "slow/hold": "error" },
          overrides: [{ files: ["src/a.ts"], rules: { "no-debugger": "off" } }],
        }),
      );
      writeFileSync(join(root, "run.mjs"), runner(root, ["src/a.ts"]));
      for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
        const { pid, end, stdout, held, oxlint } = await interrupt(root, signal);
        assert.deepEqual(end, { status: null, signal }, signal);
        assert.equal(stdout, "", signal);
        assert.deepEqual(
          held.map((name) => name.split("-")[1]),
          [String(pid)],
          `${signal}: the probe was there when the signal came`,
        );
        assert.deepEqual(probes(root), [], `${signal}: and is gone`);
        const deadline = Date.now() + 10_000;
        while (alive(oxlint) && Date.now() < deadline)
          await new Promise((resolve) => setTimeout(resolve, 20));
        assert.ok(!alive(oxlint), `${signal}: oxlint stopped`);
      }

      // a SIGKILL leaves the probe, with its dead owner's pid
      const run = await interrupt(root, "SIGKILL");
      if (alive(run.oxlint)) process.kill(run.oxlint, "SIGKILL");
      assert.deepEqual(run.end, { status: null, signal: "SIGKILL" });
      assert.deepEqual(
        probes(root).map((name) => name.split("-")[1]),
        [String(run.pid)],
      );

      // a live owner's probe: this test's own process
      const live = `.oxlintrc.probe-${process.pid}-0123abcd.json`;
      writeFileSync(join(root, live), "{}");
      // pid 1, which another user owns (EPERM) or which is alive: left; and a near name of the dead run's: left
      const unreachable = ".oxlintrc.probe-1-0123abcd.json";
      const near = `.oxlintrc.probe-${run.pid}-0123abc.json`;
      writeFileSync(join(root, unreachable), "{}");
      writeFileSync(join(root, near), "{}");
      rmSync(join(root, "started"));
      writeFileSync(
        join(root, ".oxlintrc.json"),
        JSON.stringify({
          categories: { correctness: "off" },
          overrides: [{ files: ["src/a.ts"], rules: { "no-debugger": "off" } }],
        }),
      );
      const next = spawnSync(process.execPath, ["run.mjs"], { cwd: root, encoding: "utf8" });
      assert.equal(next.stdout, "done\n", next.stderr);
      assert.deepEqual(
        readdirSync(root)
          .filter((name) => name.startsWith(".oxlintrc.probe-"))
          .sort(),
        [live, near, unreachable].sort(),
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);

test("two findings that differ only in their JSON's key order are one finding", async () => {
  const root = project({
    "src/a.ts": "export const a = 1;\n",
    // a stand-in oxlint whose one finding has its keys in another order under the probe configuration
    "fake-oxlint.mjs": `const args = process.argv.slice(2);
const diagnostic = { message: "same", code: "x(y)", severity: "error", filename: "src/a.ts", labels: [{ span: { offset: 0, length: 1, line: 1, column: 1 } }] };
const reversed = (value) => Array.isArray(value) ? value.map(reversed) : value !== null && typeof value === "object" ? Object.fromEntries(Object.entries(value).reverse().map(([key, each]) => [key, reversed(each)])) : value;
const probe = args[args.indexOf("--config") + 1] !== ".oxlintrc.json";
process.stdout.write(JSON.stringify({ diagnostics: [probe ? reversed(diagnostic) : diagnostic] }));
`,
  });
  try {
    const config = '{ "overrides": [{ "files": ["src/a.ts"], "rules": { "eqeqeq": "off" } }] }';
    writeFileSync(join(root, ".oxlintrc.json"), config);
    const findings = await checkWaitingOverrides(
      root,
      ".oxlintrc.json",
      config,
      new Set(["src/a.ts"]),
      join(root, "fake-oxlint.mjs"),
    );
    assert.deepEqual(
      findings.map(({ message }) => message),
      [
        "'src/a.ts' waits for eqeqeq, but oxlint reports nothing more in it without that entry: remove it from the entry",
      ],
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
