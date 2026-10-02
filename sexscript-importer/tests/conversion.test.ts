// Source-to-target conversion examples: real Groovy 2.5.21 parsing, importer lowering, and the real
// TeaseScript compiler. Each `fixtures/conversion/NAME.groovy` has the expected idiomatic `NAME.tease`.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { loadRepositoryCompiler, type TeaseCompiler } from "../src/compile-check.ts";
import { emitTease } from "../src/emit-tease.ts";
import { lowerSelfContainedPackage } from "../src/package.ts";
import { parseGroovySource } from "../src/source-parser.ts";

const fixtureDirectory = fileURLToPath(new URL("./fixtures/conversion/", import.meta.url));
const fixtures = readdirSync(fixtureDirectory)
  .filter((name) => name.endsWith(".groovy"))
  .map((name) => name.slice(0, -".groovy".length))
  .sort();

const parserUnavailable = groovyParserUnavailableReason();
const compilerResult = await loadRepositoryCompiler().then(
  (compiler): { compiler: TeaseCompiler } | { reason: string } => ({ compiler }),
  (error: unknown) => ({ reason: error instanceof Error ? error.message : String(error) }),
);

for (const name of fixtures) {
  const sourcePath = path.join(fixtureDirectory, `${name}.groovy`);
  const expected = readFileSync(path.join(fixtureDirectory, `${name}.tease`), "utf8");

  test(
    `converts ${name}.groovy to the expected TeaseScript`,
    { skip: parserUnavailable },
    async () => {
      const parsed = await parseGroovySource(sourcePath);
      const [program] = lowerSelfContainedPackage([parsed]);
      assert.ok(program !== undefined);
      assert.equal(emitTease(program), expected);
    },
  );

  const compilerSkip = "reason" in compilerResult ? compilerResult.reason : false;
  test(
    `expected ${name}.tease compiles with the TeaseScript compiler`,
    { skip: compilerSkip },
    () => {
      if (!("compiler" in compilerResult)) return;
      const result = compilerResult.compiler(expected);
      assert.deepEqual(
        result.diagnostics.filter((diagnostic) => diagnostic.severity === "error"),
        [],
      );
      assert.equal(result.compiled, true);
    },
  );
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
