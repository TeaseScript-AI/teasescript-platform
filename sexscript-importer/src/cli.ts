import { readFileSync } from "node:fs";
import { mkdir, open, readFile, readdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { parseParsedGroovyFile, type ParsedGroovyFile } from "./ast.ts";
import { loadRepositoryProjectCompiler, type TeaseProjectCompiler } from "./compile-check.ts";
import { emitTease } from "./emit-tease.ts";
import { inventoryFiles } from "./inventory.ts";
import { lowerParsedFile } from "./lower.ts";
import { lowerPackage } from "./package.ts";
import { parseProposals, type ProposalId } from "./proposals.ts";
import { parseAcceptedForms, type AcceptedForm } from "./workarounds.ts";
import type { MediaFile } from "./pending.ts";
import { analyzeFeasibility, type FeasibilityOptions } from "./report.ts";
import { loadRepositoryProjectRunner } from "./runtime-check.ts";
import { parseGroovySource } from "./source-parser.ts";

const [command, ...givenArgs] = process.argv.slice(2);
// `report --package <dir>` also checks a converted package as written (`finalPackage`).
const packageFlag = givenArgs.indexOf("--package");
const finalPackageDir = packageFlag < 0 ? null : (givenArgs[packageFlag + 1] ?? "");
const rawArgs =
  packageFlag < 0
    ? givenArgs
    : givenArgs.filter((_, index) => index !== packageFlag && index !== packageFlag + 1);
const runRequested = rawArgs.includes("--run");
const compileRequested = runRequested || rawArgs.includes("--compile");
// `--proposed` emits every proposed language change in its working syntax, `--proposed=a,b` the listed ones.
const proposedArgument = rawArgs.find(
  (arg) => arg === "--proposed" || arg.startsWith("--proposed="),
);
const proposals: ReadonlySet<ProposalId> =
  proposedArgument === undefined ? new Set() : parseProposals(proposedArgument.slice(11));
// `--accepted` emits every accepted form instead of its workaround, `--accepted=a,b` the listed ones.
const acceptedArgument = rawArgs.find(
  (arg) => arg === "--accepted" || arg.startsWith("--accepted="),
);
const accepted: ReadonlySet<AcceptedForm> =
  acceptedArgument === undefined ? new Set() : parseAcceptedForms(acceptedArgument.slice(11));
const args = rawArgs.filter(
  (arg) =>
    arg !== "--compile" && arg !== "--run" && arg !== proposedArgument && arg !== acceptedArgument,
);

if (command === "inventory") {
  if (args.length === 0) {
    fail("Usage: node src/cli.ts inventory <ast.json|script.groovy|source-dir> [...]");
  }
  const files = await readReportInputs(args);
  process.stdout.write(`${JSON.stringify(inventoryFiles(files), null, 2)}\n`);
} else if (command === "report") {
  if (
    args.length === 0 ||
    finalPackageDir === "" ||
    (finalPackageDir !== null && !compileRequested)
  ) {
    fail(
      "Usage: node src/cli.ts report [--compile | --run] [--package <converted-dir>] [--proposed[=ids]] [--accepted[=ids]] <ast.json|script.groovy|source-dir> [...]",
    );
  }
  const files = await readReportInputs(args);
  const options: FeasibilityOptions = { proposals, accepted };
  if (compileRequested) options.compiler = await loadRepositoryProjectCompiler();
  if (runRequested) options.runner = await loadRepositoryProjectRunner();
  // A scripts folder's data folder holds the media that image counts read and the files that file tests read.
  if (args.length === 1 && (await stat(args[0]!)).isDirectory()) {
    const dataRoot = await legacyDataRoot(args[0]!);
    options.media = await packageMedia(path.join(dataRoot, "images"));
    options.files = await packageFiles(dataRoot);
    options.readFile = packageFileReader(dataRoot);
  }
  if (finalPackageDir !== null) options.finalPackage = await packageTeaseFiles(finalPackageDir);
  const report = analyzeFeasibility(files, options);
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
} else if (command === "convert") {
  if (args.length !== 1)
    fail(
      "Usage: node src/cli.ts convert [--proposed[=ids]] [--accepted[=ids]] <script.groovy|ast.json>",
    );
  const input = args[0]!;
  const parsed = input.toLowerCase().endsWith(".groovy")
    ? await parseGroovySource(input)
    : await readParsedFile(input);
  const program = lowerParsedFile(parsed, { proposals, accepted });
  process.stdout.write(emitTease(program));
  reportDiagnostics(program);
} else if (command === "convert-package") {
  if (args.length !== 2) {
    fail(
      "Usage: node src/cli.ts convert-package [--compile] [--proposed[=ids]] [--accepted[=ids]] <source-dir> <output-dir>",
    );
  }
  const compiler = compileRequested ? await loadRepositoryProjectCompiler() : undefined;
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

/** A parse not in the cache starts a JVM, so bound the number of concurrent parser processes. */
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
  compiler: TeaseProjectCompiler | undefined,
): Promise<void> {
  const sourceRoot = path.resolve(sourceDir);
  const outputRoot = path.resolve(outputDir);
  const sourcePaths = await findGroovyFiles(sourceRoot);
  if (sourcePaths.length === 0) fail(`No .groovy files found under ${sourceRoot}`);
  const parsed = await parseGroovyFiles(sourcePaths);
  // The legacy data folder holds the media that image counts read and the files that file tests read.
  const dataRoot = await legacyDataRoot(sourceRoot);
  const media = await packageMedia(path.join(dataRoot, "images"));
  const files = await packageFiles(dataRoot);
  const lowered = lowerPackage(parsed, {
    proposals,
    accepted,
    media,
    files,
    readFile: packageFileReader(dataRoot),
  });
  const programs = lowered.composed;
  // The package starts at main.tease (ADR 0022): its entry script, or a generated menu over the scripts it lists.
  const entry = lowered.main !== null && "file" in lowered.main ? lowered.main.file : null;
  const outputs = programs.map((program, index) => ({
    program,
    index,
    // Transfers name paths relative to the scripts' common folder, which lowerPackage gives.
    relative:
      lowered.paths[index] ??
      (index === entry
        ? "main.tease"
        : path.relative(sourceRoot, sourcePaths[index]!).replace(/\.groovy$/iu, ".tease")),
  }));
  if (lowered.main !== null && "menu" in lowered.main)
    outputs.push({ program: lowered.main.menu, index: -1, relative: "main.tease" });
  // The functions the scripts share, as global functions (#570).
  if (lowered.globals?.helpers != null)
    outputs.push({ program: lowered.globals.helpers, index: -1, relative: "helpers.tease" });
  let errors = 0;
  let written = 0;
  const project: Array<{ path: string; source: string; outputPath: string }> = [];
  for (const { program, index, relative } of outputs) {
    const file = index < 0 ? null : parsed[index]!;
    // A file that does not parse produces no output but reports its parser errors.
    if (file !== null && file.root === null) errors += reportDiagnostics(program);
    if (file !== null && (file.root?.kind !== "scriptBody" || program.module !== undefined))
      continue;
    const outputPath = path.join(outputRoot, relative);
    await mkdir(path.dirname(outputPath), { recursive: true });
    const source = emitTease(program);
    await writeFile(outputPath, source, "utf8");
    written += 1;
    errors += reportDiagnostics(program);
    project.push({ path: relative.replaceAll("\\", "/"), source, outputPath });
  }
  process.stderr.write(`Converted ${written} SexScript source file(s) into ${outputRoot}.\n`);
  if (compiler !== undefined) {
    // The package compiles as one project (ADR 0022), so transfers and global functions resolve across files.
    const compiled = compiler(project);
    if (!compiled.compiled) process.exitCode = 1;
    const failing = new Set<string>();
    for (const diagnostic of compiled.diagnostics) {
      if (diagnostic.severity === "error") failing.add(diagnostic.path);
      const file = project.find(({ path: filePath }) => filePath === diagnostic.path);
      const location = diagnostic.line === null ? "" : `:${diagnostic.line}:${diagnostic.column}`;
      process.stderr.write(
        `compiler ${diagnostic.severity} ${diagnostic.code} ${path.relative(process.cwd(), file?.outputPath ?? path.join(outputRoot, diagnostic.path))}${location} ${diagnostic.message}\n`,
      );
    }
    process.stderr.write(
      `${project.length - failing.size}/${written} generated file(s) compile without errors; the project ${compiled.compiled ? "compiles" : "does not compile"}.\n`,
    );
  }
  if (errors > 0) process.exitCode = 1;
}

/** The images below `root`, each tagged with the lower-case names of the folders it is in. */
/**
 * The legacy data folder of a scripts folder: the folder itself when it holds the package's `images/` or `sounds/`
 * (the merged corpus layout), otherwise its parent, where the legacy player kept `scripts/` beside them.
 */
async function legacyDataRoot(scriptsRoot: string): Promise<string> {
  for (const folder of ["images", "sounds"]) {
    const found = await stat(path.join(scriptsRoot, folder)).catch(() => null);
    if (found?.isDirectory() === true) return scriptsRoot;
  }
  return path.join(scriptsRoot, "..");
}

/** The `.tease` files of a converted package, by their package paths. */
async function packageTeaseFiles(root: string): Promise<Array<{ path: string; source: string }>> {
  const paths = (await packageFiles(root)).filter(
    (file) =>
      file.toLowerCase().endsWith(".tease") &&
      !file.split("/").some((part) => part.startsWith(".")),
  );
  return Promise.all(
    paths.map(async (file) => ({
      path: file,
      source: await readFile(path.join(root, file), "utf8"),
    })),
  );
}

/** Every file below the legacy data folder, relative to it with forward slashes. */
async function packageFiles(root: string): Promise<string[]> {
  const entries = await readdir(root, { recursive: true, withFileTypes: true }).catch(() => []);
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) =>
      path.relative(root, path.join(entry.parentPath, entry.name)).split(path.sep).join("/"),
    )
    .sort();
}

/** Reads a file of the legacy data folder by its relative name; null when it cannot be read. */
function packageFileReader(root: string): (name: string) => Uint8Array | null {
  return (name) => {
    try {
      return readFileSync(path.join(root, name));
    } catch {
      return null;
    }
  };
}

async function packageMedia(root: string): Promise<MediaFile[]> {
  const imageExtensions = new Set([".gif", ".jpeg", ".jpg", ".png", ".webp"]);
  const files = await readdir(root, { recursive: true, withFileTypes: true }).catch(() => []);
  const media = await Promise.all(
    files
      .filter(
        (entry) => entry.isFile() && imageExtensions.has(path.extname(entry.name).toLowerCase()),
      )
      .map(async (entry): Promise<MediaFile> => {
        const absolute = path.join(entry.parentPath, entry.name);
        const relative = path.relative(root, absolute);
        const folders = relative.split(path.sep).slice(0, -1);
        const size = imageSize(await readHead(absolute));
        return {
          path: relative,
          tags: folders.map((folder) => folder.toLowerCase()),
          ...(size === null ? {} : size),
        };
      }),
  );
  return media.sort((left, right) => left.path.localeCompare(right.path));
}

/** The first bytes of a file, enough for an image header. */
async function readHead(file: string): Promise<Buffer> {
  const handle = await open(file, "r");
  try {
    const buffer = Buffer.alloc(65536);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

/** The pixel size of a PNG, GIF, or JPEG image from its header; null for another format or a damaged header. */
function imageSize(head: Buffer): { width: number; height: number } | null {
  if (head.length >= 24 && head.readUInt32BE(0) === 0x89504e47)
    return { width: head.readUInt32BE(16), height: head.readUInt32BE(20) };
  if (head.length >= 10 && head.toString("latin1", 0, 3) === "GIF")
    return { width: head.readUInt16LE(6), height: head.readUInt16LE(8) };
  if (head.length >= 4 && head[0] === 0xff && head[1] === 0xd8) {
    let offset = 2;
    while (offset + 9 < head.length && head[offset] === 0xff) {
      const marker = head[offset + 1]!;
      const length = head.readUInt16BE(offset + 2);
      // A start-of-frame marker (C0 to CF without C4, C8, and CC) holds the height, then the width.
      if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker))
        return { width: head.readUInt16BE(offset + 7), height: head.readUInt16BE(offset + 5) };
      offset += 2 + length;
    }
  }
  return null;
}

/**
 * The scripts below a scripts folder. When the folder is the legacy data folder (the merged corpus layout), its
 * `images/` and `sounds/` hold data such as Groovy persona files, not scripts.
 */
async function findGroovyFiles(directory: string, top = true): Promise<string[]> {
  const result: string[] = [];
  const dataFolder = top && (await legacyDataRoot(directory)) === directory;
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const filePath = path.join(directory, entry.name);
    if (entry.isDirectory() && dataFolder && ["images", "sounds"].includes(entry.name)) continue;
    if (entry.isDirectory()) result.push(...(await findGroovyFiles(filePath, false)));
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
      `${diagnostic.severity} ${diagnostic.code} ${diagnostic.sourceName ?? program.sourceName}${location} ${diagnostic.message}\n`,
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
