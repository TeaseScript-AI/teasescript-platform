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
import { analyzeFeasibility } from "../src/report.ts";
import { loadRepositoryRunner, type HostFunction, type TeaseRunner } from "../src/runtime-check.ts";
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

function registerFixtures(directoryName: string, usesPendingCapabilities: boolean): void {
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
        assert.equal(emitTease(await convert(sourcePath)), expected);
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
          const shim = shimPendingCapabilities(await convert(sourcePath));
          assert.ok(shim.capabilities.size > 0, "fixture group expects pending capabilities");
          source = emitTease(shim.program);
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
          const shim = shimPendingCapabilities(await convert(sourcePath));
          source = emitTease(shim.program);
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

async function convert(sourcePath: string): Promise<MigrationProgram> {
  const [program] = lowerSelfContainedPackage([await parseGroovySource(sourcePath)]);
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
