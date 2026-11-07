import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isRecord, parseParsedGroovyFile, type ParsedGroovyFile } from "./ast.ts";

export type GroovyParseMode = "script-body" | "unit";
export type GroovyParserRunner = (
  mode: GroovyParseMode,
  sourcePath: string,
) => Promise<ParsedGroovyFile>;

const parserScript = fileURLToPath(new URL("../parser-groovy/bin/export-ast.sh", import.meta.url));

export async function parseGroovySource(
  sourcePath: string,
  runner: GroovyParserRunner = runCachedGroovyParser,
): Promise<ParsedGroovyFile> {
  const content = await readFile(sourcePath).catch(() => null);
  // The legacy player dropped a byte order mark at the start of a script (ScriptContainer.readFromFile), so the parser
  // reads a copy without it, and the result names the original file.
  if (content !== null && content[0] === 0xef && content[1] === 0xbb && content[2] === 0xbf) {
    const directory = await mkdtemp(path.join(tmpdir(), "sexscript-bom-"));
    const copy = path.join(directory, path.basename(sourcePath));
    try {
      await writeFile(copy, content.subarray(3));
      const parsed = await parseGroovySource(copy, runner);
      const from = JSON.stringify(copy).slice(1, -1);
      const to = JSON.stringify(sourcePath).slice(1, -1);
      return parseParsedGroovyFile(
        JSON.parse(JSON.stringify(parsed).replaceAll(from, to)),
        sourcePath,
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
  const scriptBody = await runner("script-body", sourcePath);
  if (scriptBody.diagnostics.length === 0) return scriptBody;

  const unit = await runner("unit", sourcePath);
  if (isAuxiliaryUnit(unit)) return unit;
  return scriptBody;
}

export async function runLegacyGroovyParser(
  mode: GroovyParseMode,
  sourcePath: string,
): Promise<ParsedGroovyFile> {
  const { stdout, stderr, status } = await run("bash", [parserScript, mode, sourcePath]);
  if (status !== 0) {
    throw new Error(
      `Legacy Groovy parser failed with exit code ${status}${stderr.length === 0 ? "" : `: ${stderr.trim()}`}`,
    );
  }
  return parseParsedGroovyFile(JSON.parse(stdout), sourcePath);
}

/**
 * The legacy parser with a cache of its output per file content, parse mode, and parser version (the exporter source
 * and the Groovy JARs), so that only a changed file starts a JVM. The cache directory is `SEXSCRIPT_AST_CACHE`, by
 * default `sexscript-importer/groovy-ast` in the user's cache directory, shared by every checkout; `off` disables it.
 */
export async function runCachedGroovyParser(
  mode: GroovyParseMode,
  sourcePath: string,
  parse: GroovyParserRunner = runLegacyGroovyParser,
): Promise<ParsedGroovyFile> {
  const directory = cacheDirectory();
  if (directory === null) return await parse(mode, sourcePath);
  const content = await readFile(sourcePath);
  const key = createHash("sha256").update(`${mode}\0`).update(content).digest("hex");
  const file = path.join(directory, await parserVersion(), key.slice(0, 2), `${key}.json`);
  const cached = await readFile(file, "utf8").catch(() => null);
  const entry: unknown = cached === null ? null : JSON.parse(cached);
  if (isRecord(entry) && typeof entry.sourceName === "string" && isRecord(entry.output)) {
    // The cached output names the file it was parsed from; the same content may sit at another path.
    const from = JSON.stringify(entry.sourceName).slice(1, -1);
    const to = JSON.stringify(sourcePath).slice(1, -1);
    const output = JSON.stringify(entry.output);
    return parseParsedGroovyFile(
      JSON.parse(from === to ? output : output.replaceAll(from, to)),
      sourcePath,
    );
  }
  const parsed = await parse(mode, sourcePath);
  await mkdir(path.dirname(file), { recursive: true });
  // Written under a unique name and renamed, so concurrent parses never read a partial entry.
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temporary, JSON.stringify({ sourceName: sourcePath, output: parsed }));
  await rename(temporary, file);
  return parsed;
}

function cacheDirectory(): string | null {
  const configured = process.env.SEXSCRIPT_AST_CACHE;
  if (configured === "off") return null;
  if (configured !== undefined && configured !== "") return configured;
  const base = process.env.XDG_CACHE_HOME || path.join(homedir(), ".cache");
  return path.join(base, "sexscript-importer", "groovy-ast");
}

let version: Promise<string> | undefined;

/** A hash of what decides the parser output: the exporter source and the Groovy JARs it runs with. */
function parserVersion(): Promise<string> {
  version ??= (async () => {
    const maven = path.join(homedir(), ".m2", "repository", "org", "codehaus", "groovy");
    const inputs = [
      fileURLToPath(new URL("../parser-groovy/src/SexScriptAstExporter.java", import.meta.url)),
      process.env.SEXSCRIPT_GROOVY_JAR || path.join(maven, "groovy", "2.5.21", "groovy-2.5.21.jar"),
      process.env.SEXSCRIPT_GROOVY_JSON_JAR ||
        path.join(maven, "groovy-json", "2.5.21", "groovy-json-2.5.21.jar"),
    ];
    const hash = createHash("sha256");
    for (const input of inputs) hash.update(await readFile(input)).update("\0");
    return hash.digest("hex").slice(0, 16);
  })();
  return version;
}

function isAuxiliaryUnit(file: ParsedGroovyFile): boolean {
  if (file.diagnostics.length > 0 || file.root?.kind !== "compilationUnit") return false;
  const classes = Array.isArray(file.root.classes) ? file.root.classes : [];
  const topLevel = file.root.topLevel;
  const topLevelStatements =
    isRecord(topLevel) && Array.isArray(topLevel.statements) ? topLevel.statements : [];
  return classes.length > 0 && topLevelStatements.length === 0;
}

async function run(
  command: string,
  args: string[],
): Promise<{ stdout: string; stderr: string; status: number }> {
  return await new Promise((resolve, reject) => {
    const child = spawn(command, args, { env: process.env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.once("error", reject);
    child.once("close", (code) => resolve({ stdout, stderr, status: code ?? 1 }));
  });
}
