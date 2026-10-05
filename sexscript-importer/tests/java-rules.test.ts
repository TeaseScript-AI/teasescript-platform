// Java and data API rules (src/java-data.ts): real Groovy 2.5.21 parsing, importer lowering, and the real TeaseScript
// compiler and runtime, on small text-only fixtures written per test.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { loadRepositoryProjectCompiler } from "../src/compile-check.ts";
import { emitTease } from "../src/emit-tease.ts";
import { lowerSelfContainedPackage } from "../src/package.ts";
import { loadRepositoryProjectRunner } from "../src/runtime-check.ts";
import { parseGroovySource } from "../src/source-parser.ts";

const parserUnavailable = groovyParserUnavailableReason();
const project = await Promise.all([
  loadRepositoryProjectCompiler(),
  loadRepositoryProjectRunner(),
]).then(
  ([compiler, runner]) => ({ compiler, runner }),
  (error: unknown) => ({ reason: error instanceof Error ? error.message : String(error) }),
);
const skip = parserUnavailable || ("reason" in project ? project.reason : false);

/** Converts Groovy lines as a lone script whose legacy data folder holds `files`, by name and text. */
async function convert(lines: string[], files: Record<string, string> = {}): Promise<string> {
  const directory = mkdtempSync(path.join(tmpdir(), "sexscript-java-"));
  try {
    const sourcePath = path.join(directory, "script.groovy");
    writeFileSync(sourcePath, `${lines.join("\n")}\n`);
    const [program] = lowerSelfContainedPackage([await parseGroovySource(sourcePath)], {
      files: Object.keys(files),
      readFile: (name) => (name in files ? new TextEncoder().encode(files[name]) : null),
    });
    return emitTease(program!);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

/**
 * Compiles the converted script and runs it to the end, returning the values it said: each `say` becomes a call of a
 * recording host function, which shows text as itself and other values as JSON.
 */
function run(source: string): string[] {
  if (!("compiler" in project)) return [];
  const recording = source.replaceAll(/^( *)say (.+)$/gmu, "$1record($2)");
  const files = [{ path: "main.tease", source: recording }];
  const compiled = project.compiler(files, ["record"]);
  assert.deepEqual(
    compiled.diagnostics.filter((diagnostic) => diagnostic.severity === "error"),
    [],
  );
  const said: string[] = [];
  const result = project.runner(files, {
    record: ([value]) => {
      said.push(typeof value === "string" ? value : JSON.stringify(value));
      return null;
    },
  });
  assert.deepEqual(
    { status: result.status, failure: result.failure },
    { status: "halted", failure: null },
  );
  return said;
}

// Package files that no script writes are part of the package as converted: a File, stream, or reader becomes the path
// text of its file, and reading it calls a generated function holding the file's lines, Properties entries, or INI
// values. readLines() splits at LF, CR, and CRLF without an empty last line; Properties keep their escapes and
// continuations; a literal INI lookup reads its value at conversion time.
test("reads package text files that no script writes as converted", { skip }, async () => {
  const source = await convert(
    [
      "def readtext",
      'readtext = new File("scripts/Quiz/world_q.txt")',
      "def questions = readtext.readLines()",
      'readtext = new File("scripts/Quiz/world_a.txt")',
      "def answers = readtext.readLines()",
      'show("${questions.size()} ${questions[1]} ${answers.size()} ${answers[2]}.")',
      'String lang = "en"',
      'File p = new File(getDataFolder() + "/data/strings_" + lang + ".properties")',
      'if (!p.exists()) p = new File(getDataFolder() + "/data/strings_de.properties")',
      'InputStreamReader reader = new InputStreamReader(new FileInputStream(p), "UTF-8")',
      "Properties props = new Properties()",
      "props.load(reader)",
      "reader.close()",
      'show(props.get("greeting"))',
      'show(props.getProperty("key with space", "none") + " " + props.get("missing"))',
      'def settings = new org.ini4j.Wini(new File("scripts/system/settings.ini"))',
      'def option = "Favourite02"',
      'show(settings.get("Favourites", "Favourite01") + "/" + settings.get("Favourites", option) + "/")',
    ],
    {
      "Quiz/world_q.txt": "Capital of France?\r\nLargest ocean?\r\n",
      "Quiz/world_a.txt": "Paris\nPacific\n\n",
      "data/strings_en.properties":
        "# comment\ngreeting = Hello \\\n    world\nkey\\ with\\ space: value\\u0021\n",
      "data/strings_de.properties": "greeting=Hallo\n",
      "system/settings.ini": "[Favourites]\nFavourite01 = Domme\nFavourite02=\n",
    },
  );
  assert.match(source, /^readtext = "scripts\/Quiz\/world_q\.txt"$/mu);
  assert.match(source, /^let questions = sexscriptLegacyTextLines\(readtext\)$/mu);
  assert.match(source, /^ {2}return \["Capital of France\?", "Largest ocean\?"\]$/mu);
  assert.match(source, /^let props: string\? dict = dict\{\}$/mu);
  assert.match(source, /^props = sexscriptLegacyProperties\(reader\)$/mu);
  assert.match(source, /NOTE SX_PACKAGE_TEXT_SNAPSHOT/u);
  assert.doesNotMatch(source, /TODO|reader\.close/u);
  assert.deepEqual(run(source), ["2 Largest ocean? 3 .", "Hello world", "value! null", "Domme//"]);
});

// A file that some script of the package writes is no fixed text: its reads stay manual work, which names the write.
test("keeps reads of a package file that a script writes as manual work", { skip }, async () => {
  const source = await convert(
    [
      'new File("scripts/log.txt").append("visit")',
      'def log = new File("scripts/log.txt")',
      "def visits = log.readLines()",
      'def tasks = new File("scripts/tasks.txt").readLines()',
      "def saved = tasks",
      'def target = new File("scripts/" + saved[0])',
      "def markDone = { file -> file.delete() }",
      "markDone(target)",
    ],
    { "log.txt": "visit\n", "tasks.txt": "tasks.txt\n" },
  );
  assert.match(
    source,
    /TODO SX_PACKAGE_TEXT_WRITTEN line 3: The package's scripts may write log\.txt \(script\.groovy:1\)/u,
  );
  // The File handed to markDone() may be any file below scripts/, which a write of unknown origin deletes.
  assert.match(
    source,
    /TODO SX_PACKAGE_TEXT_WRITTEN line 4: The package's scripts may write tasks\.txt \(script\.groovy:8\)/u,
  );
});

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
