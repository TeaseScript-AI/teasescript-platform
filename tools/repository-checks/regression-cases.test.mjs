import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { verdict } from "./regression-cases.mjs";
import { regressionCase } from "../../tests/helpers/regression-case.ts";

const repositoryRoot = fileURLToPath(new URL("../../", import.meta.url));
const tool = fileURLToPath(new URL("./regression-cases.mjs", import.meta.url));

// The generated family of `verdict`: each outcome a case can have at the base, against an `atBase` that matches the
// failure's first line whole, matches only part of it, or does not match.
const OUTCOMES = {
  passed: { passed: true },
  "failed in its code": { passed: false, failureType: "testCodeFailure" },
  cancelled: { passed: false, failureType: "cancelledByParent" },
  "timed out": { passed: false, failureType: "testTimeoutFailure" },
  "a hook failed": { passed: false, failureType: "hookFailure" },
  "no event": undefined,
};
const LINE = "Missing expected rejection (ForeignSessionError).";
const PATTERNS = {
  "matches the whole line": /Missing expected rejection \(ForeignSessionError\)\./,
  "matches part of the line": /ForeignSessionError/,
  "does not match": /Missing expected exception\./,
};
const EXPECTED = {
  passed: () => "passed",
  "failed in its code": (pattern) =>
    pattern === "matches the whole line" ? "witness" : "other failure",
  cancelled: () => "did not finish",
  "timed out": () => "did not finish",
  "a hook failed": () => "did not finish",
  "no event": () => "did not run",
};

test("a case is a witness only when it failed in its code with the whole first line `atBase` names", () => {
  const cases = Object.keys(OUTCOMES).flatMap((outcome) =>
    Object.keys(PATTERNS).map((pattern) => ({ outcome, pattern })),
  );
  const outcomes = new Map();
  const declared = cases.map(({ outcome, pattern }) => {
    const name = `${outcome}, ${pattern}`;
    if (OUTCOMES[outcome] !== undefined)
      outcomes.set(`dist/tests/x.test.js\n${name}`, { ...OUTCOMES[outcome], line: LINE });
    return {
      file: "dist/tests/x.test.js",
      name,
      pr: 7,
      atBase: { source: PATTERNS[pattern].source, flags: PATTERNS[pattern].flags },
    };
  });
  const judged = verdict(
    declared,
    outcomes,
    new Map([["dist/tests/x.test.js", "SyntaxError: no export"]]),
  );
  for (const [index, { outcome, pattern }] of cases.entries())
    assert.equal(judged[index].verdict, EXPECTED[outcome](pattern), `${outcome}, ${pattern}`);
  // a case with no event names its file's load error
  assert.equal(
    judged.find(({ verdict: each }) => each === "did not run").detail,
    "SyntaxError: no export",
  );
  // the coverage: every outcome with every pattern, once
  assert.equal(
    new Set(cases.map(({ outcome, pattern }) => `${outcome}, ${pattern}`)).size,
    Object.keys(OUTCOMES).length * Object.keys(PATTERNS).length,
  );
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
const CASES = `import assert from "node:assert/strict";
import { Bridge } from "../src/bridge.js";
import { regressionCase } from "./helpers/regression-case.js";

const foreign = {};
const at = /Missing expected exception \\(ForeignSessionError\\)\\./;
regressionCase("latest refuses a foreign session", { pr: 7, atBase: at }, () => {
  assert.throws(() => new Bridge().latest(foreign), { name: "ForeignSessionError" });
});
// the base refuses this op for another reason: R3's \`request\` case
regressionCase("captureKeep refuses a foreign session", { pr: 7, atBase: at }, () => {
  assert.throws(() => new Bridge().request(foreign, "captureKeep"), { name: "ForeignSessionError" });
});
regressionCase("an own op passes", { pr: 7, atBase: at }, () => {
  const bridge = new Bridge();
  bridge.sessions.add(foreign);
  assert.equal(bridge.request(foreign, "observeTime"), "observeTime");
});
regressionCase("an older fix's case", { pr: 3, atBase: at }, () => {});
regressionCase("a case of no merged pull request", { pr: 99, atBase: at }, () => {});
`;
// a file that imports what only the fix has, so it does not load at the base
const IMPORTS = `import assert from "node:assert/strict";
import { Bridge, ForeignSessionError } from "../src/bridge.js";
import { regressionCase } from "./helpers/regression-case.js";

regressionCase("the error is the fix's class", { pr: 7, atBase: /.*/ }, () => {
  assert.throws(() => new Bridge().latest({}), ForeignSessionError);
});
`;

test(
  "the declared cases of a pull request run against its base, and each must fail there as it declares",
  { timeout: 120_000 },
  () => {
    const root = mkdtempSync(join(tmpdir(), "regression-cases-"));
    const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
    try {
      git("init", "-q");
      git("config", "user.email", "t@t");
      git("config", "user.name", "t");
      write(root, {
        ".gitignore": "node_modules\ndist/\n",
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
            types: ["node"],
          },
          include: ["src/**/*.ts", "tests/**/*.ts"],
        }),
        "src/bridge.ts": BRIDGE_BASE,
        "tests/helpers/regression-case.ts": readFileSync(
          join(repositoryRoot, "tests/helpers/regression-case.ts"),
          "utf8",
        ),
      });
      symlinkSync(join(repositoryRoot, "node_modules"), join(root, "node_modules"));
      git("add", "-A");
      git("commit", "-q", "-m", "Keep a session store (#3)");
      const base = git("rev-parse", "HEAD");
      write(root, {
        "src/bridge.ts": BRIDGE_HEAD,
        "tests/bridge.test.ts": CASES,
        "tests/imports.test.ts": IMPORTS,
      });
      git("add", "-A");
      git("commit", "-q", "-m", "Refuse a session of another bridge");
      // the head's build, as CI's test job leaves it
      spawnSync(
        process.execPath,
        [join(root, "node_modules/@typescript/native/bin/tsc"), "-p", "tsconfig.json"],
        { cwd: root },
      );
      const { NODE_TEST_CONTEXT: _context, ...withoutTestContext } = process.env;
      const result = spawnSync(process.execPath, [tool, "--base", base, "--pr", "7"], {
        cwd: root,
        encoding: "utf8",
        // started as CI starts it, not as a test: `node:test` refuses a run inside one
        env: { ...withoutTestContext, REGRESSION_CASES: "" },
      });
      assert.equal(result.status, 1, result.stdout + result.stderr);
      const lines = result.stderr.trim().split("\n").sort();
      assert.deepEqual(lines, [
        "tests/bridge.test.ts: 'a case of no merged pull request' names #99, which is neither this pull request (#7) nor one merged into the base: name the pull request whose fix it witnesses",
        "tests/bridge.test.ts: 'an own op passes' (#7) passed at the base, so it does not witness the defect",
        "tests/bridge.test.ts: 'captureKeep refuses a foreign session' (#7) failed at the base for another reason than `atBase` names; its error's first line: Expected values to be strictly deep-equal:",
        lines.find((line) =>
          line.startsWith(
            "tests/imports.test.ts: 'the error is the fix's class' (#7) did not run at the base: ",
          ),
        ),
      ]);
      assert.match(lines[3], /ForeignSessionError/u);
      assert.match(
        result.stdout,
        new RegExp(
          `^regression-cases: 1 of 4 cases of #7 fail at ${base.slice(0, 12)} as they declare; historical cases of #3 skipped\\n$`,
          "u",
        ),
      );
      // the base worktree is gone
      assert.equal(git("worktree", "list").split("\n").length, 1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);
