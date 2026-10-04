// Source-to-target conversion examples: real Groovy 2.5.21 parsing, importer lowering, and the real
// TeaseScript compiler. Each `fixtures/<group>/NAME.groovy` has the expected idiomatic `NAME.tease`.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { loadRepositoryCompiler, type TeaseCompiler } from "../src/compile-check.ts";
import { emitTease } from "../src/emit-tease.ts";
import type { MigrationProgram } from "../src/ir.ts";
import { lowerSelfContainedPackage } from "../src/package.ts";
import { pendingHostFunctions, shimPendingCapabilities } from "../src/pending.ts";
import type { ProposalId } from "../src/proposals.ts";
import { analyzeFeasibility } from "../src/report.ts";
import {
  flowKey,
  loadRepositoryRunner,
  type HostFunction,
  type TeaseRunner,
} from "../src/runtime-check.ts";
import { parseGroovySource } from "../src/source-parser.ts";

const parserUnavailable = groovyParserUnavailableReason();
const compilerResult = await loadRepositoryCompiler().then(
  (compiler): { compiler: TeaseCompiler } | { reason: string } => ({ compiler }),
  (error: unknown) => ({ reason: error instanceof Error ? error.message : String(error) }),
);
const runnerResult = await loadRepositoryRunner().then(
  (runner): { runner: TeaseRunner } | { reason: string } => ({ runner }),
  (error: unknown) => ({ reason: error instanceof Error ? error.message : String(error) }),
);

// Output that uses only implemented TeaseScript must compile as generated.
registerFixtures("conversion", false);
// Output that deliberately targets accepted TeaseScript the current compiler does not implement yet
// (storage, script chaining, popups, boolean/integer input, ...) must compile once those capabilities are
// replaced by placeholder calls, so everything except the pending capabilities is compiler-checked.
registerFixtures("conversion-accepted", true);

function registerFixtures(
  directoryName: string,
  usesPendingCapabilities: boolean,
  proposals: ReadonlySet<ProposalId> = new Set(),
): void {
  const directory = fileURLToPath(new URL(`./fixtures/${directoryName}/`, import.meta.url));
  const names = readdirSync(directory)
    .filter((name) => name.endsWith(".groovy"))
    .map((name) => name.slice(0, -".groovy".length))
    .sort();
  for (const name of names) {
    const sourcePath = path.join(directory, `${name}.groovy`);
    const expected = readFileSync(path.join(directory, `${name}.tease`), "utf8");

    test(
      `converts ${directoryName}/${name}.groovy to the expected TeaseScript`,
      { skip: parserUnavailable },
      async () => {
        assert.equal(emitTease(await convert(sourcePath, proposals)), expected);
      },
    );

    const compilerSkip = "reason" in compilerResult ? compilerResult.reason : false;
    test(
      usesPendingCapabilities
        ? `${directoryName}/${name} output compiles apart from pending TeaseScript capabilities`
        : `expected ${directoryName}/${name}.tease compiles with the TeaseScript compiler`,
      { skip: compilerSkip || (usesPendingCapabilities && parserUnavailable) },
      async () => {
        if (!("compiler" in compilerResult)) return;
        let source = expected;
        let builtins: string[] = [];
        if (usesPendingCapabilities) {
          const shim = shimPendingCapabilities(await convert(sourcePath, proposals));
          assert.ok(shim.capabilities.size > 0, "fixture group expects pending capabilities");
          source = shim.source;
          builtins = shim.builtins;
        }
        const result = compilerResult.compiler(source, builtins);
        assert.deepEqual(
          result.diagnostics.filter((diagnostic) => diagnostic.severity === "error"),
          [],
        );
        assert.equal(result.compiled, true);
      },
    );

    // One deterministic path through the output runs in the real runtime; pending capabilities use small host
    // stand-ins.
    const runnerSkip = "reason" in runnerResult ? runnerResult.reason : false;
    test(
      `${directoryName}/${name} output runs to the end in the TeaseScript runtime`,
      { skip: runnerSkip || (usesPendingCapabilities && parserUnavailable) },
      async () => {
        if (!("runner" in runnerResult)) return;
        let source = expected;
        let builtins: Record<string, HostFunction> = {};
        if (usesPendingCapabilities) {
          const shim = shimPendingCapabilities(await convert(sourcePath, proposals));
          source = shim.source;
          builtins = pendingHostFunctions(shim);
        }
        const result = runnerResult.runner(source, builtins);
        assert.deepEqual(
          { status: result.status, failure: result.failure },
          { status: "halted", failure: null },
        );
      },
    );
  }
}

// The smoke-run stand-ins behave like the accepted capabilities they replace, so a run does not pass where the real
// implementation would fail: a dict never equals an object and takes only text keys, the empty text included (#536),
// a button timeout must be positive (#531), and toDate() takes the date of a datetime (#532).
test(
  "pending stand-ins keep the accepted dict, button timeout, and toDate behavior",
  { skip: "reason" in runnerResult ? runnerResult.reason : false },
  () => {
    if (!("runner" in runnerResult)) return;
    const operations = new Map([
      ["sxLiteral", "dict.literal"],
      ["sxGet", "dict.get"],
      ["sxButton", "showButton"],
      ["sxToDate", "toDate"],
      ["sxNow", "getDateTime"],
    ]);
    const builtins = pendingHostFunctions({
      program: { sourceName: "stand-ins.tease", metadata: null, statements: [], diagnostics: [] },
      source: "",
      builtins: [...operations.keys()],
      operations,
      capabilities: new Set(),
    });
    const run = (source: string) => runnerResult.runner(source, builtins).status;
    // `[1][5]` fails, so the run halts only when no check fails.
    assert.equal(
      run(
        [
          'let entries = sxLiteral([["a", 1], ["b", 2]])',
          "if entries == { a: 1, b: 2 } {",
          "  let unreachable = [1][5]",
          "}",
          'if entries != sxLiteral([["b", 2], ["a", 1]]) {',
          "  let unreachable = [1][5]",
          "}",
          'if sxGet(sxLiteral([["", 3]]), "") != 3 {',
          "  let unreachable = [1][5]",
          "}",
          "if sxToDate(sxNow()).day != sxNow().day {",
          "  let unreachable = [1][5]",
          "}",
          "",
        ].join("\n"),
      ),
      "halted",
    );
    assert.equal(run('let value = sxGet(sxLiteral([["1", 3]]), 1)\n'), "failed");
    assert.equal(run('let elapsed = sxButton("Go", 0)\n'), "failed");
  },
);

// Lone CR line endings cannot live in a committed fixture without tripping whitespace checks.
test(
  "keeps lone-CR legacy line endings aligned with comments",
  { skip: parserUnavailable },
  async () => {
    const directory = mkdtempSync(path.join(tmpdir(), "sexscript-cr-"));
    try {
      const sourcePath = path.join(directory, "carriage-return-lines.groovy");
      writeFileSync(sourcePath, '// header\rwait(2)\rshow("done") // trailing\r');
      assert.equal(
        emitTease(await convert(sourcePath)),
        '// header\nwait 2\nsay "done" // trailing\n',
      );
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  },
);

// TeaseScript variables keep one type (#519); Groovy variables that held text and a list need manual work.
test(
  "reports a variable that holds values of two types instead of emitting code that does not compile",
  { skip: parserUnavailable || ("reason" in compilerResult ? compilerResult.reason : false) },
  async () => {
    if (!("compiler" in compilerResult)) return;
    const directory = mkdtempSync(path.join(tmpdir(), "sexscript-types-"));
    try {
      const sourcePath = path.join(directory, "type-change.groovy");
      writeFileSync(
        sourcePath,
        'def lines = "One"\nif (getBoolean("Long?")) lines = ["One", "Two"]\nshow("Done")\nshow("${lines.size()}")\n',
      );
      const program = await convert(sourcePath);
      assert.deepEqual(
        program.diagnostics
          .filter((diagnostic) => diagnostic.severity === "error")
          .map(({ code, span }) => ({ code, line: span?.line })),
        [{ code: "SX_TYPE_CHANGE", line: 1 }],
      );
      const output = emitTease(program);
      assert.match(
        output,
        /^\/\/ TODO SX_TYPE_CHANGE line 1: 'lines' starts as text \(string\), but is later set to a list \(string\[\]\) \(line 2\)\./mu,
      );
      assert.match(output, /^\/\/ \| def lines = "One"$/mu);
      // The rest of the script is still converted.
      assert.match(output, /^ {2}lines = \["One", "Two"\]$/mu);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  },
);

// A variable that starts as null, or holds a function result, keeps the first type it gets (#504 decision 1a).
test(
  "reports type changes of variables that start as null or hold a function result",
  { skip: parserUnavailable },
  async () => {
    const directory = mkdtempSync(path.join(tmpdir(), "sexscript-inferred-"));
    try {
      const sourcePath = path.join(directory, "inferred.groovy");
      writeFileSync(
        sourcePath,
        [
          "def value = null",
          'value = "text"',
          "value = [1, 2]",
          'def label = { -> return "x" }',
          "def text = label()",
          'if (getBoolean("More?")) text = [1]',
          "show(text)",
          "",
        ].join("\n"),
      );
      const program = await convert(sourcePath);
      assert.deepEqual(
        program.diagnostics
          .filter((diagnostic) => diagnostic.severity === "error")
          .map(({ code, span }) => ({ code, line: span?.line })),
        [
          { code: "SX_TYPE_CHANGE", line: 1 },
          { code: "SX_TYPE_CHANGE", line: 5 },
        ],
      );
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  },
);

// A dict has one value type, also for property writes and list elements, only a map held in a variable converts to
// one, and a dict never equals an object (#536).
test(
  "reports dicts with mixed values, runtime keys on maps not held in a variable, and dict-object comparisons",
  { skip: parserUnavailable },
  async () => {
    const directory = mkdtempSync(path.join(tmpdir(), "sexscript-dict-"));
    try {
      const sourcePath = path.join(directory, "dict.groovy");
      writeFileSync(
        sourcePath,
        [
          "def params = [:]",
          'def key = "level"',
          "params[key] = 3",
          'params["name"] = "Ada"',
          "def holder = [inner: 1]",
          "holder.inner[key] = 1",
          "def scores = [:]",
          "scores[key] = 1",
          'scores.bonus = "text"',
          'def lists = [a: [1], b: ["two"]]',
          'show("${lists[key]}")',
          "def made = { -> return [level: 3] }",
          "def counts = [:]",
          "counts[key] = 1",
          'if (counts == made()) show("Same")',
          "",
        ].join("\n"),
      );
      const program = await convert(sourcePath);
      assert.deepEqual(
        program.diagnostics
          .filter((diagnostic) => diagnostic.severity === "error")
          .map(({ code, span }) => ({ code, line: span?.line })),
        [
          { code: "SX_DICT_VALUE_TYPE", line: 1 },
          { code: "SX_UNSUPPORTED_DECLARATION_VALUE", line: 1 },
          { code: "SX_DYNAMIC_MAP_ACCESS", line: 6 },
          { code: "SX_UNSUPPORTED_ASSIGNMENT_TARGET", line: 6 },
          // A property write stores text in a dict of numbers.
          { code: "SX_DICT_VALUE_TYPE", line: 7 },
          { code: "SX_UNSUPPORTED_DECLARATION_VALUE", line: 7 },
          // Lists of numbers and lists of text are values of two types.
          { code: "SX_DICT_VALUE_TYPE", line: 10 },
          { code: "SX_UNSUPPORTED_DECLARATION_VALUE", line: 10 },
          { code: "SX_COLLECTION_TEXT", line: 11 },
          { code: "SX_UNSUPPORTED_ARGUMENT", line: 11 },
          { code: "SX_DICT_EQUALITY", line: 15 },
          { code: "SX_UNSUPPORTED_IF", line: 15 },
        ],
      );
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  },
);

// Appends, list literals, list cases, and text defaults whose Groovy meaning depends on a type.
test(
  "converts list appends, list cases, and text defaults only as far as their types are proven",
  { skip: parserUnavailable },
  async () => {
    const directory = mkdtempSync(path.join(tmpdir(), "sexscript-proven-"));
    try {
      const sourcePath = path.join(directory, "proven.groovy");
      writeFileSync(
        sourcePath,
        [
          'def extra = { -> return ["b"] }',
          "def build = { more ->",
          '  def items = ["a"]',
          "  items += 1..3",
          "  items += more",
          "  items += extra()",
          "  return items",
          "}",
          "def other = { -> def items = extra(); return items }",
          'def weights = [1, 2]; weights = [3, "four"]',
          "switch (getRandom(9)) { case [1..3, 5]: show('hit'); break; case 7: show('seven') }",
          'def code = getString("Code?", 42)',
          'def answer = getString("Settings?", [level: 2])',
          'showButton("Too late", -1)',
          'show([[1, 2], [3, 4]].join("|"))',
          'def xs = ["a"]',
          "def ys = xs",
          "xs.add([1, 2])",
          'show(ys.join(", "))',
          'def digit = "3"',
          "int code = digit",
          "",
        ].join("\n"),
      );
      const program = await convert(sourcePath);
      const output = emitTease(program);
      // A range is a list in Groovy, so its elements are appended.
      assert.match(output, /^ {2}items = sexscriptLegacyConcat\(\[items, 1\.\.=3\]\)$/mu);
      // A value that may be a list or one element is reported; a function result is a list.
      assert.match(output, /^ {2}\/\/ TODO SX_LIST_CONCATENATION line 5: /mu);
      assert.match(output, /^ {2}items = sexscriptLegacyConcat\(\[items, extra\(\)\]\)$/mu);
      // A list literal is checked element by element, as the compiler does.
      assert.match(output, /^\/\/ TODO SX_TYPE_CHANGE line 10: 'weights' holds integer values/mu);
      // A list case holding a range keeps Groovy's membership test.
      assert.match(output, /\[1\.\.=3, 5\]\.contains\(/u);
      // Legacy showed a number default as text; a map default has no text form.
      assert.match(output, /^let code = askText default: "42"$/mu);
      assert.match(output, /^\/\/ TODO SX_INPUT_PREFILL_VALUE line 13: /mu);
      // A negative button timeout failed in legacy and is rejected by TeaseScript.
      assert.match(output, /^\/\/ TODO SX_BUTTON_TIMEOUT line 14: /mu);
      // join() of nested lists printed them in Groovy and fails in TeaseScript, also through an alias.
      assert.match(output, /^\/\/ TODO SX_LIST_JOIN line 15: /mu);
      assert.match(output, /^\/\/ TODO SX_LIST_JOIN line 19: /mu);
      // Groovy stored a one-character text in an int as its character code.
      assert.match(output, /^\/\/ TODO SX_INTEGER_FROM_TEXT line 21: /mu);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  },
);

test(
  "package smoke run follows script transfers with shared storage",
  {
    skip:
      parserUnavailable ||
      ("reason" in compilerResult ? compilerResult.reason : false) ||
      ("reason" in runnerResult ? runnerResult.reason : false),
  },
  async () => {
    if (!("compiler" in compilerResult) || !("runner" in runnerResult)) return;
    const directory = mkdtempSync(path.join(tmpdir(), "sexscript-flow-"));
    try {
      mkdirSync(path.join(directory, "pack"));
      const main = path.join(directory, "main.groovy");
      const next = path.join(directory, "pack", "next.groovy");
      const unreached = path.join(directory, "pack", "unreached.groovy");
      writeFileSync(main, 'save("level", 3)\nreturn "pack/next.groovy"\n');
      // Without the entry's saved level, the comparison would fail at runtime.
      writeFileSync(next, 'if (loadInteger("level") > 2) show("High level")\n');
      writeFileSync(unreached, 'show("Only isolated")\n');
      const files = await Promise.all(
        [main, next, unreached].map((file) => parseGroovySource(file)),
      );
      const report = analyzeFeasibility(files, {
        compiler: compilerResult.compiler,
        runner: runnerResult.runner,
      });
      assert.deepEqual(
        report.smokeRuns.map(({ entry, isolated, status, visited, transfers }) => ({
          entry,
          isolated,
          status,
          visited,
          transfers,
        })),
        [
          {
            entry: "main.tease",
            isolated: false,
            status: "halted",
            visited: ["main.tease", "pack/next.tease"],
            transfers: 1,
          },
          {
            entry: "pack/unreached.tease",
            isolated: true,
            status: "halted",
            visited: ["pack/unreached.tease"],
            transfers: 0,
          },
        ],
      );
      assert.equal(report.smokeRunReachedScriptFileCount, 3);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  },
);

test(
  "package smoke run uses the package root for entries and counts only scripts as reached",
  {
    skip:
      parserUnavailable ||
      ("reason" in compilerResult ? compilerResult.reason : false) ||
      ("reason" in runnerResult ? runnerResult.reason : false),
  },
  async () => {
    if (!("compiler" in compilerResult) || !("runner" in runnerResult)) return;
    const directory = mkdtempSync(path.join(tmpdir(), "sexscript-root-"));
    try {
      mkdirSync(path.join(directory, "sub"));
      const sources: Record<string, string> = {
        "Helper.groovy": "class Helper {\n  static int twice(int x) { return x * 2 }\n}\n",
        "helper.groovy": 'show("Helper script")\n',
        "sub/start.groovy": 'return "sub/next.groovy"\n',
        "sub/next.groovy": 'show("Next")\n',
      };
      for (const [name, source] of Object.entries(sources)) {
        writeFileSync(path.join(directory, name), source);
      }
      const files = await Promise.all(
        Object.keys(sources).map((name) => parseGroovySource(path.join(directory, name))),
      );
      const report = analyzeFeasibility(files, {
        compiler: compilerResult.compiler,
        runner: runnerResult.runner,
        packageRoot: directory,
      });
      assert.deepEqual(
        report.smokeRuns.map(({ entry, isolated, status, visited }) => ({
          entry,
          isolated,
          status,
          visited,
        })),
        [
          { entry: "helper.tease", isolated: false, status: "halted", visited: ["helper.tease"] },
          {
            entry: "sub/start.tease",
            isolated: true,
            status: "halted",
            visited: ["sub/start.tease", "sub/next.tease"],
          },
        ],
      );
      assert.equal(report.smokeRunReachedScriptFileCount, 3);
      const auxiliary = report.files.find((file) => file.sourceName.endsWith("Helper.groovy"));
      assert.equal(auxiliary?.smokeRunReached, false);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  },
);

test(
  "package smoke run blocks scripts whose paths differ only in case",
  {
    skip:
      parserUnavailable ||
      ("reason" in compilerResult ? compilerResult.reason : false) ||
      ("reason" in runnerResult ? runnerResult.reason : false),
  },
  async () => {
    if (!("compiler" in compilerResult) || !("runner" in runnerResult)) return;
    const directory = mkdtempSync(path.join(tmpdir(), "sexscript-case-"));
    try {
      writeFileSync(path.join(directory, "A.groovy"), 'show("Upper")\n');
      writeFileSync(path.join(directory, "a.groovy"), 'show("Lower")\n');
      const files = await Promise.all(
        ["A.groovy", "a.groovy"].map((name) => parseGroovySource(path.join(directory, name))),
      );
      const report = analyzeFeasibility(files, {
        compiler: compilerResult.compiler,
        runner: runnerResult.runner,
        packageRoot: directory,
      });
      assert.deepEqual(
        report.smokeRuns.map(({ entry, status }) => ({ entry, status })),
        [{ entry: "a.tease", status: "blocked" }],
      );
      assert.equal(report.smokeRunReachedScriptFileCount, 0);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  },
);

// The smoke runner drives the public runtime API like a Player with deterministic answers.
test(
  "smoke runner plays media in simulated time and reports the last step's outcome",
  { skip: "reason" in runnerResult ? runnerResult.reason : false },
  () => {
    if (!("runner" in runnerResult)) return;
    const run = (source: string, maxSteps?: number): { status: string; code: string | null } => {
      const result = runnerResult.runner(source, {}, maxSteps === undefined ? {} : { maxSteps });
      return { status: result.status, code: result.failure?.code ?? null };
    };
    const halted = { status: "halted", code: null };
    // Background media keeps playing while the script waits.
    assert.deepEqual(
      run(
        'let music = playAudio async "a.wav"\nwhile music.state == "running" {\n  wait 1\n}\nsay "done"\n',
      ),
      halted,
    );
    // A repeated pass count needs the cumulative progress of all passes.
    assert.deepEqual(
      run('playAudio(file: "a.wav", async: false, repeat: 3 times)\nsay "done"\n'),
      halted,
    );
    // A runtime failure caused by the last allowed step is still reported.
    assert.deepEqual(run('wait 1\nlet total = 1 + "bad"\n', 1), {
      status: "failed",
      code: "TSR027",
    });
    // Numbered inputs rotate, so a loop waiting for a larger answer ends.
    assert.deepEqual(run("let n: number = 0\nwhile n < 3 {\n  n = askNumber\n}\n"), halted);
  },
);

test("package flow keys normalize paths like the legacy file system", () => {
  assert.equal(flowKey("pack//next.tease"), "pack/next.tease");
  assert.equal(flowKey("./Pack/../Next.tease"), "next.tease");
  assert.equal(flowKey("pack\\sub\\Next.tease"), "pack/sub/next.tease");
});

// A package whose script loads `metaClass` mixin modules at runtime, like the Toy package.
test(
  "converts a package with runtime-loaded mixin modules into one runnable script",
  {
    skip:
      parserUnavailable ||
      ("reason" in compilerResult ? compilerResult.reason : false) ||
      ("reason" in runnerResult ? runnerResult.reason : false),
  },
  async () => {
    if (!("compiler" in compilerResult) || !("runner" in runnerResult)) return;
    const directory = fileURLToPath(new URL("./fixtures/packages/mixin-modules/", import.meta.url));
    const sources = [
      "demo.groovy",
      "demo/greeting.groovy",
      "demo/later.groovy",
      "demo/pause.groovy",
    ].map((name) => path.join(directory, "scripts", name));
    const files = await Promise.all(sources.map((source) => parseGroovySource(source)));
    const script = lowerSelfContainedPackage(files)[0];
    assert.ok(script !== undefined);
    const source = emitTease(script);
    assert.equal(source, readFileSync(path.join(directory, "demo.tease"), "utf8"));
    const compiled = compilerResult.compiler(source);
    assert.deepEqual(
      compiled.diagnostics.filter((diagnostic) => diagnostic.severity === "error"),
      [],
    );
    const run = runnerResult.runner(source, {});
    assert.deepEqual(
      { status: run.status, failure: run.failure },
      { status: "halted", failure: null },
    );
  },
);

async function convert(
  sourcePath: string,
  proposals: ReadonlySet<ProposalId> = new Set(),
): Promise<MigrationProgram> {
  const [program] = lowerSelfContainedPackage([await parseGroovySource(sourcePath)], { proposals });
  assert.ok(program !== undefined);
  return program;
}

function groovyParserUnavailableReason(): string | false {
  if (spawnSync("java", ["-version"], { stdio: "ignore" }).status !== 0) {
    return "Java is not available for the Groovy 2.5.21 parser helper.";
  }
  const maven = path.join(homedir(), ".m2/repository/org/codehaus/groovy");
  const jars = [
    process.env.SEXSCRIPT_GROOVY_JAR ?? path.join(maven, "groovy/2.5.21/groovy-2.5.21.jar"),
    process.env.SEXSCRIPT_GROOVY_JSON_JAR ??
      path.join(maven, "groovy-json/2.5.21/groovy-json-2.5.21.jar"),
  ];
  const missing = jars.find((jar) => !existsSync(jar));
  return missing === undefined ? false : `Groovy 2.5.21 JAR not found: ${missing}`;
}
