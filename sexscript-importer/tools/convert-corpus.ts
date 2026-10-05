/**
 * Converts every script package of an organized legacy corpus (one folder per package, each with `scripts/`,
 * `images/`, and `sounds/`) into a root of TeaseScript packages that the playground server offers with
 * `PLAYGROUND_PACKAGES`.
 *
 * Usage: node tools/convert-corpus.ts [--jobs N] [--only id,id] [--report-only] <corpus-root> <converted-root>
 *
 * Each package is converted by `src/cli.ts convert-package`, and `src/cli.ts report --run` writes its report to
 * `.report.json` in the package folder; `--report-only` writes only the reports of packages already converted. Legacy scripts name images relative to `images/` and
 * sounds relative to `sounds/`, while a TeaseScript package names its files from the package root (ADR 0022), so both
 * media trees are hard-linked into the package root. Resource packs (folders without scripts) are linked into the
 * script packages that name their media folders (see `resourcePackTargets`). Links are hard links, never copies.
 */
import { execFile } from "node:child_process";
import { link, mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const MEDIA_FOLDERS = ["images", "sounds"] as const;
const cliPath = fileURLToPath(new URL("../src/cli.ts", import.meta.url));

/** One file of a resource pack, by its path from the pack's media folder, with the packages it is linked into. */
export interface ResourceFileTarget {
  readonly pack: string;
  readonly source: string;
  readonly relative: string;
  readonly packages: readonly string[];
}

/** What the conversion of one package did; written as `.conversion.json` in the package folder. */
interface ConversionRecord {
  readonly source: string;
  readonly exitCode: number;
  /** The lone script was renamed to `main.tease`: convert-package writes none for a one-file package. */
  readonly mainRenamed: string | null;
  readonly linkedMedia: number;
  readonly linkedResourceMedia: number;
  /** Media paths another file already took; the package's own file, or the first pack's, wins. */
  readonly collisions: readonly string[];
  readonly resourcePacks: readonly string[];
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main(process.argv.slice(2));

async function main(rawArgs: string[]): Promise<void> {
  let jobs = 3;
  let only: Set<string> | null = null;
  let reportOnly = false;
  const args: string[] = [];
  for (let index = 0; index < rawArgs.length; index += 1) {
    const arg = rawArgs[index]!;
    if (arg === "--jobs") jobs = Number(rawArgs[++index]);
    else if (arg === "--only") only = new Set(rawArgs[++index]!.split(","));
    else if (arg === "--report-only") reportOnly = true;
    else args.push(arg);
  }
  if (args.length !== 2 || !Number.isInteger(jobs) || jobs < 1) {
    process.stderr.write(
      "Usage: node tools/convert-corpus.ts [--jobs N] [--only id,id] [--report-only] <corpus-root> <converted-root>\n",
    );
    process.exit(2);
  }
  const corpusRoot = path.resolve(args[0]!);
  const outputRoot = path.resolve(args[1]!);
  const scriptPackages: Array<{ id: string; scripts: string[] }> = [];
  const resourcePacks: string[] = [];
  for (const id of await folders(corpusRoot)) {
    const scripts = (await files(path.join(corpusRoot, id, "scripts"))).filter(isGroovy);
    if (scripts.length > 0) scriptPackages.push({ id, scripts });
    else if (
      (await Promise.all(MEDIA_FOLDERS.map((m) => hasFiles(path.join(corpusRoot, id, m))))).some(
        Boolean,
      )
    )
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
      const root = path.join(corpusRoot, pack, media);
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
  let next = 0;
  let done = 0;
  await Promise.all(
    Array.from({ length: Math.min(jobs, selected.length) }, async () => {
      while (next < selected.length) {
        const { id } = selected[next++]!;
        let progress = "";
        if (!reportOnly) {
          const record = await convertOne(corpusRoot, outputRoot, id, byPackage.get(id) ?? []);
          records.set(id, record);
          progress = `exit ${record.exitCode}, ${record.linkedMedia + record.linkedResourceMedia} media linked, `;
        }
        progress += `report ${await reportOne(corpusRoot, outputRoot, id)}`;
        process.stderr.write(`${++done}/${selected.length} ${id}: ${progress}\n`);
      }
    }),
  );
  const summaryPath = path.join(outputRoot, ".conversion-summary.json");
  if (reportOnly) {
    if (only === null) {
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
    mainRenamed: [...records.values()].filter((record) => record.mainRenamed !== null).length,
    resourcePacks: resourcePacks.length,
    unattachedResourcePacks: unattached,
    collisions: [...records.values()].reduce((sum, record) => sum + record.collisions.length, 0),
  };
  if (only === null) await writeFile(summaryPath, `${JSON.stringify(summary, null, 2)}\n`);
  process.stderr.write(`${JSON.stringify(summary, null, 2)}\n`);
}

async function convertOne(
  corpusRoot: string,
  outputRoot: string,
  id: string,
  resources: readonly ResourceFileTarget[],
): Promise<ConversionRecord> {
  const packageRoot = path.join(outputRoot, id);
  // Removing the folder removes only generated text and links; the corpus keeps its media.
  await rm(packageRoot, { recursive: true, force: true });
  await mkdir(packageRoot, { recursive: true });
  const { exitCode, stderr } = await run(process.execPath, [
    cliPath,
    "convert-package",
    path.join(corpusRoot, id, "scripts"),
    packageRoot,
  ]);
  await writeFile(path.join(packageRoot, ".conversion.log"), stderr);

  let mainRenamed: string | null = null;
  const tease = (await files(packageRoot)).filter((file) => file.endsWith(".tease"));
  if (tease.length === 1 && path.basename(tease[0]!) !== "main.tease") {
    mainRenamed = toPosix(path.relative(packageRoot, tease[0]!));
    await rename(tease[0]!, path.join(packageRoot, "main.tease"));
  }

  const collisions: string[] = [];
  let linkedMedia = 0;
  for (const media of MEDIA_FOLDERS) {
    const root = path.join(corpusRoot, id, media);
    for (const file of (await files(root)).filter((file) => !isGroovy(file))) {
      const relative = toPosix(path.relative(root, file));
      const result = await hardLink(file, path.join(packageRoot, relative));
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
  const record: ConversionRecord = {
    source: path.join(corpusRoot, id),
    exitCode,
    mainRenamed,
    linkedMedia,
    linkedResourceMedia,
    collisions,
    resourcePacks: [...packs].sort(),
  };
  await writeFile(
    path.join(packageRoot, ".conversion.json"),
    `${JSON.stringify(record, null, 2)}\n`,
  );
  return record;
}

/**
 * Writes the importer's report of a package, with compiler checks and smoke runs, as `.report.json`; on failure, the
 * error instead. Returns `ok` or `failed`.
 */
async function reportOne(corpusRoot: string, outputRoot: string, id: string): Promise<string> {
  const { exitCode, stdout, stderr } = await run(process.execPath, [
    cliPath,
    "report",
    "--run",
    path.join(corpusRoot, id, "scripts"),
  ]);
  let report: unknown;
  try {
    report = exitCode === 0 ? JSON.parse(stdout) : null;
  } catch {
    report = null;
  }
  const result = report ?? { error: stderr.slice(-2000) || `exit ${exitCode}` };
  await writeFile(path.join(outputRoot, id, ".report.json"), `${JSON.stringify(result)}\n`);
  return report === null ? "failed" : "ok";
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
