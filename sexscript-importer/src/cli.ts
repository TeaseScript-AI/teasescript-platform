import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdir, open, readFile, readdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { parseParsedGroovyFile, type ParsedGroovyFile } from "./ast.ts";
import {
  loadRepositoryPackageScanner,
  loadRepositoryProjectCompiler,
  type TeaseProjectCompiler,
} from "./compile-check.ts";
import { emitTease } from "./emit-tease.ts";
import { imageFolderTag, imageSidecar } from "./image-tags.ts";
import { inventoryFiles } from "./inventory.ts";
import { lowerParsedFile } from "./lower.ts";
import { lowerPackage } from "./package.ts";
import { parseAcceptedForms, type AcceptedForm } from "./workarounds.ts";
import type { MediaFile } from "./pending.ts";
import { analyzeFeasibility, type FeasibilityOptions, type FinalPackageInput } from "./report.ts";
import { loadRepositoryProjectRunner } from "./runtime-check.ts";
import { parseGroovySource } from "./source-parser.ts";
import { selectTimeModel } from "./time-model.ts";

const [command, ...givenArgs] = process.argv.slice(2);
// `report --package <dir>` also checks a converted package as written (`finalPackage`).
// `--time-model 2` targets the time model main is building (time-model.ts).
const timeModelFlag = givenArgs.indexOf("--time-model");
if (timeModelFlag >= 0) selectTimeModel(givenArgs.splice(timeModelFlag, 2)[1]);
const packageFlag = givenArgs.indexOf("--package");
const finalPackageDir = packageFlag < 0 ? null : (givenArgs[packageFlag + 1] ?? "");
const rawArgs =
  packageFlag < 0
    ? givenArgs
    : givenArgs.filter((_, index) => index !== packageFlag && index !== packageFlag + 1);
const runRequested = rawArgs.includes("--run");
const compileRequested = runRequested || rawArgs.includes("--compile");
// `--accepted` emits every accepted form instead of its workaround, `--accepted=a,b` the listed ones.
const acceptedArgument = rawArgs.find(
  (arg) => arg === "--accepted" || arg.startsWith("--accepted="),
);
const accepted: ReadonlySet<AcceptedForm> =
  acceptedArgument === undefined ? new Set() : parseAcceptedForms(acceptedArgument.slice(11));
// `--keep-paragraphs` keeps texts with blank lines as one message each (a unit's keepParagraphs).
const keepParagraphs = rawArgs.includes("--keep-paragraphs");
// `--held=<path>` holds a stand-alone script back from the start choice (a unit's heldStandAlone).
const heldScripts = rawArgs.flatMap((arg) => (arg.startsWith("--held=") ? [arg.slice(7)] : []));
const args = rawArgs.filter(
  (arg) =>
    arg !== "--compile" &&
    arg !== "--run" &&
    arg !== acceptedArgument &&
    arg !== "--keep-paragraphs" &&
    !arg.startsWith("--held="),
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
      "Usage: node src/cli.ts report [--compile | --run] [--package <converted-dir>] [--accepted[=ids]] [--keep-paragraphs] [--time-model 1|2] <ast.json|script.groovy|source-dir> [...]",
    );
  }
  const files = await readReportInputs(args);
  const options: FeasibilityOptions = { accepted, keepParagraphs };
  if (compileRequested) options.compiler = await loadRepositoryProjectCompiler();
  if (runRequested) options.runner = await loadRepositoryProjectRunner();
  // A scripts folder's data folder holds the media that image counts read and the files that file tests read.
  if (args.length === 1 && (await stat(args[0]!)).isDirectory()) {
    const dataRoot = await legacyDataRoot(args[0]!);
    options.media = await packageMedia(path.join(dataRoot, "images"));
    options.files = await packageFiles(dataRoot);
    options.readFile = packageFileReader(dataRoot);
    const internal = await internalScripts(args[0]!);
    if (internal !== null) options.internalScripts = internal;
    if (heldScripts.length > 0) options.heldScripts = heldScripts;
    const versions = await releases(args[0]!);
    if (versions.length > 0) options.releases = versions;
  }
  if (finalPackageDir !== null) options.finalPackage = await finalPackage(finalPackageDir);
  const report = analyzeFeasibility(files, options);
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
} else if (command === "convert") {
  if (args.length !== 1)
    fail(
      "Usage: node src/cli.ts convert [--accepted[=ids]] [--keep-paragraphs] [--time-model 1|2] <script.groovy|ast.json>",
    );
  const input = args[0]!;
  const parsed = input.toLowerCase().endsWith(".groovy")
    ? await parseGroovySource(input)
    : await readParsedFile(input);
  const program = lowerParsedFile(parsed, { accepted, keepParagraphs });
  process.stdout.write(emitTease(program));
  reportDiagnostics(program);
} else if (command === "convert-package") {
  if (args.length !== 2) {
    fail(
      "Usage: node src/cli.ts convert-package [--compile] [--accepted[=ids]] [--keep-paragraphs] [--time-model 1|2] <source-dir> <output-dir>",
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
  const internal = await internalScripts(sourceRoot);
  const versions = await releases(sourceRoot);
  const lowered = lowerPackage(parsed, {
    accepted,
    keepParagraphs,
    media,
    files,
    readFile: packageFileReader(dataRoot),
    ...(internal === null ? {} : { internalScripts: internal }),
    ...(heldScripts.length === 0 ? {} : { heldScripts }),
    ...(versions.length === 0 ? {} : { releases: versions }),
  });
  const programs = lowered.composed;
  // Each file keeps its legacy folder and name (lowerPackage paths); the package starts at main.tease (ADR 0022): a
  // legacy main.groovy, or a generated file that goes to the main script.
  const entry = lowered.main !== null && "file" in lowered.main ? lowered.main.file : null;
  const outputs = programs.map((program, index) => ({
    program,
    index,
    relative:
      lowered.paths[index] ??
      (index === entry
        ? "main.tease"
        : path.relative(sourceRoot, sourcePaths[index]!).replace(/\.groovy$/iu, ".tease")),
  }));
  if (lowered.main !== null && "menu" in lowered.main)
    outputs.push({ program: lowered.main.menu, index: -1, relative: "main.tease" });
  let errors = 0;
  let written = 0;
  const project: Array<{ path: string; source: string; outputPath: string }> = [];
  for (const { program, index, relative } of outputs) {
    const file = index < 0 ? null : parsed[index]!;
    // A file that does not parse produces no output but reports its parser errors.
    if (file !== null && file.root === null) errors += reportDiagnostics(program);
    // A helper class writes its own file where it has global functions, which gives it a path.
    if (
      file !== null &&
      (program.module !== undefined ||
        (file.root?.kind !== "scriptBody" && lowered.paths[index] === null))
    )
      continue;
    const outputPath = path.join(outputRoot, relative);
    await mkdir(path.dirname(outputPath), { recursive: true });
    const source = emitTease(program);
    await writeFile(outputPath, source, "utf8");
    written += 1;
    errors += reportDiagnostics(program);
    project.push({ path: relative.replaceAll("\\", "/"), source, outputPath });
  }
  // Tag queries find a legacy folder's images by the tag of its path, which a generated sidecar gives each image (#572).
  if (
    programs.some((program) => program.diagnostics.some(({ code }) => code === "SX_IMAGE_TAGS"))
  ) {
    for (const image of media) {
      const sidecar = path.join(outputRoot, `${image.path}.xmp`);
      await mkdir(path.dirname(sidecar), { recursive: true });
      await writeFile(sidecar, imageSidecar([imageFolderTag(image.path)]), "utf8");
    }
    process.stderr.write(`Tagged ${media.length} image(s) with their folders in sidecars.\n`);
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

/**
 * A converted package as the Player reads it, by the playground server's package scan: its sources, decoded alike,
 * with the SHA-256 of each file's bytes, and its images with their tags.
 */
async function finalPackage(root: string): Promise<FinalPackageInput> {
  const scan = await (await loadRepositoryPackageScanner())(root);
  return {
    files: await Promise.all(
      scan.sources.map(async (file) => ({
        ...file,
        sha256: createHash("sha256")
          .update(await readFile(path.join(root, file.path)))
          .digest("hex"),
      })),
    ),
    images: scan.images,
    problems: scan.problems,
  };
}

/**
 * The scripts of an assembled unit that are no entries of their own, from the `unit.json` the merged corpus keeps beside
 * a unit's scripts folder (`internalScripts`, paths from the scripts folder); null without one.
 */
async function internalScripts(scriptsRoot: string): Promise<string[] | null> {
  const text = await readFile(path.join(scriptsRoot, "..", "unit.json"), "utf8").catch(() => null);
  if (text === null) return null;
  const unit: unknown = JSON.parse(text);
  if (
    typeof unit !== "object" ||
    unit === null ||
    !("internalScripts" in unit) ||
    !Array.isArray(unit.internalScripts) ||
    !unit.internalScripts.every((item): item is string => typeof item === "string")
  )
    fail(`${path.join(scriptsRoot, "..", "unit.json")} needs an "internalScripts" list of paths.`);
  return unit.internalScripts;
}

/**
 * The releases that a corpus merge put side by side in a unit, from its `unit.json` (`releases`, lists of paths from
 * the scripts folder, PackageOptions.releases); empty without them.
 */
async function releases(scriptsRoot: string): Promise<string[][]> {
  const text = await readFile(path.join(scriptsRoot, "..", "unit.json"), "utf8").catch(() => null);
  if (text === null) return [];
  const unit: unknown = JSON.parse(text);
  if (typeof unit !== "object" || unit === null || !("releases" in unit)) return [];
  const list = unit.releases;
  if (
    !Array.isArray(list) ||
    !list.every(
      (release): release is string[] =>
        Array.isArray(release) && release.every((item): item is string => typeof item === "string"),
    )
  )
    fail(`${path.join(scriptsRoot, "..", "unit.json")} needs "releases" as lists of paths.`);
  return list;
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
        const size = imageSize(await readHead(absolute));
        return { path: relative, ...(size === null ? {} : size) };
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
