/**
 * Records what Groovy 2.5.21 prints for the Groovy-oracle fixtures (tests/groovy-oracle.test.ts), the independent
 * expectation each converted fixture must say.
 *
 * Usage: node tools/groovy-oracle.ts [name...]
 *
 * Each fixture is `tests/fixtures/groovy-oracle/<name>.groovy`. It runs with a preamble that defines the SexScript calls
 * the fixtures use: `show(value)` prints the value, and `wait(seconds)` prints nothing; a fixture whose
 * `<name>.preamble.groovy` exists runs with that preamble instead, such as one that prints `WAIT <seconds>` where the
 * waits are what the fixture is about. A fixture whose `<name>.answers` exists asks: each line answers one ask in turn, a
 * text ask with its text and a choice with its option's position from 0, and `getString(question, fallback)` and
 * `getSelectedValue(question, options)` print the question and return the next answer. The output goes to
 * `<name>.out`. Java comes from SEXSCRIPT_JAVA or the PATH, the Groovy JAR from SEXSCRIPT_GROOVY_JAR or the local Maven repository, as for
 * the parser.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const ORACLE_FIXTURES = fileURLToPath(
  new URL("../tests/fixtures/groovy-oracle/", import.meta.url),
);

/**
 * The SexScript calls the fixtures use, for Groovy, as closures the fixture's own closures see: a script method named
 * `wait` would lose to Java's `Object.wait`.
 */
export const DEFAULT_PREAMBLE =
  "def show = { Object value -> println(value) }\ndef wait = { Object value -> }\n";

/** The answers a fixture's asks get in turn (`<name>.answers`, one per line), or null where it does not ask. */
export function oracleAnswers(name: string): string[] | null {
  const answersPath = path.join(ORACLE_FIXTURES, `${name}.answers`);
  if (!existsSync(answersPath)) return null;
  const lines = readFileSync(answersPath, "utf8").split("\n");
  if (lines.at(-1) === "") lines.pop();
  return lines;
}

/** The SexScript asks for Groovy, as closures like the preamble's, answering from the list `answers`. */
function answersPreamble(answers: readonly string[]): string {
  const texts = answers.map(
    (answer) => `'${answer.replace(/[\\']/gu, (character) => `\\${character}`)}'`,
  );
  return (
    `def answers = [${texts.join(", ")}]\n` +
    "def getString = { Object question, Object fallback -> println(question); answers.remove(0) }\n" +
    "def getSelectedValue = { Object question, Object options -> println(question); answers.remove(0) as int }\n"
  );
}

/** The fixture names, in name order. */
export function oracleFixtureNames(): string[] {
  return readdirSync(ORACLE_FIXTURES)
    .filter((name) => name.endsWith(".groovy") && !name.endsWith(".preamble.groovy"))
    .map((name) => name.slice(0, -".groovy".length))
    .sort();
}

/** Groovy 2.5 runs on Java 8 to 17; a newer default Java fails on JDK classes, so SEXSCRIPT_JAVA can name another. */
const JAVA = process.env.SEXSCRIPT_JAVA ?? "java";

function groovyJar(): string {
  return (
    process.env.SEXSCRIPT_GROOVY_JAR ??
    path.join(homedir(), ".m2/repository/org/codehaus/groovy/groovy/2.5.21/groovy-2.5.21.jar")
  );
}

/** Runs a fixture with its preamble in Groovy and returns what it printed, or the error that stopped it. */
function record(name: string): { output: string; error: string | null } {
  const preamblePath = path.join(ORACLE_FIXTURES, `${name}.preamble.groovy`);
  const answers = oracleAnswers(name);
  const preamble =
    (answers === null ? "" : answersPreamble(answers)) +
    (existsSync(preamblePath) ? readFileSync(preamblePath, "utf8") : DEFAULT_PREAMBLE);
  const source = readFileSync(path.join(ORACLE_FIXTURES, `${name}.groovy`), "utf8");
  const directory = mkdtempSync(path.join(tmpdir(), "groovy-oracle-"));
  try {
    // A script name that Groovy accepts as a class name.
    const script = path.join(directory, "oracle.groovy");
    writeFileSync(script, `${preamble}${source}`);
    const result = spawnSync(JAVA, ["-cp", groovyJar(), "groovy.ui.GroovyMain", script], {
      encoding: "utf8",
      timeout: 120_000,
    });
    const error = result.status === 0 ? null : (result.stderr.split("\n")[0] ?? "failed");
    return { output: result.stdout, error };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const names = process.argv.length > 2 ? process.argv.slice(2) : oracleFixtureNames();
  let failed = 0;
  for (const name of names) {
    const { output, error } = record(name);
    if (error !== null) {
      // A fixture shows what Groovy did where it finished; one that Groovy stops on needs another fixture.
      process.stderr.write(`${name}: Groovy stopped: ${error}\n`);
      failed += 1;
      continue;
    }
    writeFileSync(path.join(ORACLE_FIXTURES, `${name}.out`), output);
    process.stdout.write(`${name}: ${output.split("\n").filter(Boolean).length} lines\n`);
  }
  process.exitCode = failed > 0 ? 1 : 0;
}
