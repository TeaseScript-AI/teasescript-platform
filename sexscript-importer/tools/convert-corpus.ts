/**
 * Converts every script package of an organized legacy corpus (one folder per package, each with `scripts/`,
 * `images/`, and `sounds/`) into a root of TeaseScript packages that the playground server offers with
 * `PLAYGROUND_PACKAGES`.
 *
 * Usage: node tools/convert-corpus.ts [--jobs N] [--only id,id] [--report-only] [--patches dir] <corpus-root>
 *   <converted-root>
 *
 * Each package is converted by `src/cli.ts convert-package`, and `src/cli.ts report --run --package` writes its report
 * to `.report.json` in the package folder, with `finalPackage` checking the files as written; `--report-only` writes
 * only the reports of packages already converted. Manual patches of a unit (`patches/<unit>/patches.json`, see
 * `unit-patches.ts`; `--patches` names another folder) apply to a staged copy of its sources before conversion and to
 * the generated files after it. A unit is converted in `<converted-root>/.staging/<unit>/` and replaces its published
 * folder only when every step succeeded; otherwise the previous output stays and `.failures/<unit>.json` says why.
 * `.conversion.json` records the converter commit, the hashes of the legacy scripts, and the patches applied.
 *
 * Legacy scripts name images relative to `images/` and
 * sounds relative to `sounds/`, while a TeaseScript package names its files from the package root (ADR 0022), so both
 * media trees are hard-linked into the package root. Resource packs (folders without scripts) are linked into the
 * script packages that name their media folders (see `resourcePackTargets`). Links are hard links, never copies.
 */
import { execFile } from "node:child_process";
import {
  copyFile,
  link,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  applyOutputPatches,
  applySourcePatches,
  readUnitPatches,
  sha256,
  sourcePatchPaths,
  type UnitPatches,
} from "./unit-patches.ts";

const MEDIA_FOLDERS = ["images", "sounds"] as const;
/** The General MIDI soundfont that renders MIDI files (Debian `fluid-soundfont-gm`, else `timgm6mb-soundfont`). */
const SOUNDFONTS = ["/usr/share/sounds/sf2/FluidR3_GM.sf2", "/usr/share/sounds/sf2/TimGM6mb.sf2"];
const cliPath = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
/** The manual unit patches, `patches/<unit>/patches.json`. */
const PATCHES = fileURLToPath(new URL("../patches", import.meta.url));
/** Hidden folders of the converted root: units being converted, and why a unit kept its previous output. */
const STAGING = ".staging";
const FAILURES = ".failures";

/** One file of a resource pack, by its path from the pack's media folder, with the packages it is linked into. */
export interface ResourceFileTarget {
  readonly pack: string;
  readonly source: string;
  readonly relative: string;
  readonly packages: readonly string[];
}

/** What the conversion of one package did and from what; written as `.conversion.json` in the package folder. */
export interface ConversionRecord {
  readonly source: string;
  /** The importer commit of the converter code, marked `-modified` when it had uncommitted changes. */
  readonly converter: string;
  /** SHA-256 of each legacy script before patches, by its path from the unit folder. */
  readonly inputs: Readonly<Record<string, string>>;
  /** The manual patches applied, in order, with the SHA-256 of each diff file or output-patch entry. */
  readonly patches: ReadonlyArray<{ id: string; layer: "source" | "output"; sha256: string }>;
  readonly exitCode: number;
  readonly linkedMedia: number;
  readonly linkedResourceMedia: number;
  /** Media paths another file already took; the package's own file, or the first pack's, wins. */
  readonly collisions: readonly string[];
  readonly resourcePacks: readonly string[];
}

export interface UnitOptions {
  readonly corpusRoot: string;
  readonly outputRoot: string;
  readonly id: string;
  readonly resources: readonly ResourceFileTarget[];
  readonly patchesRoot: string;
  /** Recorded as `converter` in `.conversion.json`. */
  readonly converter: string;
}

/** Why a unit kept its previous output: the step that failed and its message. */
export interface UnitFailure {
  readonly stage: string;
  readonly message: string;
}

export type UnitResult =
  | {
      readonly converted: true;
      readonly record: ConversionRecord;
      readonly report: "ok" | "failed";
    }
  | { readonly converted: false; readonly failure: UnitFailure };

if (process.argv[1] === fileURLToPath(import.meta.url)) await main(process.argv.slice(2));

async function main(rawArgs: string[]): Promise<void> {
  let jobs = 3;
  let only: Set<string> | null = null;
  let reportOnly = false;
  let patchesRoot = PATCHES;
  const args: string[] = [];
  for (let index = 0; index < rawArgs.length; index += 1) {
    const arg = rawArgs[index]!;
    if (arg === "--jobs") jobs = Number(rawArgs[++index]);
    else if (arg === "--only") only = new Set(rawArgs[++index]!.split(","));
    else if (arg === "--report-only") reportOnly = true;
    else if (arg === "--patches") patchesRoot = path.resolve(rawArgs[++index] ?? "");
    else args.push(arg);
  }
  if (args.length !== 2 || !Number.isInteger(jobs) || jobs < 1) {
    process.stderr.write(
      "Usage: node tools/convert-corpus.ts [--jobs N] [--only id,id] [--report-only] [--patches dir] <corpus-root> <converted-root>\n",
    );
    process.exit(2);
  }
  const corpusRoot = path.resolve(args[0]!);
  const outputRoot = path.resolve(args[1]!);
  const scriptPackages: Array<{ id: string; scripts: string[] }> = [];
  const resourcePacks: string[] = [];
  for (const id of await folders(corpusRoot)) {
    const mediaRoots = await Promise.all(
      MEDIA_FOLDERS.map((media) => mediaRoot(corpusRoot, id, media)),
    );
    const scripts = await unitScripts(corpusRoot, id);
    if (scripts.length > 0) scriptPackages.push({ id, scripts });
    else if ((await Promise.all(mediaRoots.map((root) => hasFiles(root)))).some(Boolean))
      resourcePacks.push(id);
  }
  const sources = new Map<string, string>();
  for (const { id, scripts } of scriptPackages) {
    const texts = await Promise.all(scripts.map((file) => readFile(file, "utf8")));
    sources.set(id, texts.join("\n").toLowerCase());
  }
  const packFiles: Array<{ pack: string; source: string; relative: string }> = [];
  for (const pack of resourcePacks)
    for (const media of MEDIA_FOLDERS) {
      const root = await mediaRoot(corpusRoot, pack, media);
      for (const file of (await files(root)).filter((file) => !isGroovy(file)))
        packFiles.push({ pack, source: file, relative: toPosix(path.relative(root, file)) });
    }
  const targets = resourcePackTargets(packFiles, sources);
  const byPackage = new Map<string, ResourceFileTarget[]>();
  for (const target of targets)
    for (const id of target.packages) byPackage.set(id, [...(byPackage.get(id) ?? []), target]);

  const selected = scriptPackages.filter(({ id }) => only === null || only.has(id));
  await mkdir(outputRoot, { recursive: true });
  const importer = await importerVersion();
  const records = new Map<string, ConversionRecord>();
  const failures = new Map<string, UnitFailure>();
  let next = 0;
  let done = 0;
  await Promise.all(
    Array.from({ length: Math.min(jobs, selected.length) }, async () => {
      while (next < selected.length) {
        const { id } = selected[next++]!;
        const options: UnitOptions = {
          corpusRoot,
          outputRoot,
          id,
          resources: byPackage.get(id) ?? [],
          patchesRoot,
          converter: importer,
        };
        const result = reportOnly ? await reportUnit(options) : await convertUnit(options);
        let progress: string;
        if (typeof result === "string") progress = `report ${result}`;
        else if (!result.converted) {
          failures.set(id, result.failure);
          progress = `FAILED at ${result.failure.stage}, previous output kept: ${result.failure.message}`;
        } else {
          const { record } = result;
          records.set(id, record);
          progress = `exit ${record.exitCode}, ${record.linkedMedia + record.linkedResourceMedia} media linked, ${record.patches.length} patches, report ${result.report}`;
        }
        process.stderr.write(`${++done}/${selected.length} ${id}: ${progress}\n`);
      }
    }),
  );
  await rm(path.join(outputRoot, STAGING), { recursive: true, force: true });
  if (failures.size > 0) process.exitCode = 1;
  const summaryPath = path.join(outputRoot, ".conversion-summary.json");
  if (reportOnly) {
    if (only === null) {
      // EVIDENCE: this tool writes the summary file as one JSON object of counts.
      const summary = JSON.parse(await readFile(summaryPath, "utf8")) as Record<string, unknown>;
      const reported = {
        ...summary,
        importerCommit: importer,
        measuredAt: new Date().toISOString(),
      };
      await writeFile(summaryPath, `${JSON.stringify(reported, null, 2)}\n`);
    }
    return;
  }
  const unattached = resourcePacks.filter(
    (pack) => !targets.some((target) => target.pack === pack && target.packages.length > 0),
  );
  const summary = {
    importerCommit: importer,
    measuredAt: new Date().toISOString(),
    scriptPackages: scriptPackages.length,
    converted: records.size,
    withConverterErrors: [...records.values()].filter((record) => record.exitCode !== 0).length,
    resourcePacks: resourcePacks.length,
    unattachedResourcePacks: unattached,
    collisions: [...records.values()].reduce((sum, record) => sum + record.collisions.length, 0),
    patched: [...records.values()].filter((record) => record.patches.length > 0).length,
    failed: Object.fromEntries(failures),
  };
  if (only === null) await writeFile(summaryPath, `${JSON.stringify(summary, null, 2)}\n`);
  process.stderr.write(`${JSON.stringify(summary, null, 2)}\n`);
}

/** Converts one unit in a staging folder and replaces its published output only when every step succeeded. */
export async function convertUnit(options: UnitOptions): Promise<UnitResult> {
  const { id } = options;
  const corpusRoot = path.resolve(options.corpusRoot);
  const outputRoot = path.resolve(options.outputRoot);
  const stage = path.join(outputRoot, STAGING, id);
  const packageRoot = path.join(stage, "package");
  const published = path.join(outputRoot, id);
  await rm(stage, { recursive: true, force: true });
  let step = "patches";
  try {
    const patches = await readUnitPatches(options.patchesRoot, id);
    step = "source patch";
    const unitRoot = await patchedUnit(corpusRoot, id, stage, patches);
    step = "conversion";
    await mkdir(packageRoot, { recursive: true });
    const { exitCode, stderr } = await run(process.execPath, [
      cliPath,
      "convert-package",
      path.join(unitRoot, "scripts"),
      packageRoot,
    ]);
    // Exit code 1 also means converted with TODOs; without the closing line, the converter itself failed.
    if (!/^Converted \d+ SexScript source file/mu.test(stderr))
      throw new Error(stderr.trim().split("\n").slice(-5).join("\n") || `exit ${exitCode}`);
    await writeFile(
      path.join(packageRoot, ".conversion.log"),
      stderr.replaceAll(packageRoot, published).replaceAll(unitRoot, path.join(corpusRoot, id)),
    );
    step = "media";
    const media = await linkMedia(corpusRoot, id, packageRoot, options.resources);
    step = "output patch";
    if (patches !== null) await applyOutputPatches(packageRoot, patches);
    step = "report";
    const report = await unitReport(unitRoot, packageRoot);
    const record: ConversionRecord = {
      source: path.join(corpusRoot, id),
      converter: options.converter,
      inputs: await inputHashes(corpusRoot, id),
      patches:
        patches === null
          ? []
          : patches.patches.map(({ id: patchId, layer }) => ({
              id: patchId,
              layer,
              sha256: patches.hashes.get(patchId)!,
            })),
      exitCode,
      ...media,
    };
    await writeFile(path.join(packageRoot, ".report.json"), `${JSON.stringify(report.json)}\n`);
    await writeFile(
      path.join(packageRoot, ".conversion.json"),
      `${JSON.stringify(record, null, 2)}\n`,
    );
    step = "replacement";
    const previous = path.join(stage, "previous");
    const hadPrevious = (await stat(published).catch(() => null)) !== null;
    if (hadPrevious) await rename(published, previous);
    try {
      await rename(packageRoot, published);
    } catch (error) {
      if (hadPrevious) await rename(previous, published);
      throw error;
    }
    await rm(failurePath(outputRoot, id), { force: true });
    return { converted: true, record, report: report.ok ? "ok" : "failed" };
  } catch (error) {
    return { converted: false, failure: await recordFailure(outputRoot, id, step, error) };
  } finally {
    // The staging folder holds generated text and links, and after a replacement the previous output.
    await rm(stage, { recursive: true, force: true });
  }
}

/**
 * Writes a new `.report.json` for a unit already converted, from its patched sources and its package as written;
 * on a failure, the previous report stays.
 */
export async function reportUnit(options: UnitOptions): Promise<UnitResult | "ok" | "failed"> {
  const { id } = options;
  const corpusRoot = path.resolve(options.corpusRoot);
  const outputRoot = path.resolve(options.outputRoot);
  const stage = path.join(outputRoot, STAGING, id);
  await rm(stage, { recursive: true, force: true });
  let step = "patches";
  try {
    const patches = await readUnitPatches(options.patchesRoot, id);
    step = "source patch";
    const unitRoot = await patchedUnit(corpusRoot, id, stage, patches);
    step = "report";
    const published = path.join(outputRoot, id);
    const report = await unitReport(unitRoot, published);
    const temporary = path.join(published, ".report.json.tmp");
    await writeFile(temporary, `${JSON.stringify(report.json)}\n`);
    await rename(temporary, path.join(published, ".report.json"));
    return report.ok ? "ok" : "failed";
  } catch (error) {
    return { converted: false, failure: await recordFailure(outputRoot, id, step, error) };
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
}

/**
 * The unit folder to convert: the corpus unit itself, or with source patches a staged copy whose media are hard links
 * and whose patched files are copies of their own.
 */
async function patchedUnit(
  corpusRoot: string,
  id: string,
  stage: string,
  patches: UnitPatches | null,
): Promise<string> {
  const original = path.join(corpusRoot, id);
  const diffs = (patches?.patches ?? []).filter((patch) => patch.layer === "source");
  if (patches === null || diffs.length === 0) return original;
  const staged = path.join(stage, "source", id);
  await mkdir(path.dirname(staged), { recursive: true });
  const copied = await run("cp", ["-al", original, staged]);
  if (copied.exitCode !== 0) throw new Error(`cannot stage ${original}: ${copied.stderr.trim()}`);
  for (const patch of diffs) {
    const diff = await readFile(path.join(patches.folder, patch.diff), "utf8");
    for (const file of sourcePatchPaths(diff, patch.diff)) {
      const target = path.join(staged, file);
      if ((await stat(target).catch(() => null)) === null) continue;
      await rm(target);
      await copyFile(path.join(original, file), target);
    }
  }
  await applySourcePatches(staged, patches);
  return staged;
}

/** Hard-links a unit's media and the resource-pack files it names into its package; renders MIDI files to MP3. */
async function linkMedia(
  corpusRoot: string,
  id: string,
  packageRoot: string,
  resources: readonly ResourceFileTarget[],
): Promise<
  Pick<ConversionRecord, "linkedMedia" | "linkedResourceMedia" | "collisions" | "resourcePacks">
> {
  const collisions: string[] = [];
  let linkedMedia = 0;
  for (const media of MEDIA_FOLDERS) {
    const root = await mediaRoot(corpusRoot, id, media);
    for (const file of (await files(root)).filter((file) => !isGroovy(file))) {
      const relative = toPosix(path.relative(root, file));
      // The converter names a MIDI file's MP3, which the package holds instead (owner decision 2026-10-05).
      const result = /\.midi?$/iu.test(file)
        ? await renderMidi(file, path.join(packageRoot, relative.replace(/\.midi?$/iu, ".mp3")))
        : await hardLink(file, path.join(packageRoot, relative));
      if (result === "linked") linkedMedia += 1;
      else if (result === "taken") collisions.push(relative);
    }
  }
  let linkedResourceMedia = 0;
  const packs = new Set<string>();
  for (const resource of resources) {
    const result = await hardLink(resource.source, path.join(packageRoot, resource.relative));
    if (result === "linked") {
      linkedResourceMedia += 1;
      packs.add(resource.pack);
    } else if (result === "taken") collisions.push(`${resource.pack}: ${resource.relative}`);
  }
  return { linkedMedia, linkedResourceMedia, collisions, resourcePacks: [...packs].sort() };
}

/**
 * The importer's report of a unit's sources, with compiler checks and smoke runs, and with `finalPackage` checking
 * the package as written; on failure, the error instead.
 */
async function unitReport(
  unitRoot: string,
  packageRoot: string,
): Promise<{ json: Record<string, unknown>; ok: boolean }> {
  const { exitCode, stdout, stderr } = await run(process.execPath, [
    cliPath,
    "report",
    "--run",
    "--package",
    packageRoot,
    path.join(unitRoot, "scripts"),
  ]);
  let report: Record<string, unknown> | null;
  try {
    const parsed: unknown = exitCode === 0 ? JSON.parse(stdout) : null;
    report = isRecordValue(parsed) ? parsed : null;
  } catch {
    report = null;
  }
  return report === null
    ? { json: { error: stderr.slice(-2000) || `exit ${exitCode}` }, ok: false }
    : { json: report, ok: true };
}

/** SHA-256 of each legacy script of a unit, by its path from the unit folder. */
async function inputHashes(corpusRoot: string, id: string): Promise<Record<string, string>> {
  const unitRoot = path.join(corpusRoot, id);
  const hashes: Record<string, string> = {};
  for (const file of await unitScripts(corpusRoot, id))
    hashes[toPosix(path.relative(unitRoot, file))] = sha256(await readFile(file));
  return hashes;
}

/** The Groovy scripts of a unit, outside its media folders. */
async function unitScripts(corpusRoot: string, id: string): Promise<string[]> {
  const mediaRoots = await Promise.all(
    MEDIA_FOLDERS.map((media) => mediaRoot(corpusRoot, id, media)),
  );
  return (await files(path.join(corpusRoot, id, "scripts"))).filter(
    (file) => isGroovy(file) && !mediaRoots.some((root) => file.startsWith(`${root}${path.sep}`)),
  );
}

function failurePath(outputRoot: string, id: string): string {
  return path.join(outputRoot, FAILURES, `${id}.json`);
}

/** Records why a unit kept its previous output in `.failures/<unit>.json`. */
async function recordFailure(
  outputRoot: string,
  id: string,
  stage: string,
  error: unknown,
): Promise<UnitFailure> {
  const failure: UnitFailure = {
    stage,
    message: error instanceof Error ? error.message : String(error),
  };
  await mkdir(path.join(outputRoot, FAILURES), { recursive: true });
  await writeFile(
    failurePath(outputRoot, id),
    `${JSON.stringify({ unit: id, ...failure, at: new Date().toISOString() }, null, 2)}\n`,
  );
  return failure;
}

/**
 * A package's media folder: `images/` or `sounds/` inside its scripts folder in the merged layout, where the scripts
 * folder is the legacy data folder, and else beside it.
 */
async function mediaRoot(corpusRoot: string, id: string, media: string): Promise<string> {
  const inside = path.join(corpusRoot, id, "scripts", media);
  const found = await stat(inside).catch(() => null);
  return found?.isDirectory() === true ? inside : path.join(corpusRoot, id, media);
}

/**
 * Renders a MIDI file to an MP3 at `target` with fluidsynth and ffmpeg, unless the MP3 is there already; "taken"
 * when another file holds the path, and "failed" when a tool is missing or fails.
 */
async function renderMidi(source: string, target: string): Promise<"linked" | "taken" | "failed"> {
  if ((await stat(target).catch(() => null)) !== null) return "taken";
  const soundfont = (
    await Promise.all(
      SOUNDFONTS.map(async (file) => ((await stat(file).catch(() => null)) === null ? null : file)),
    )
  ).find((file) => file !== null);
  if (soundfont === undefined) return "failed";
  await mkdir(path.dirname(target), { recursive: true });
  const wave = path.join(tmpdir(), `sexscript-midi-${process.pid}-${Date.now()}.wav`);
  try {
    const rendered = await run("fluidsynth", [
      "-ni",
      "-q",
      "-g",
      "0.8",
      "-F",
      wave,
      "-r",
      "44100",
      soundfont,
      source,
    ]);
    if (rendered.exitCode !== 0) return "failed";
    const temporary = `${target}.tmp.mp3`;
    const encoded = await run("ffmpeg", [
      "-v",
      "error",
      "-y",
      "-i",
      wave,
      "-codec:a",
      "libmp3lame",
      "-qscale:a",
      "4",
      temporary,
    ]);
    if (encoded.exitCode !== 0) return "failed";
    await rename(temporary, target);
    return "linked";
  } finally {
    await rm(wave, { force: true });
  }
}

/** The last commit of the importer's conversion code, marked `-modified` when it has uncommitted changes. */
async function importerVersion(): Promise<string> {
  const importerRoot = fileURLToPath(new URL("..", import.meta.url));
  const vcs = (args: string[]) =>
    new Promise<string>((resolve) =>
      execFile("git", args, { cwd: importerRoot }, (error, stdout) =>
        resolve(error === null ? stdout.trim() : ""),
      ),
    );
  const commit = await vcs(["log", "-1", "--format=%h", "--", "src"]);
  const modified = await vcs(["status", "--porcelain", "--", "src"]);
  return commit === "" ? "unknown" : `${commit}${modified === "" ? "" : "-modified"}`;
}

/**
 * The script packages each resource-pack file is linked into. A pack extends legacy media folders, such as
 * `images/DCAfterDark/Chanta/`: a file goes to every script package whose source names its top folder as a path
 * (`"DCAfterDark/`) or as a quoted name (`"DCAfterDark"`, for paths built from it), narrowed to the packages that also
 * name its second-level entry (`DCAfterDark/Chanta`) when any do. A file directly in the media folder goes to the packages that name it. Matching ignores case, as the legacy
 * Windows player did. `sources` holds each script package's lower-case Groovy text.
 */
export function resourcePackTargets(
  packFiles: ReadonlyArray<{ pack: string; source: string; relative: string }>,
  sources: ReadonlyMap<string, string>,
): ResourceFileTarget[] {
  // Keyed by the lower-case path prefix: the packages that name it.
  const cache = new Map<string, string[]>();
  const naming = (key: string, pattern: string, among: readonly string[]): string[] => {
    let result = cache.get(key);
    if (result === undefined) {
      const regex = new RegExp(`(?:^|["'/\\\\])${pattern}`, "mu");
      result = among.filter((id) => regex.test(sources.get(id)!));
      cache.set(key, result);
    }
    return result;
  };
  const all = [...sources.keys()];
  return packFiles.map(({ pack, source, relative }) => {
    // EVIDENCE: split() returns at least one element, so the first is a string.
    const [first, second] = relative.toLowerCase().split("/") as [string, string | undefined];
    let packages: string[];
    if (second === undefined) packages = naming(first, `${escapeRegex(first)}(?![\\w.-])`, all);
    else {
      const top = naming(`${first}/`, `${escapeRegex(first)}(?:[/\\\\]|["'])`, all);
      const named = naming(
        `${first}/${second}`,
        `${escapeRegex(first)}[/\\\\]${escapeRegex(second)}(?![\\w.-])`,
        top,
      );
      packages = named.length > 0 ? named : top;
    }
    return { pack, source, relative, packages };
  });
}

/**
 * Hard-links `source` as `target`: `same` when `target` already is that file (the corpus links identical content),
 * `taken` when it is another file.
 */
async function hardLink(source: string, target: string): Promise<"linked" | "same" | "taken"> {
  await mkdir(path.dirname(target), { recursive: true });
  try {
    await link(source, target);
    return "linked";
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
    const [existing, wanted] = await Promise.all([stat(target), stat(source)]);
    return existing.ino === wanted.ino && existing.dev === wanted.dev ? "same" : "taken";
  }
}

function run(
  command: string,
  args: string[],
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(command, args, { maxBuffer: 256 * 1024 * 1024 }, (error, stdout, stderr) => {
      const code = error === null ? 0 : typeof error.code === "number" ? error.code : 1;
      resolve({
        exitCode: code,
        stdout,
        stderr: error !== null && stderr === "" ? String(error) : stderr,
      });
    });
  });
}

/** The non-hidden subfolders of `root`, sorted. */
async function folders(root: string): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
    .map((entry) => entry.name)
    .sort();
}

/** The regular files below `root`, sorted; none when it does not exist. */
async function files(root: string): Promise<string[]> {
  const entries = await readdir(root, { recursive: true, withFileTypes: true }).catch(() => []);
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => path.join(entry.parentPath, entry.name))
    .sort();
}

async function hasFiles(root: string): Promise<boolean> {
  return (await files(root)).length > 0;
}

function isGroovy(file: string): boolean {
  return file.toLowerCase().endsWith(".groovy");
}

function toPosix(relative: string): string {
  return relative.split(path.sep).join("/");
}

function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function isRecordValue(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
