import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
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
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { callSitesOf, verdict } from "./regression-cases.mjs";
import { regressionCase } from "../../tests/helpers/regression-case.ts";

const repositoryRoot = fileURLToPath(new URL("../../", import.meta.url));
const tool = fileURLToPath(new URL("./regression-cases.mjs", import.meta.url));

// The verdict's family: each record a case can leave at the base, against an `atBase` that matches the first line
// whole, matches only part of it, or does not match.
const RECORDS = {
  passed: { started: true, passed: true },
  "failed in its code": {
    started: true,
    failed: "Missing expected rejection (ForeignSessionError).",
  },
  "started, no end": { started: true },
  "no record": undefined,
};
const PATTERNS = {
  "matches the whole line": /Missing expected rejection \(ForeignSessionError\)\./,
  "matches part of the line": /ForeignSessionError/,
  "does not match": /Missing expected exception\./,
};
const EXPECTED = {
  passed: () => "passed",
  "failed in its code": (pattern) =>
    pattern === "matches the whole line" ? "witness" : "other failure",
  "started, no end": () => "did not finish",
  "no record": () => "did not run",
};

test("a case is a witness only when it threw an error whose first line `atBase` matches whole", () => {
  const cases = Object.keys(RECORDS).flatMap((record) =>
    Object.keys(PATTERNS).map((pattern) => ({ record, pattern })),
  );
  const records = new Map();
  const declared = cases.map(({ record, pattern }, index) => {
    const id = `dist/tests/x.test.js:${index + 1}:1#1`;
    if (RECORDS[record] !== undefined) records.set(id, RECORDS[record]);
    return {
      id,
      file: "dist/tests/x.test.js",
      name: `${record}, ${pattern}`,
      pr: 7,
      atBase: { source: PATTERNS[pattern].source, flags: PATTERNS[pattern].flags },
    };
  });
  const judged = verdict(
    declared,
    records,
    new Map([["dist/tests/x.test.js", "SyntaxError: no export"]]),
  );
  for (const [index, { record, pattern }] of cases.entries())
    assert.equal(judged[index].verdict, EXPECTED[record](pattern), `${record}, ${pattern}`);
  // a case with no record names its file's load error
  assert.equal(
    judged.find(({ verdict: each }) => each === "did not run").detail,
    "SyntaxError: no export",
  );
  assert.equal(new Set(cases.map(({ record, pattern }) => `${record}, ${pattern}`)).size, 12);
});

test("a call site is the callee's name, by line and column, as a stack frame names it", () => {
  const text = [
    'import { regressionCase } from "./helpers/regression-case.js";',
    'regressionCase("a", {}, () => {});',
    "  helpers.regressionCase(",
    '    "b",',
    "  );",
    'other("c");',
  ].join("\n");
  assert.deepEqual(callSitesOf("dist/tests/x.test.js", text), [
    "dist/tests/x.test.js:2:1",
    "dist/tests/x.test.js:3:11",
  ]);
});

// Outside the tool, a declared case is a plain test: it runs, and registers nothing else.
let ran = false;
regressionCase(
  "a declared case runs as a plain test outside the tool",
  { pr: 1, atBase: /never/ },
  () => {
    ran = true;
  },
);
test("the declared case above ran", () => assert.equal(ran, true));

/** Writes `files` (path to text) under `root`. */
function write(root, files) {
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
}

const BRIDGE_BASE = `export class BridgeRefusal extends Error {
  override name = "BridgeRefusal";
}
/** The base: a session of another bridge is read as this one's, and an op that needs no session is refused. */
export class Bridge {
  readonly sessions = new Set<object>();
  latest(session: object): object {
    return session;
  }
  request(session: object, op: string): string {
    if (op === "captureKeep") throw new BridgeRefusal(\`Op '\${op}' works on no session.\`);
    return op;
  }
}
`;
const BRIDGE_HEAD = `export class BridgeRefusal extends Error {
  override name = "BridgeRefusal";
}
export class ForeignSessionError extends Error {
  override name = "ForeignSessionError";
}
/** The fix: a session of another bridge is refused by every method that takes one. */
export class Bridge {
  readonly sessions = new Set<object>();
  #own(session: object): void {
    if (!this.sessions.has(session)) throw new ForeignSessionError("a session of another bridge");
  }
  latest(session: object): object {
    this.#own(session);
    return session;
  }
  request(session: object, op: string): string {
    this.#own(session);
    if (op === "captureKeep") throw new BridgeRefusal(\`Op '\${op}' works on no session.\`);
    return op;
  }
}
`;
// a Player module the tests load from the bundles (`tests/helpers/player-modules.ts`): the base's must be built
const CLOCK = "export const minutes = (seconds: number): number => Math.floor(seconds / 60);\n";
// The base's configuration is built as \`vite build\` builds it: a function of its environment, with a plugin it gives
// as a promise, and without the head's stamping plugin. That plugin makes the base's defect: the case is a witness only
// when it runs.
const BUNDLES_CONFIG = `import { fileURLToPath, URL } from "node:url";
import { defineConfig } from "vite";

export default defineConfig(({ command, isSsrBuild }) => {
  if (command !== "build" || isSsrBuild !== false) throw new Error(\`not as vite build: \${command} \${isSsrBuild}\`);
  return {
    root: fileURLToPath(new URL("../..", import.meta.url)),
    logLevel: "warn",
    publicDir: false,
    plugins: [Promise.resolve([{ name: "rounds", transform: (code, id) => (id.endsWith("/clock.ts") ? code.replace("Math.floor", "Math.round") : null) }])],
    build: {
      ssr: true,
      outDir: "dist/player-test-modules",
      emptyOutDir: true,
      rolldownOptions: { input: { "player/clock": "player/clock.ts" }, output: { entryFileNames: "[name].js" } },
    },
  };
});
`;
const PLAYER = `import assert from "node:assert/strict";
import { loadPlayerModule } from "./helpers/player-modules.js";
import { regressionCase } from "./helpers/regression-case.js";

regressionCase("a minute and a half shows one minute", { pr: 7, atBase: /#7 minutes of 90 s/ }, async () => {
  const { minutes } = (await loadPlayerModule("player/clock.ts")) as { minutes: (seconds: number) => number };
  assert.equal(minutes(90), 1, "#7 minutes of 90 s");
});
`;

/**
 * A repository whose base commit has the defect and whose head commit fixes it and adds `head` (path to text), built
 * with `tsc` as CI's test job leaves it: `{ root, base, run }`, `run(...args)` starting the tool in it with a scratch
 * folder of its own (`TMPDIR`).
 */
function repository(head) {
  const root = mkdtempSync(join(tmpdir(), "rc-fixture-"));
  const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
  git("init", "-q");
  git("config", "user.email", "t@t");
  git("config", "user.name", "t");
  write(root, {
    ".gitignore": "node_modules\ndist/\ntmp/\n",
    // ES modules, as the repository's: a missing named import fails the file at the base
    "package.json": JSON.stringify({ type: "module" }),
    "tsconfig.json": JSON.stringify({
      compilerOptions: {
        target: "ES2025",
        module: "NodeNext",
        moduleResolution: "NodeNext",
        rootDir: ".",
        outDir: "dist",
        strict: true,
        sourceMap: true,
        types: ["node"],
      },
      include: ["src/**/*.ts", "tests/**/*.ts"],
    }),
    "src/bridge.ts": BRIDGE_BASE,
    "player/clock.ts": CLOCK,
    "player/vue/vite.test-modules.config.ts": BUNDLES_CONFIG,
    ...Object.fromEntries(
      ["tests/helpers/regression-case.ts", "tests/helpers/player-modules.ts"].map((path) => [
        path,
        readFileSync(join(repositoryRoot, path), "utf8"),
      ]),
    ),
  });
  symlinkSync(join(repositoryRoot, "node_modules"), join(root, "node_modules"));
  git("add", "-A");
  git("commit", "-q", "-m", "Keep a session store (#3)");
  const base = git("rev-parse", "HEAD");
  // The head adds the plugin that stamps the bundles' sources, which its loader requires; the base has none.
  write(root, {
    "src/bridge.ts": BRIDGE_HEAD,
    "player/vue/test-modules-sources.ts": readFileSync(
      join(repositoryRoot, "player/vue/test-modules-sources.ts"),
      "utf8",
    ),
    ...head,
  });
  git("add", "-A");
  git("commit", "-q", "-m", "Refuse a session of another bridge");
  spawnSync(
    process.execPath,
    [join(root, "node_modules/@typescript/native/bin/tsc"), "-p", "tsconfig.json"],
    { cwd: root },
  );
  mkdirSync(join(root, "tmp"));
  const { NODE_TEST_CONTEXT: _context, ...withoutTestContext } = process.env;
  // started as CI starts it, not as a test: `node:test` refuses a run inside one
  const env = {
    ...withoutTestContext,
    REGRESSION_CASES: "",
    TMPDIR: join(root, "tmp"),
    RC_FIXTURE_ROOT: root,
  };
  const run = (...args) =>
    spawnSync(process.execPath, [tool, ...args], { cwd: root, encoding: "utf8", env });
  return { root, base, env, run };
}

const HELPER = 'import { regressionCase } from "./helpers/regression-case.js";\n';
const AT = "/Missing expected exception \\(ForeignSessionError\\)\\./";

test(
  "a declaration the tool cannot account for, or cannot use, is refused, and nothing runs at the base",
  { timeout: 120_000 },
  () => {
    const { root, base, run } = repository({
      "tests/refused.test.ts": `import { describe, test } from "node:test";
${HELPER}
// inside a test's body, and in a suite that never runs: no registration at the head
test("parent", () => {
  regressionCase("nested", { pr: 7, atBase: /defect/ }, () => {});
});
describe.skip("skipped", () => {
  regressionCase("in a skipped suite", { pr: 7, atBase: /defect/ }, () => {});
});
regressionCase("no expression", { pr: 7, atBase: undefined as unknown as RegExp }, () => {});
regressionCase("multiline", { pr: 7, atBase: /defect/m }, () => {});
regressionCase("global", { pr: 7, atBase: /defect/g }, () => {});
regressionCase("a case of no merged pull request", { pr: 99, atBase: /defect/ }, () => {});
`,
    });
    try {
      const result = run("--base", base, "--pr", "7");
      assert.equal(result.status, 1, result.stdout + result.stderr);
      const lines = result.stderr.trim().split("\n");
      const at = (line) => `tests/refused.test.ts:${line}: `;
      assert.deepEqual(lines, [
        `${at(6)}this regressionCase call did not register at the head: declare it at a file's top level or in a describe that runs, not inside a test or a skipped suite`,
        `${at(9)}this regressionCase call did not register at the head: declare it at a file's top level or in a describe that runs, not inside a test or a skipped suite`,
        `${at(11)}'no expression' declares no regular expression as \`atBase\`: give one`,
        `${at(12)}'multiline' declares \`atBase\` with the flags 'm': only 'i', 'u' and 'v' keep it one whole line, so drop the others`,
        `${at(13)}'global' declares \`atBase\` with the flags 'g': only 'i', 'u' and 'v' keep it one whole line, so drop the others`,
        `${at(14)}'a case of no merged pull request' names #99, which is neither this pull request (#7) nor one merged into the base: name the pull request whose fix it witnesses`,
      ]);
      assert.equal(
        result.stdout,
        "regression-cases: 6 declarations refused; nothing runs at the base\n",
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);

test(
  "a file whose declarations cannot be listed is refused with its error",
  { timeout: 120_000 },
  () => {
    const { root, base, run } = repository({
      "tests/broken.test.ts": `import { describe } from "node:test";
${HELPER}
describe("a suite that throws", () => {
  throw new Error("cannot build this suite");
});
regressionCase("x", { pr: 7, atBase: /defect/ }, () => {});
`,
    });
    try {
      const result = run("--base", base, "--pr", "7");
      assert.equal(result.status, 1, result.stdout + result.stderr);
      assert.match(
        result.stderr,
        /^tests\/broken\.test\.ts: its declarations cannot be listed, as its run at the head failed: .*cannot build this suite/mu,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);

// each verdict, at the base, by the helper's own record
const VERDICTS = `import assert from "node:assert/strict";
import { beforeEach, describe, test } from "node:test";
import { writeFileSync } from "node:fs"; import { join } from "node:path";
import { Bridge } from "../src/bridge.js";
${HELPER}
const foreign = {};
const at = ${AT};
regressionCase("latest refuses a foreign session", { pr: 7, atBase: at }, () => {
  assert.throws(() => new Bridge().latest(foreign), { name: "ForeignSessionError" });
});
// the base refuses this op for another reason: R3's \`request\` case
regressionCase("captureKeep refuses a foreign session", { pr: 7, atBase: at }, () => {
  assert.throws(() => new Bridge().request(foreign, "captureKeep"), { name: "ForeignSessionError" });
});
// a same-named ordinary test that fails at the base with \`atBase\`'s line cannot stand in for the case, which passes there
regressionCase("an own op passes", { pr: 7, atBase: at }, () => {
  const bridge = new Bridge();
  bridge.sessions.add(foreign);
  assert.equal(bridge.request(foreign, "observeTime"), "observeTime");
});
test.only("an own op passes", () => {
  assert.throws(() => new Bridge().latest(foreign), { name: "ForeignSessionError" });
});
// a historical case does not run
regressionCase("an older fix's case", { pr: 3, atBase: at }, () => {
  writeFileSync(join(process.env.RC_FIXTURE_ROOT ?? ".", "historical-ran"), "");
});
// the first line ends at CR LF, and at a lone CR
regressionCase("a CR LF message", { pr: 7, atBase: /defect/ }, () => {
  throw new Error("defect\\r\\nmore");
});
regressionCase("a CR message", { pr: 7, atBase: /defect/ }, () => {
  throw new Error("unrelated\\rdefect");
});
describe("a hook", () => {
  beforeEach(() => {
    throw new Error("the hook fails");
  });
  regressionCase("after a failing hook", { pr: 7, atBase: /defect/ }, () => {});
});
for (const row of ["looped witness", "looped pass"])
  regressionCase(row, { pr: 7, atBase: at }, () => {
    if (row === "looped witness") assert.throws(() => new Bridge().latest(foreign), { name: "ForeignSessionError" });
  });
`;
// a case its suite's timeout cancels at the base, which throws `atBase`'s line after that: it did not finish
const CANCELLED = `import { setTimeout as delay } from "node:timers/promises";
import { describe } from "node:test";
${HELPER}
describe("a suite with a short timeout", { timeout: 20 }, () => {
  regressionCase("a cancelled case", { pr: 7, atBase: /defect/ }, async () => {
    await delay(100);
    throw new Error("defect");
  });
});
`;
// a file that imports what only the fix has, so it does not load at the base
const IMPORTS = `import assert from "node:assert/strict";
import { Bridge, ForeignSessionError } from "../src/bridge.js";
${HELPER}
regressionCase("the error is the fix's class", { pr: 7, atBase: /.*/ }, () => {
  assert.throws(() => new Bridge().latest({}), ForeignSessionError);
});
`;

test(
  "each selected case runs alone at the base, judged by its own record, and only it",
  { timeout: 120_000 },
  () => {
    const { root, base, run } = repository({
      "tests/verdicts.test.ts": VERDICTS,
      "tests/imports.test.ts": IMPORTS,
      "tests/player.test.ts": PLAYER,
      "tests/cancel.test.ts": CANCELLED,
    });
    try {
      const result = run("--base", base, "--pr", "7");
      assert.equal(result.status, 1, result.stdout + result.stderr);
      const lines = result.stderr.trim().split("\n");
      const loadError = lines.findIndex((line) =>
        line.startsWith(
          "tests/imports.test.ts:5: 'the error is the fix's class' (#7) did not run at the base: ",
        ),
      );
      assert.notEqual(loadError, -1, result.stderr);
      assert.match(lines[loadError], /ForeignSessionError/u);
      lines.splice(loadError, 1);
      assert.deepEqual(
        lines.sort(),
        [
          "tests/verdicts.test.ts:13: 'captureKeep refuses a foreign session' (#7) failed at the base for another reason than `atBase` names; its error's first line: Expected values to be strictly deep-equal:",
          "tests/verdicts.test.ts:17: 'an own op passes' (#7) passed at the base, so it does not witness the defect",
          "tests/verdicts.test.ts:33: 'a CR message' (#7) failed at the base for another reason than `atBase` names; its error's first line: unrelated",
          "tests/verdicts.test.ts:40: 'after a failing hook' (#7) did not run at the base: it did not start: a hook failed before it",
          "tests/verdicts.test.ts:43: 'looped pass' (#7) passed at the base, so it does not witness the defect",
          "tests/cancel.test.ts:6: 'a cancelled case' (#7) started at the base and did not end",
        ].sort(),
      );
      assert.match(
        result.stdout,
        new RegExp(
          `^regression-cases: 4 of 11 cases of #7 fail at ${base.slice(0, 12)} as they declare; historical cases of #3 not run\\n$`,
          "u",
        ),
      );
      assert.equal(existsSync(join(root, "historical-ran")), false);
      // the base worktree and the scratch folder are gone
      assert.equal(
        execFileSync("git", ["worktree", "list"], { cwd: root, encoding: "utf8" })
          .trim()
          .split("\n").length,
        1,
      );
      assert.deepEqual(
        readdirSync(join(root, "tmp")).filter((name) => name.startsWith("regression-cases-")),
        [],
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);

test(
  "a dead owner's scratch is swept even when nothing is declared, and source maps stop the run",
  { timeout: 120_000 },
  () => {
    const { root, base, env, run } = repository({
      "tests/plain.test.ts": 'import { test } from "node:test";\ntest("plain", () => {});\n',
    });
    try {
      const dead = spawnSync(process.execPath, ["-e", ""]).pid;
      const left = join(root, "tmp", `regression-cases-${dead}-01234567`);
      mkdirSync(left);
      const nothing = run("--base", base, "--pr", "7");
      assert.equal(
        nothing.stdout,
        "regression-cases: no changed test file declares a regression case\n",
      );
      assert.equal(existsSync(left), false);
      write(root, {
        "tests/declared.test.ts": `${HELPER}regressionCase("x", { pr: 7, atBase: /defect/ }, () => {});\n`,
      });
      execFileSync("git", ["add", "-A"], { cwd: root });
      execFileSync("git", ["commit", "-q", "-m", "declared"], { cwd: root });
      const mapped = spawnSync(
        process.execPath,
        ["--enable-source-maps", tool, "--base", base, "--pr", "7"],
        { cwd: root, encoding: "utf8", env },
      );
      assert.equal(mapped.status, 2, mapped.stdout + mapped.stderr);
      assert.match(mapped.stderr, /source maps are on/u);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);

test("a pull request whose cases all witness passes", { timeout: 120_000 }, () => {
  const { root, base, run } = repository({
    "tests/witness.test.ts": `import assert from "node:assert/strict";
import { Bridge } from "../src/bridge.js";
${HELPER}
for (const op of ["observeTime", "captureKeep"])
  regressionCase(\`\${op} refuses a foreign session\`, { pr: 7, atBase: /Missing expected exception \\(ForeignSessionError\\)\\.|Expected values to be strictly deep-equal:/ }, () => {
    assert.throws(() => new Bridge().latest({}), { name: "ForeignSessionError" });
  });
`,
  });
  try {
    const result = run("--base", base, "--pr", "7");
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.equal(result.stderr, "");
    assert.equal(
      result.stdout,
      `regression-cases: 2 of 2 cases of #7 fail at ${base.slice(0, 12)} as they declare\n`,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test(
  "interrupted, the tool stops by the signal; the next run removes a dead owner's scratch and leaves a live one's",
  { timeout: 120_000 },
  async () => {
    const { root, base, env, run } = repository({
      "tests/slow.test.ts": `import { setTimeout } from "node:timers/promises";
${HELPER}
regressionCase("a slow case", { pr: 7, atBase: /defect/ }, async () => {
  await setTimeout(5000);
});
`,
    });
    try {
      const child = spawn(process.execPath, [tool, "--base", base, "--pr", "7"], {
        cwd: root,
        env,
        stdio: "ignore",
      });
      const ended = new Promise((resolve) =>
        child.on("close", (status, signal) => resolve({ status, signal })),
      );
      const scratchOf = () =>
        readdirSync(join(root, "tmp")).filter((name) =>
          /^regression-cases-\d+-[0-9a-f]{8}$/u.test(name),
        );
      // until the base run has started the case
      const deadline = Date.now() + 90_000;
      const started = () =>
        scratchOf().some((name) => {
          const records = join(root, "tmp", name, "base.jsonl");
          return existsSync(records) && readFileSync(records, "utf8").includes('"started":true');
        });
      while (!started() && Date.now() < deadline)
        await new Promise((resolve) => globalThis.setTimeout(resolve, 50));
      assert.equal(started(), true, "the base case started");
      child.kill("SIGTERM");
      assert.deepEqual(await ended, { status: null, signal: "SIGTERM" });
      assert.deepEqual(
        scratchOf().map((name) => name.split("-")[2]),
        [String(child.pid)],
      );

      // a live owner's scratch: this test's own process
      const live = `regression-cases-${process.pid}-0123abcd`;
      mkdirSync(join(root, "tmp", live));
      const next = run("--base", base, "--pr", "7");
      assert.equal(next.status, 1, next.stdout + next.stderr);
      assert.deepEqual(scratchOf(), [live]);
      assert.equal(
        execFileSync("git", ["worktree", "list"], { cwd: root, encoding: "utf8" })
          .trim()
          .split("\n").length,
        1,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);
