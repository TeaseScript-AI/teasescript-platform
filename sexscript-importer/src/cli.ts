import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { parseParsedGroovyFile, type ParsedGroovyFile } from "./ast.ts";
import { loadRepositoryCompiler, type TeaseCompiler } from "./compile-check.ts";
import { emitTease } from "./emit-tease.ts";
import { inventoryFiles } from "./inventory.ts";
import { lowerParsedFile } from "./lower.ts";
import { lowerSelfContainedPackage } from "./package.ts";
import { analyzeFeasibility } from "./report.ts";
import { parseGroovySource } from "./source-parser.ts";

const [command, ...rawArgs] = process.argv.slice(2);
const compileRequested = rawArgs.includes("--compile");
const args = rawArgs.filter((arg) => arg !== "--compile");

if (command === "inventory") {
  if (args.length === 0) {
    fail("Usage: node src/cli.ts inventory <ast.json|script.groovy|source-dir> [...]");
  }
  const files = await readReportInputs(args);
  process.stdout.write(`${JSON.stringify(inventoryFiles(files), null, 2)}\n`);
} else if (command === "report") {
  if (args.length === 0) {
    fail("Usage: node src/cli.ts report [--compile] <ast.json|script.groovy|source-dir> [...]");
  }
  const files = await readReportInputs(args);
  const compiler = compileRequested ? await loadRepositoryCompiler() : undefined;
  const report = analyzeFeasibility(files, compiler === undefined ? {} : { compiler });
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
} else if (command === "convert") {
  if (args.length !== 1) fail("Usage: node src/cli.ts convert <script.groovy|ast.json>");
  const input = args[0]!;
  const parsed = input.toLowerCase().endsWith(".groovy")
    ? await parseGroovySource(input)
    : await readParsedFile(input);
  const program = lowerParsedFile(parsed);
  process.stdout.write(emitTease(program));
  reportDiagnostics(program);
} else if (command === "convert-package") {
  if (args.length !== 2) {
    fail("Usage: node src/cli.ts convert-package [--compile] <source-dir> <output-dir>");
  }
  const compiler = compileRequested ? await loadRepositoryCompiler() : undefined;
  await convertPackage(args[0]!, args[1]!, compiler);
} else {
  fail("Usage: node src/cli.ts <inventory|report|convert|convert-package> ...");
}

async function readReportInputs(inputs: string[]): Promise<ParsedGroovyFile[]> {
  const groovyPaths: string[] = [];
  const parsed: ParsedGroovyFile[] = [];
  for (const input of inputs) {
    if ((await stat(input)).isDirectory()) groovyPaths.push(...(await findGroovyFiles(input)));
    else if (input.toLowerCase().endsWith(".groovy")) groovyPaths.push(input);
    else parsed.push(await readParsedFile(input));
  }
  return [...parsed, ...(await parseGroovyFiles(groovyPaths))];
}

/** Each parse starts a JVM, so bound the number of concurrent parser processes. */
async function parseGroovyFiles(sourcePaths: string[]): Promise<ParsedGroovyFile[]> {
  const result: ParsedGroovyFile[] = [];
  const concurrency = 4;
  for (let start = 0; start < sourcePaths.length; start += concurrency) {
    const batch = sourcePaths.slice(start, start + concurrency);
    result.push(...(await Promise.all(batch.map((sourcePath) => parseGroovySource(sourcePath)))));
  }
  return result;
}

async function convertPackage(
  sourceDir: string,
  outputDir: string,
  compiler: TeaseCompiler | undefined,
): Promise<void> {
  const sourceRoot = path.resolve(sourceDir);
  const outputRoot = path.resolve(outputDir);
  const sourcePaths = await findGroovyFiles(sourceRoot);
  if (sourcePaths.length === 0) fail(`No .groovy files found under ${sourceRoot}`);
  const parsed = await parseGroovyFiles(sourcePaths);
  const programs = lowerSelfContainedPackage(parsed);
  let errors = 0;
  let written = 0;
  let compilerClean = 0;
  for (let index = 0; index < programs.length; index += 1) {
    if (parsed[index]!.root?.kind !== "scriptBody") continue;
    const relative = path.relative(sourceRoot, sourcePaths[index]!);
    const outputPath = path.join(outputRoot, relative.replace(/\.groovy$/iu, ".tease"));
    await mkdir(path.dirname(outputPath), { recursive: true });
    const source = emitTease(programs[index]!);
    await writeFile(outputPath, source, "utf8");
    written += 1;
    errors += reportDiagnostics(programs[index]!);
    if (compiler !== undefined) {
      const compiled = compiler(source);
      if (compiled.compiled) compilerClean += 1;
      else process.exitCode = 1;
      for (const diagnostic of compiled.diagnostics) {
        const location = diagnostic.line === null ? "" : `:${diagnostic.line}:${diagnostic.column}`;
        process.stderr.write(
          `compiler ${diagnostic.severity} ${diagnostic.code} ${path.relative(process.cwd(), outputPath)}${location} ${diagnostic.message}\n`,
        );
      }
    }
  }
  process.stderr.write(`Converted ${written} SexScript source file(s) into ${outputRoot}.\n`);
  if (compiler !== undefined) {
    process.stderr.write(`${compilerClean}/${written} generated file(s) compile without errors.\n`);
  }
  if (errors > 0) process.exitCode = 1;
}

async function findGroovyFiles(directory: string): Promise<string[]> {
  const result: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const filePath = path.join(directory, entry.name);
    if (entry.isDirectory()) result.push(...(await findGroovyFiles(filePath)));
    else if (entry.isFile() && entry.name.toLowerCase().endsWith(".groovy")) result.push(filePath);
  }
  return result.sort();
}

function reportDiagnostics(program: ReturnType<typeof lowerParsedFile>): number {
  let errors = 0;
  for (const diagnostic of program.diagnostics) {
    const location =
      diagnostic.span === null ? "" : `:${diagnostic.span.line}:${diagnostic.span.column}`;
    process.stderr.write(
      `${diagnostic.severity} ${diagnostic.code} ${program.sourceName}${location} ${diagnostic.message}\n`,
    );
    if (diagnostic.severity === "error") errors += 1;
  }
  if (errors > 0) process.exitCode = 1;
  return errors;
}

async function readParsedFile(filePath: string): Promise<ParsedGroovyFile> {
  return parseParsedGroovyFile(JSON.parse(await readFile(filePath, "utf8")), filePath);
}

function fail(message: string): never {
  process.stderr.write(`${message}\n`);
  process.exit(2);
}
