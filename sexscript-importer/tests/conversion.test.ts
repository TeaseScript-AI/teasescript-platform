// Source-to-target conversion examples: real Groovy 2.5.21 parsing, importer lowering, and the real
// TeaseScript compiler. Each `fixtures/<group>/NAME.groovy` has the expected idiomatic `NAME.tease`.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { loadRepositoryCompiler, type TeaseCompiler } from "../src/compile-check.ts";
import { emitTease } from "../src/emit-tease.ts";
import type { MigrationProgram } from "../src/ir.ts";
import { lowerSelfContainedPackage } from "../src/package.ts";
import { shimPendingCapabilities } from "../src/pending.ts";
import { parseGroovySource } from "../src/source-parser.ts";

const parserUnavailable = groovyParserUnavailableReason();
const compilerResult = await loadRepositoryCompiler().then(
  (compiler): { compiler: TeaseCompiler } | { reason: string } => ({ compiler }),
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
