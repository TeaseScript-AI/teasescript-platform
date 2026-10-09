/**
 * Writes one HTML page that lists every package of a root of converted packages (see `convert-corpus.ts`), each title
 * opening the package in the TeaseScript Player, and hard-links the packages' legacy Groovy and converted `.tease`
 * files next to it under `source/`, for `serve-catalog.ts` to show as plain text.
 *
 * Usage: node tools/catalog.ts [--player <origin>] [--build <repository>] [--play-checks <dir>]... [--explorer <dir>]...
 *   [--verified <dir>] [--approved <file>] <converted-root> <output.html>
 *
 * `--player https://host:port` makes the Player links absolute, for a page served from another origin than the
 * Player; without it they are `/player/?package=<id>`. A package is read and compiled as the Player does: the
 * playground server's package scan, then the real compiler's `compileProject` with the package images, from the
 * build (`npm run build`) of this repository or of the checkout `--build` names, such as the served Player's. The status comes from, in this order: the owner-approved list (`--approved`, a Markdown table
 * whose first column names the package), the frozen verified copies (`--verified`, which replace the converted
 * package in the list), the Player checks of `play-check.ts` (`--play-checks`) for the package's current `.tease`
 * files, and otherwise the compiler and the importer's report in `.report.json`. A verified copy is offered beside
 * the unit's latest conversion, which `serve-catalog.ts` serves under the package id `latest~<id>`. The Explorer column
 * shows the latest report of `explore.ts` (`--explorer`, folders of `<unit>.json` or `<unit>/<unit>.json`) for the
 * package's current files, or for a verified copy of the latest conversion, else its latest report of other files,
 * marked stale.
 */
import { createHash } from "node:crypto";
import { copyFile, link, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { isRecord } from "../src/ast.ts";

export interface CatalogEntry {
  readonly id: string;
  readonly title: string;
  readonly author: string | null;
  readonly description: string | null;
  readonly keywords: readonly string[];
  readonly compiles: boolean;
  /** Where the listed package comes from: the converted root, or its frozen verified copy. */
  readonly origin: "converted" | "verified";
  /** Whether the title links to the Player; a unit marked as an unfinished stub is listed but not offered. */
  readonly playable: boolean;
  readonly status: Status;
  /** Set when the importer left parts unconverted. */
  readonly partial: Status | null;
  /**
   * The Player check of an older conversion of a converted package whose current files have none; the status column
   * shows it greyed, and the summary counts it apart.
   */
  readonly older: Status | null;
  /** Legacy Groovy files, from the package's `scripts/` folder, and converted `.tease` files, by relative path. */
  readonly groovy: SourceFiles;
  readonly tease: SourceFiles;
  /** For a verified copy, the unit's latest conversion, which the page offers to play and read as well. */
  readonly latest: SourceFiles | null;
  /** Earlier versions of the tease that the importer keeps out of the package, from the unit's `unit.json`. */
  readonly earlier: readonly EarlierVersion[];
  readonly images: number;
  readonly audio: number;
  /**
   * The latest explorer report of the listed files; for a verified copy, else of the unit's current conversion, which
   * the explorer explores; else the latest report of other files, which is stale.
   */
  readonly explored: {
    readonly report: ExplorerReport;
    readonly of: "listed" | "conversion" | "stale";
  } | null;
}

export interface Status {
  readonly kind:
    | "approved"
    | "verified"
    | "plays"
    | "stops"
    | "nostart"
    | "unbuilt"
    | "compiles"
    | "error"
    | "partial"
    | "stub"
    | "parked";
  /** A few words for the table. */
  readonly label: string;
  readonly detail: string;
}

export interface EarlierVersion {
  readonly title: string;
  readonly status: string | null;
  readonly date: string | null;
  /** Why the version is kept apart, when the unit says. */
  readonly note: string | null;
  /** The version's original Groovy files: where they are, and the path they are shown under. */
  readonly files: ReadonlyArray<{ readonly source: string; readonly name: string }>;
}

interface SourceFiles {
  readonly root: string | null;
  readonly paths: readonly string[];
}

interface ScriptHeader {
  readonly title: string | null;
  readonly author: string | null;
  readonly description: string | null;
  readonly tags: ReadonlyArray<{ readonly name: string }>;
  readonly keywords: readonly string[];
}

interface PackageScan {
  readonly images: ReadonlyArray<{ readonly path: string; readonly keywords: readonly string[] }>;
  readonly media: readonly string[];
  readonly sources: ReadonlyArray<{ readonly path: string; readonly source: string }>;
}

interface Diagnostic {
  readonly path: string;
  readonly severity: string;
  readonly code: string;
  readonly message: string;
  readonly span?: { readonly start?: { readonly line: number; readonly column: number } };
}

/** The parts of the repository build the catalog uses: the server's package scan and the project compiler. */
export interface CatalogTools {
  scan(folder: string): Promise<PackageScan>;
  compile(
    sources: PackageScan["sources"],
    images: PackageScan["images"],
  ): {
    readonly plan: unknown;
    readonly files: ReadonlyArray<{ readonly path: string; readonly header: ScriptHeader | null }>;
    readonly diagnostics: readonly Diagnostic[];
  };
}

/** The fields of the importer's report (`report --run`) the status uses. */
interface ImporterReport {
  readonly fileCount?: number;
  readonly migrationCleanFileCount?: number;
  readonly projectCompiles?: boolean | null;
  readonly pendingCapabilityFileCounts?: Readonly<Record<string, number>>;
  readonly smokeRuns?: ReadonlyArray<{
    readonly entry: string;
    readonly isolated: boolean;
    readonly status: string;
    readonly failure: {
      readonly code: string;
      readonly message: string;
      readonly line: number | null;
      readonly script: string;
    } | null;
    readonly blockedTarget: string | null;
    readonly steps: number;
  }>;
}

/** The fields of a `play-check.ts` result the status uses. */
export interface PlayCheck {
  readonly contentHash: string;
  readonly verdict: "plays" | "stops" | "no-start" | "parked";
  /** The step limit of its runs; 300 before checks recorded it. */
  readonly stepLimit: number;
  readonly checkedAt: string;
  readonly runs: ReadonlyArray<{
    readonly stop: {
      readonly kind: string;
      readonly detail: string;
      readonly where: string | null;
    };
  }>;
  readonly coverage: {
    readonly files: readonly string[];
    readonly fileCount: number;
    readonly sites: number;
    readonly siteCount: number;
    readonly choices: number;
  };
  readonly missingImages: readonly string[];
  readonly missingMedia: readonly string[];
  readonly rawMarkup: readonly string[];
}

/**
 * The fields of a headless `explore.ts` report the Explorer column uses. A report's `catalog` block, when present, is
 * read first: `{ coveragePercent, crashes, traps, firstCrash: { code, path, line, message, chosen? } | null, firstTrap:
 * { location } | null, reach }`, the counts as numbers and `reach` the number of lines per reach label; a field it
 * lacks comes from the full report, except `reach`, which only the block gives.
 */
export interface ExplorerReport {
  readonly contentHash: string;
  readonly exploredAt: string;
  readonly explorer: string | null;
  readonly budgetSeconds: number | null;
  /** The work budget in runtime operations, or null without one. */
  readonly budgetOps: number | null;
  /** False when the unit did not compile and was not explored. */
  readonly compiles: boolean;
  /** Why the search stopped: `budget` (time), `operations` (work), `maxStates`, or `exhausted` at every state. */
  readonly stoppedBy: string | null;
  readonly states: number | null;
  /** Runtime operations that threw: an explorer or runtime problem, not a script failure. */
  readonly engineErrors: number;
  readonly endStates: {
    readonly completed: number;
    readonly failed: number;
    readonly stuck: number;
    readonly open: number;
  } | null;
  readonly coverage: {
    readonly percent: number;
    readonly visited: number | null;
    readonly coverable: number | null;
  } | null;
  readonly crashes: number;
  readonly traps: number;
  readonly firstCrash: {
    readonly code: string;
    readonly where: string | null;
    readonly message: string;
    /** True when only play with chosen random outcomes reached it. */
    readonly chosen?: boolean;
  } | null;
  readonly firstTrap: { readonly kind: string | null; readonly where: string | null } | null;
  /** Lines per reach label of `src/explorer.ts`, such as `play` or `unreachable`, when the catalog block gives them. */
  readonly reach: Readonly<Record<string, number>> | null;
}

/** Where the status beyond the compiler comes from; see the module comment. */
export interface StatusSources {
  /** Folders of `play-check.ts` results; for each package the latest check of its current files counts. */
  readonly playChecks?: readonly string[];
  /** Folders of `explore.ts` reports; for each package the latest report of its current files counts. */
  readonly explorer?: readonly string[];
  readonly verified?: string;
  readonly approved?: ReadonlySet<string>;
}

const MAIN = "main.tease";
const AUDIO_EXTENSIONS = new Set([".mp3", ".wav", ".ogg"]);
const PIN_STORAGE_KEY = "sexscript-catalog-pins";
/** The package id prefix under which `serve-catalog.ts` offers the latest conversion of a package with a verified copy. */
export const LATEST_PREFIX = "latest~";
/** How the explorer's reach labels read in the Explorer details; see `Reach` in `src/explorer.ts`. */
const REACH_LABELS: Readonly<Record<string, string>> = {
  play: "reached by play",
  chosen: "reached by play with chosen random outcomes",
  seededState: "reached only from a prepared state",
  unreachable: "proven unreachable",
  unknown: "of unknown reach",
};

if (process.argv[1] === fileURLToPath(import.meta.url)) await main(process.argv.slice(2));

async function main(rawArgs: string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args: rawArgs,
    allowPositionals: true,
    options: {
      player: { type: "string", default: "" },
      build: { type: "string" },
      "play-checks": { type: "string", multiple: true },
      explorer: { type: "string", multiple: true },
      verified: { type: "string" },
      approved: { type: "string" },
    },
  });
  if (positionals.length !== 2) {
    process.stderr.write(
      "Usage: node tools/catalog.ts [--player <origin>] [--build <repository>] [--play-checks <dir>]... [--explorer <dir>]... [--verified <dir>] [--approved <file>] <converted-root> <output.html>\n",
    );
    process.exit(2);
  }
  const playerOrigin = values.player.replace(/\/+$/u, "");
  const root = path.resolve(positionals[0]!);
  const output = path.resolve(positionals[1]!);
  const approved =
    values.approved === undefined
      ? new Set<string>()
      : approvedPackages(await readFile(values.approved, "utf8").catch(() => ""));
  const entries = await readCatalogEntries(root, await loadRepositoryCatalogTools(values.build), {
    ...(values["play-checks"] === undefined
      ? {}
      : { playChecks: values["play-checks"].map((folder) => path.resolve(folder)) }),
    ...(values.explorer === undefined
      ? {}
      : { explorer: values.explorer.map((folder) => path.resolve(folder)) }),
    ...(values.verified === undefined ? {} : { verified: path.resolve(values.verified) }),
    approved,
  });
  await mkdir(path.dirname(output), { recursive: true });
  await writeSourceViews(entries, path.dirname(output));
  await writeFile(
    output,
    renderCatalogPage(entries, { playerOrigin, updatedAt: new Date().toISOString() }),
    "utf8",
  );
  const counts = new Map<string, number>();
  for (const entry of entries)
    counts.set(entry.status.kind, (counts.get(entry.status.kind) ?? 0) + 1);
  process.stderr.write(
    `Listed ${entries.length} packages in ${output}: ${[...counts].map(([kind, count]) => `${count} ${kind}`).join(", ")}.\n`,
  );
}

/** The first column of each data row of a Markdown table: the owner-approved packages. */
export function approvedPackages(markdown: string): Set<string> {
  const rows = markdown.split("\n").filter((line) => line.trim().startsWith("|"));
  return new Set(
    rows
      .slice(2)
      .map((row) => row.split("|")[1]?.trim().replace(/^`|`$/gu, "") ?? "")
      .filter((id) => id !== ""),
  );
}

/** A digest of a package's `.tease` files, by path and text; a Player check of other contents is stale. */
export function packageContentHash(
  sources: ReadonlyArray<{ readonly path: string; readonly source: string }>,
): string {
  const hash = createHash("sha256");
  for (const { path: filePath, source } of [...sources].sort((left, right) =>
    left.path < right.path ? -1 : left.path > right.path ? 1 : 0,
  ))
    hash.update(`${filePath}\0${source}\0`);
  return hash.digest("hex");
}

/**
 * Loads the playground server's package scan and the compiler from the build (`npm run build`) of the repository
 * checkout `repository`, by default this one.
 */
export async function loadRepositoryCatalogTools(repository?: string): Promise<CatalogTools> {
  const distRoot =
    repository === undefined
      ? new URL("../../dist/", import.meta.url)
      : pathToFileURL(`${path.resolve(repository, "dist")}/`);
  let folderModule: Record<string, unknown>;
  let compilerModule: Record<string, unknown>;
  try {
    [folderModule, compilerModule] = await Promise.all([
      import(new URL("playground/package-folder.js", distRoot).href),
      import(new URL("src/index.js", distRoot).href),
    ]);
  } catch (error) {
    throw new Error(
      `Repository build not found under ${fileURLToPath(distRoot)}; run "npm run build:typescript" in the repository root.`,
      { cause: error },
    );
  }
  const PackageFolder = folderModule.PackageFolder;
  const compileProject = compilerModule.compileProject;
  if (typeof PackageFolder !== "function" || typeof compileProject !== "function")
    throw new Error("The repository build does not export PackageFolder and compileProject().");
  type Folder = { scan(): Promise<PackageScan> };
  // Both were checked to be functions above.
  // EVIDENCE: the build's PackageFolder (src/player/package-folder.ts) is constructed with the package root.
  const Scanner = PackageFolder as new (root: string) => Folder;
  // EVIDENCE: as above, compileProject(sources, { images }) returns a ProjectCompilationResult.
  const compile = compileProject as (...args: unknown[]) => ReturnType<CatalogTools["compile"]>;
  return {
    scan: (folder) => new Scanner(folder).scan(),
    compile: (sources, images) => compile(sources, { images }),
  };
}

/** Every package folder of `root` and of the verified copies (each non-hidden subfolder), by title. */
export async function readCatalogEntries(
  root: string,
  tools: CatalogTools,
  sources: StatusSources = {},
): Promise<CatalogEntry[]> {
  const folders = async (folder: string | undefined) =>
    folder === undefined
      ? []
      : (await readdir(folder, { withFileTypes: true }).catch(() => []))
          .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
          .map((entry) => entry.name);
  const verified = new Set(await folders(sources.verified));
  const ids = [...new Set([...(await folders(root)), ...verified])];
  const entries: CatalogEntry[] = [];
  // Scanning reads every image for its XMP tags, so a few packages at a time.
  for (let start = 0; start < ids.length; start += 4)
    entries.push(
      ...(await Promise.all(
        ids
          .slice(start, start + 4)
          .map((id) =>
            readEntry(
              verified.has(id) ? sources.verified! : root,
              id,
              tools,
              sources,
              verified.has(id),
              root,
            ),
          ),
      )),
    );
  return entries.sort(
    (left, right) =>
      left.title.localeCompare(right.title, "en", { sensitivity: "base" }) ||
      left.id.localeCompare(right.id, "en"),
  );
}

async function readEntry(
  root: string,
  id: string,
  tools: CatalogTools,
  statusSources: StatusSources,
  isVerified: boolean,
  convertedRoot: string,
): Promise<CatalogEntry> {
  const folder = path.join(root, id);
  const scan = await tools.scan(folder);
  const compilation = tools.compile(scan.sources, scan.images);
  const sources = [...scan.sources].sort((left, right) =>
    left.path === MAIN ? -1 : right.path === MAIN ? 1 : 0,
  );
  const header = primaryHeader(sources, compilation.files);
  const readJson = (name: string) =>
    readFile(path.join(folder, name), "utf8").then(
      (text): Record<string, unknown> | null => {
        const value: unknown = JSON.parse(text);
        return isRecord(value) ? value : null;
      },
      () => null,
    );
  const conversion = await readJson(".conversion.json");
  // EVIDENCE: see readJson above; a failed report has only `error`, which the fields read below treat as absent.
  const report = (await readJson(".report.json")) as ImporterReport | null;
  // A frozen copy names the legacy folder of its time; when that is gone, the current conversion's counts.
  const legacyFolder = await existingFolder([
    typeof conversion?.source === "string" ? conversion.source : null,
    isVerified
      ? await readFile(path.join(convertedRoot, id, ".conversion.json"), "utf8").then(
          (text) => {
            const current: unknown = JSON.parse(text);
            return isRecord(current) && typeof current.source === "string" ? current.source : null;
          },
          () => null,
        )
      : null,
  ]);
  const groovyRoot = legacyFolder === null ? null : path.join(legacyFolder, "scripts");
  const earlier =
    legacyFolder === null
      ? []
      : await readFile(path.join(legacyFolder, "unit.json"), "utf8").then(
          (text) => earlierVersions(JSON.parse(text), legacyFolder),
          () => [],
        );
  // An earlier version's files are listed with that version, not as the package's source.
  const earlierFiles = new Set(
    earlier.flatMap((version) => version.files.map((file) => file.source)),
  );
  const groovy =
    groovyRoot === null
      ? []
      : (await readdir(groovyRoot, { recursive: true, withFileTypes: true }).catch(() => []))
          .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".groovy"))
          .filter((entry) => !earlierFiles.has(path.join(entry.parentPath, entry.name)))
          .map((entry) =>
            path
              .relative(groovyRoot, path.join(entry.parentPath, entry.name))
              .split(path.sep)
              .join("/"),
          )
          .sort();
  const hash = packageContentHash(scan.sources);
  const checks = (
    await Promise.all(
      (statusSources.playChecks ?? []).map((checksFolder) =>
        readFile(path.join(checksFolder, id, "result.json"), "utf8").then(
          (text) => parsePlayCheck(JSON.parse(text)),
          () => null,
        ),
      ),
    )
  )
    .filter((check) => check !== null)
    .sort((left, right) => right.checkedAt.localeCompare(left.checkedAt));
  // The latest check of the current files, else the latest check of any files (a newer conversion of a verified copy).
  const current = checks.find((check) => check.contentHash === hash) ?? null;
  const play = current ?? checks[0] ?? null;
  // An explorer folder holds `<unit>.json`, or `<unit>/<unit>.json` when each unit was explored into its own folder.
  const explorerReports = (
    await Promise.all(
      (statusSources.explorer ?? []).flatMap((reportsFolder) =>
        [path.join(reportsFolder, `${id}.json`), path.join(reportsFolder, id, `${id}.json`)].map(
          (file) =>
            readFile(file, "utf8").then(
              (text) => parseExplorerReport(JSON.parse(text)),
              () => null,
            ),
        ),
      ),
    )
  )
    .filter((report) => report !== null)
    .sort((left, right) => right.exploredAt.localeCompare(left.exploredAt));
  // A verified copy is frozen; the unit's latest conversion, which the explorer explores, is offered beside it.
  const latestFolder = path.join(convertedRoot, id);
  const latestSources = isVerified
    ? ((await tools.scan(latestFolder).catch(() => null))?.sources ?? [])
    : [];
  const conversionHash = latestSources.length === 0 ? null : packageContentHash(latestSources);
  const explorerReport =
    explorerReports.find((report) => report.contentHash === hash) ??
    explorerReports.find((report) => report.contentHash === conversionHash) ??
    explorerReports[0] ??
    null;
  const verifiedRecord = isVerified ? await readJson(".verified.json") : null;
  const compileStatus = packageStatus(
    sources.some((file) => file.path === MAIN),
    compilation.plan !== null,
    compilation.diagnostics,
    report,
  );
  const unitStatus = typeof conversion?.unitStatus === "string" ? conversion.unitStatus : null;
  let status: Status;
  if (unitStatus !== null && !isVerified && statusSources.approved?.has(id) !== true)
    status = {
      kind: "stub",
      label: unitStatus === "unfinished-content-stub" ? "unfinished stub" : unitStatus,
      detail: `The importer marks this unit as ${unitStatus}: the legacy package is not a finished tease, so it is listed but not offered to play.`,
    };
  else if (statusSources.approved?.has(id) === true)
    status = {
      kind: "approved",
      label: "owner-approved",
      detail: "The owner approved this package.",
    };
  else if (isVerified) {
    // A Player check of a newer conversion is of other contents than the frozen copy.
    const regression =
      play !== null && play.contentHash !== hash && play.verdict !== "plays"
        ? ` A newer conversion does not play: ${playStatus(play, null).detail}`
        : "";
    status = {
      kind: "verified",
      label: regression === "" ? "verified" : "verified, newer conversion regresses",
      detail: `Played and checked on ${String(verifiedRecord?.date ?? "?")} with importer commit ${String(verifiedRecord?.importerCommit ?? "?")}; this frozen copy is served.${regression}`,
    };
  } else
    status =
      current === null
        ? compileStatus
        : playStatus(current, compileStatus.kind === "error" ? compileStatus.detail : null);
  const olderPlay = isVerified || current !== null || play === null ? null : playStatus(play, null);
  const todos = sources.reduce(
    (sum, { source }) => sum + (source.match(/^\s*\/\/ TODO [A-Z0-9_]+ line \d+:/gmu)?.length ?? 0),
    0,
  );
  return {
    id,
    title: header?.title ?? id,
    author: header?.author ?? commentAuthor(sources),
    description: header?.description ?? null,
    keywords: [...(header?.tags.map((tag) => tag.name) ?? []), ...(header?.keywords ?? [])],
    compiles: compilation.plan !== null,
    origin: isVerified ? "verified" : "converted",
    playable: status.kind !== "stub",
    status,
    partial: partialConversion(report, sources.length, todos),
    older:
      olderPlay === null || play === null
        ? null
        : {
            kind: olderPlay.kind,
            label: `older conversion: ${olderPlay.label}`,
            detail: `Checked in the Player on ${play.checkedAt.slice(0, 10)}, on files the importer has converted again since. ${olderPlay.detail}`,
          },
    groovy: { root: groovyRoot, paths: groovy },
    earlier,
    tease: { root: folder, paths: sources.map((file) => file.path).sort() },
    latest:
      latestSources.length === 0
        ? null
        : { root: latestFolder, paths: latestSources.map((file) => file.path).sort() },
    images: scan.images.length,
    audio: scan.media.filter((file) => AUDIO_EXTENSIONS.has(path.extname(file).toLowerCase()))
      .length,
    explored:
      explorerReport === null
        ? null
        : {
            report: explorerReport,
            of:
              explorerReport.contentHash === hash
                ? "listed"
                : explorerReport.contentHash === conversionHash
                  ? "conversion"
                  : "stale",
          },
  };
}

/**
 * What happens when the package is opened, most important first: it cannot start, it needs TeaseScript commands that
 * are not built yet, it does not compile, or how the importer's smoke run from `main.tease` ended. The smoke run
 * follows one path with fixed answers and simulated time.
 */
function packageStatus(
  hasMain: boolean,
  compiles: boolean,
  diagnostics: readonly Diagnostic[],
  report: ImporterReport | null,
): Status {
  if (!hasMain)
    return {
      kind: "error",
      label: "no main.tease",
      detail: "The package has no main.tease to start.",
    };
  const pending = Object.keys(report?.pendingCapabilityFileCounts ?? {}).sort();
  if (!compiles) {
    if (report?.projectCompiles === true && pending.length > 0)
      return {
        kind: "unbuilt",
        label: `needs ${pending.join(", ")}`,
        detail: `It compiles once these TeaseScript commands are built: ${pending.join(", ")}.`,
      };
    const errors = diagnostics.filter((diagnostic) => diagnostic.severity === "error");
    const first = errors[0];
    const start = first?.span?.start;
    const where =
      start === undefined
        ? (first?.path ?? "")
        : `${first!.path}:${start.line + 1}:${start.column + 1}`;
    return {
      kind: "error",
      label: "does not compile",
      detail:
        (first === undefined
          ? "The package does not compile."
          : `${where} ${first.code} ${first.message}`) +
        (errors.length > 1 ? ` (${errors.length} errors in all)` : "") +
        (pending.length > 0 ? ` It also uses unbuilt commands: ${pending.join(", ")}.` : ""),
    };
  }
  const run = report?.smokeRuns?.find((item) => item.entry === MAIN && !item.isolated);
  if (run === undefined)
    return {
      kind: "compiles",
      label: "compiles, not played yet",
      detail: "Not played in the Player yet.",
    };
  if (run.status === "halted")
    return {
      kind: "compiles",
      label: "not played; smoke run ends",
      detail: `The smoke run with fixed answers reached the end after ${run.steps} steps.`,
    };
  if (run.status === "failed" && run.failure !== null) {
    const at = `${run.failure.script}${run.failure.line === null ? "" : `:${run.failure.line}`}`;
    return {
      kind: "compiles",
      label: `not played; smoke run stops at ${at}`,
      detail: `The smoke run failed at ${at}: ${run.failure.code} ${run.failure.message}`,
    };
  }
  if (run.status === "blocked")
    return {
      kind: "compiles",
      label: `not played; smoke run stops at ${run.blockedTarget ?? "a script"}`,
      detail: `The smoke run reached ${run.blockedTarget ?? "a script"}, which has no runnable conversion.`,
    };
  return {
    kind: "compiles",
    label: "not played; smoke run inconclusive",
    detail: `The smoke run ended with ${run.status} after ${run.steps} steps; it may wait for typed text that the fixed answers never give.`,
  };
}

/** A `play-check.ts` result, or `null` when the value does not have its shape. */
export function parsePlayCheck(value: unknown): PlayCheck | null {
  if (!isRecord(value) || typeof value.contentHash !== "string") return null;
  const { verdict, checkedAt, runs, coverage } = value;
  if (verdict !== "plays" && verdict !== "stops" && verdict !== "no-start" && verdict !== "parked")
    return null;
  if (typeof checkedAt !== "string" || !Array.isArray(runs) || !isRecord(coverage)) return null;
  const strings = (item: unknown): string[] =>
    Array.isArray(item) ? item.filter((entry): entry is string => typeof entry === "string") : [];
  const count = (item: unknown): number => (typeof item === "number" ? item : 0);
  return {
    contentHash: value.contentHash,
    stepLimit: typeof value.stepLimit === "number" ? value.stepLimit : 300,
    verdict,
    checkedAt,
    runs: runs.map((run) => {
      const stop = isRecord(run) && isRecord(run.stop) ? run.stop : {};
      return {
        stop: {
          kind: typeof stop.kind === "string" ? stop.kind : "harness",
          detail: typeof stop.detail === "string" ? stop.detail : "",
          where:
            typeof stop.file === "string"
              ? `${stop.file}${typeof stop.line === "number" ? `:${stop.line}` : ""}`
              : null,
        },
      };
    }),
    coverage: {
      files: strings(coverage.files),
      fileCount: count(coverage.fileCount),
      sites: count(coverage.sites),
      siteCount: count(coverage.siteCount),
      choices: count(coverage.choices),
    },
    missingImages: strings(value.missingImages),
    missingMedia: strings(value.missingMedia),
    rawMarkup: strings(value.rawMarkup),
  };
}

/** An `explore.ts` report, or `null` when the value does not have its shape; see {@link ExplorerReport}. */
export function parseExplorerReport(value: unknown): ExplorerReport | null {
  if (!isRecord(value) || typeof value.contentHash !== "string") return null;
  if (typeof value.exploredAt !== "string") return null;
  const record = (item: unknown): Record<string, unknown> => (isRecord(item) ? item : {});
  const number = (item: unknown): number | null =>
    typeof item === "number" && Number.isFinite(item) ? item : null;
  const text = (item: unknown): string | null => (typeof item === "string" ? item : null);
  const crash = (item: unknown): ExplorerReport["firstCrash"] => {
    const fields = record(item);
    if (typeof fields.code !== "string") return null;
    const line = number(fields.line);
    const file = text(fields.path);
    return {
      code: fields.code,
      where: file === null ? null : `${file}${line === null ? "" : `:${line}`}`,
      message: text(fields.message) ?? "",
      ...(fields.chosen === true ? { chosen: true } : {}),
    };
  };
  const block = record(value.catalog);
  const search = record(value.search);
  const coverage = record(value.coverage);
  const ends = record(value.endStates);
  const crashes = Array.isArray(value.crashes) ? value.crashes : [];
  const traps = Array.isArray(value.traps) ? value.traps : [];
  const percent = number(block.coveragePercent) ?? number(coverage.percent);
  const completed = number(ends.completed);
  const failed = number(ends.failed);
  const stuck = number(ends.stuck);
  const open = number(ends.open);
  // A trap of the full report names its `locations`; the catalog block's first trap, its `location`.
  const trap = (item: unknown): ExplorerReport["firstTrap"] => {
    const fields = record(item);
    const kind = text(fields.kind);
    const where =
      text(fields.location) ?? (Array.isArray(fields.locations) ? text(fields.locations[0]) : null);
    return kind === null && where === null ? null : { kind, where };
  };
  return {
    contentHash: value.contentHash,
    exploredAt: value.exploredAt,
    explorer: text(value.explorer),
    budgetSeconds: number(value.budgetSeconds),
    budgetOps: number(value.budgetOps),
    compiles: record(value.compile).ok !== false,
    stoppedBy: text(search.stoppedBy),
    states: number(search.states),
    engineErrors: number(record(search.engineErrors).count) ?? 0,
    endStates:
      completed === null || failed === null || stuck === null || open === null
        ? null
        : { completed, failed, stuck, open },
    coverage:
      percent === null
        ? null
        : {
            percent,
            visited: number(coverage.visitedLines),
            coverable: number(coverage.coverableLines),
          },
    crashes: number(block.crashes) ?? crashes.length,
    traps: number(block.traps) ?? traps.length,
    firstCrash: block.firstCrash === undefined ? crash(crashes[0]) : crash(block.firstCrash),
    firstTrap: block.firstTrap === undefined ? trap(traps[0]) : trap(block.firstTrap),
    reach: isRecord(block.reach)
      ? Object.fromEntries(
          Object.entries(block.reach).filter(
            (entry): entry is [string, number] => number(entry[1]) !== null,
          ),
        )
      : null,
  };
}

/**
 * The status from a Player check: how far the runs got, or why the package does not start. `compileError` is the
 * compiler's error for the checked files, when they are the current ones and do not compile.
 */
function playStatus(play: PlayCheck, compileError: string | null): Status {
  const { files, fileCount, sites, siteCount, choices } = play.coverage;
  const coverage = `${play.runs.length} runs reached ${files.length} of ${fileCount} files, ${sites} of ${siteCount} interactions, and ${choices} choices.`;
  const missing = [...play.missingImages, ...play.missingMedia];
  const media =
    missing.length === 0
      ? ""
      : ` Missing media: ${missing.slice(0, 5).join(", ")}${missing.length > 5 ? `, and ${missing.length - 5} more` : ""}.`;
  // The Player lists compiler problems instead of a Start button: the package does not compile.
  if (play.verdict === "no-start")
    return {
      kind: "error",
      label: "does not compile",
      detail: compileError ?? play.runs[0]?.stop.detail ?? "",
    };
  const markup =
    play.rawMarkup.length === 0
      ? ""
      : ` Its text shows legacy HTML as written, such as "${play.rawMarkup[0]}".`;
  if (play.verdict === "parked")
    return {
      kind: "parked",
      label: `runs, step limit ${play.stepLimit} (parked)`,
      detail: `Every run played without errors and kept showing new prompts until the limit of ${play.stepLimit} interactions or four minutes; parked until the limit rises. ${coverage}${media}${markup}`,
    };
  if (play.verdict === "plays")
    return {
      kind: "plays",
      label: [
        "plays to the end",
        ...(missing.length === 0 ? [] : [`${missing.length} media missing`]),
        ...(play.rawMarkup.length === 0 ? [] : ["raw HTML in text"]),
      ].join(", "),
      detail: `Every run ended normally. ${coverage}${media}${markup}`,
    };
  const stop = play.runs.find((run) => run.stop.kind !== "ended")!.stop;
  const at = /^(\S+?:\d+) ([A-Z]+\d+)\b/u.exec(stop.detail);
  const label =
    stop.kind === "error" && at !== null
      ? `stops at ${at[1]} (${at[2]})`
      : stop.kind === "early-end"
        ? "ends at the start"
        : stop.kind === "empty"
          ? "shows nothing"
          : stop.kind === "hang"
            ? "hangs"
            : stop.kind === "budget"
              ? "no end in the step budget"
              : stop.kind === "loops"
                ? `loops${stop.where === null ? "" : ` at ${stop.where}`}`
                : `stops (${stop.kind})`;
  // A session that halts right after Start, before showing anything or before its first interaction, does not start.
  const atStart =
    play.runs[0]?.stop.kind === stop.kind && (stop.kind === "empty" || stop.kind === "early-end");
  return {
    kind: atStart ? "nostart" : "stops",
    label,
    detail: `${stop.detail}. ${coverage}${media}`,
  };
}

/** The importer's share of unconverted code: files with migration errors and the TODO markers it left. */
function partialConversion(
  report: ImporterReport | null,
  teaseFiles: number,
  todos: number,
): Status | null {
  const total = report?.fileCount ?? teaseFiles;
  const clean = report?.migrationCleanFileCount ?? total;
  if (clean >= total && todos === 0) return null;
  return {
    kind: "partial",
    label: `partly converted (${clean}/${total}, ${todos} TODO${todos === 1 ? "" : "s"})`,
    detail: `${clean} of ${total} Groovy files converted without errors; the .tease files have ${todos} TODO markers for manual migration.`,
  };
}

/**
 * The header that describes the package: that of `main.tease`, else of a script a generated `main.tease` menu goes to,
 * else the first file's with a title.
 */
function primaryHeader(
  sources: PackageScan["sources"],
  files: ReturnType<CatalogTools["compile"]>["files"],
): ScriptHeader | null {
  const headers = new Map(files.map((file) => [file.path, file.header]));
  const titled = (filePath: string) => {
    const header = headers.get(filePath);
    return header?.title != null ? header : null;
  };
  const main = sources.find((file) => file.path === MAIN);
  const targets =
    main === undefined
      ? []
      : [...main.source.matchAll(/\bgoto "([^"]+\.tease)"/gu)].map((match) => match[1]!);
  for (const filePath of [MAIN, ...targets, ...files.map((file) => file.path)]) {
    const header = titled(filePath);
    if (header !== null) return header;
  }
  return null;
}

/** An `author:` line of a legacy comment block, for a package without a header author. */
function commentAuthor(sources: PackageScan["sources"]): string | null {
  for (const { source } of sources) {
    const match = /^\s*(?:\/\/|\/?\*)\s*author\s*:\s*(\S.*?)\s*$/imu.exec(source);
    if (match !== null) return match[1]!;
  }
  return null;
}

/** The first of `candidates` that is a folder, or `null`. */
async function existingFolder(candidates: ReadonlyArray<string | null>): Promise<string | null> {
  for (const candidate of candidates) {
    if (candidate === null) continue;
    const information = await stat(candidate).catch(() => null);
    if (information?.isDirectory() === true) return candidate;
  }
  return null;
}

/**
 * The `earlierVersions` of a `unit.json`: each with its title, status, date, and Groovy files, which are paths
 * relative to the unit's legacy folder (or absolute), given as text or as `{ path }`.
 */
export function earlierVersions(unit: unknown, legacyFolder: string): EarlierVersion[] {
  if (!isRecord(unit) || !Array.isArray(unit.earlierVersions)) return [];
  return unit.earlierVersions.filter(isRecord).map((version, index) => ({
    title: typeof version.title === "string" ? version.title : `Version ${index + 1}`,
    status: typeof version.status === "string" ? version.status : null,
    date: typeof version.date === "string" ? version.date : null,
    note: typeof version.note === "string" && version.note !== "" ? version.note : null,
    files: (Array.isArray(version.files) ? version.files : [])
      .map((file) => (typeof file === "string" ? file : isRecord(file) ? file.path : null))
      .filter((file): file is string => typeof file === "string" && file !== "")
      .map((file) => {
        const source = path.resolve(legacyFolder, file);
        const relative = path.relative(legacyFolder, source);
        const name = relative.startsWith("..") ? path.basename(source) : relative;
        return { source, name: name.split(path.sep).join("/") };
      }),
  }));
}

/**
 * Hard-links each entry's Groovy and `.tease` files under `<folder>/source/<id>/{groovy,tease}/`, the `.tease` files
 * of a verified copy's latest conversion under `<folder>/source/<id>/latest/`, and the Groovy files of its earlier
 * versions under `<folder>/source/<id>/earlier/<n>/`.
 */
export async function writeSourceViews(
  entries: readonly CatalogEntry[],
  folder: string,
): Promise<void> {
  const sourceRoot = path.join(folder, "source");
  await rm(sourceRoot, { recursive: true, force: true });
  const place = async (source: string, target: string) => {
    await mkdir(path.dirname(target), { recursive: true });
    // Text files only, so on another filesystem a copy is fine; a missing earlier file is left out.
    await link(source, target).catch((error: unknown) => {
      if (error instanceof Error && "code" in error && error.code === "EXDEV")
        return copyFile(source, target);
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return;
      throw error;
    });
  };
  for (const entry of entries) {
    for (const [kind, files] of [
      ["groovy", entry.groovy],
      ["tease", entry.tease],
      ["latest", entry.latest],
    ] as const) {
      if (files === null || files.root === null) continue;
      for (const relative of files.paths)
        await place(
          path.join(files.root, ...relative.split("/")),
          path.join(sourceRoot, entry.id, kind, ...relative.split("/")),
        );
    }
    for (const [index, version] of entry.earlier.entries())
      for (const file of version.files)
        await place(
          file.source,
          path.join(sourceRoot, entry.id, "earlier", String(index + 1), ...file.name.split("/")),
        );
  }
}

/**
 * The page: when it was written, a few counts, then one table with a row per package, each with a Pin button; pinned
 * rows are copied into a table at the top. A filter under each of the title, author, keywords, and description
 * columns, a coverage range, and a sort order narrow and order the table. A few lines of inline CSS; on a narrow screen the rows stack. Its script shows the time in the reader's time
 * zone, filters and sorts the rows, and keeps the pins: on the server that serves the page (`pins.json` of
 * `serve-catalog.ts`), with `localStorage` as the fallback where the page is served without it.
 */
export function renderCatalogPage(
  entries: readonly CatalogEntry[],
  options: { readonly playerOrigin: string; readonly updatedAt: string },
): string {
  const count = (kind: Status["kind"]) =>
    entries.filter((entry) => entry.status.kind === kind).length;
  // Units whose current files the explorer explored; a stale report is counted apart.
  const explored = entries.flatMap((entry) =>
    entry.explored === null || entry.explored.of === "stale" ? [] : [entry.explored],
  );
  // The first four counts always show; the others only when they count something. Each explains itself in a tooltip.
  const summary: Array<[label: string, value: number, tooltip: string]> = [
    ["Listed", entries.length, "Packages on this page."],
    [
      "Convert fully",
      entries.filter((entry) => entry.partial === null).length,
      "Converted without migration errors or TODO markers.",
    ],
    ["Compile", entries.filter((entry) => entry.compiles).length, "The listed files compile."],
    [
      "Play to the end",
      count("plays") + count("verified") + count("approved"),
      "Automated play in the real Player ended normally on every path, for the listed files.",
    ],
    [
      "Played on an older conversion",
      entries.filter((entry) => entry.older?.kind === "plays").length,
      "Played to the end in the Player on files that the importer has converted again since.",
    ],
    ["Stop during play", count("stops"), "Automated play in the Player stopped or did not end."],
    [
      "Parked (step limit)",
      count("parked"),
      "Played without errors until the step limit of the Player check.",
    ],
    ["Do not start", count("nostart"), "The session ends at Start without showing anything."],
    ["Do not compile", count("error"), "The listed files do not compile, or lack main.tease."],
    [
      "Not played in the Player",
      count("compiles") + count("unbuilt"),
      "No Player check of the listed files; see the Explorer column.",
    ],
    [
      "Blocked by unbuilt commands",
      count("unbuilt"),
      "Needs TeaseScript commands that are not built yet.",
    ],
    ["Verified", count("verified"), "Checked by hand and served as a frozen copy."],
    ["Owner-approved", count("approved"), "Approved by the owner."],
    ["Unfinished stubs", count("stub"), "The legacy package is not a finished tease."],
    [
      "Explored",
      explored.length,
      "Explored headlessly: every button, choice, and answer within a time budget.",
    ],
    [
      "Explorer found crashes",
      explored.filter(({ report }) => report.crashes > 0).length,
      "Packages in which the explorer hit a runtime failure.",
    ],
    [
      "Explorer found traps",
      explored.filter(({ report }) => report.traps > 0).length,
      "Packages with a loop that the player cannot leave.",
    ],
    [
      "Explorer result stale",
      entries.filter((entry) => entry.explored?.of === "stale").length,
      "Explorer results of other files than the listed ones.",
    ],
  ];
  const counts = summary
    .filter(([, value], index) => index < 4 || value > 0)
    .map(
      ([label, value, tooltip]) =>
        `<div title="${escapeHtml(tooltip)}"><dt>${label}</dt><dd>${value}</dd></div>`,
    )
    .join("");
  const updated = new Date(options.updatedAt);
  const utc = `${updated.toISOString().slice(0, 10)} ${updated.toISOString().slice(11, 16)} UTC`;
  const labels = `<tr><th>Pin</th><th>Title</th><th>Author</th><th>Keywords</th><th>Description</th><th title="Click a status for details. A grey &quot;older conversion&quot; mark is a Player check of files converted again since.">Status</th><th title="The headless explorer: share of script lines reached, crashes (runtime failures), and traps (loops the player cannot leave). Click for details.">Explorer</th><th>Source</th></tr>`;
  const filter = (name: string) =>
    `<td><input type="search" data-filter="${name}" placeholder="Filter ${name}" aria-label="Filter ${name}"></td>`;
  const filters = `<tr class="filters"><td></td>${["title", "author", "keywords", "description"].map(filter).join("")}<td></td><td></td><td></td></tr>`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Converted SexScript teases</title>
<style>
body { margin: 2rem auto; padding: 0 1rem; max-width: 96rem; font: 15px/1.45 system-ui, sans-serif; color: #222; }
h1 { margin-bottom: 0.2rem; }
p.updated { margin: 0 0 1rem; font-size: 1.15em; font-weight: 600; color: #444; }
table { width: 100%; border-collapse: collapse; }
th { position: sticky; top: 0; background: #fff; text-align: left; border-bottom: 2px solid #ccc; }
th[title] { cursor: help; }
th, td { padding: 0.4rem 0.5rem; vertical-align: top; }
td { border-bottom: 1px solid #eee; }
td.description { min-width: 14rem; max-width: 26rem; }
td.keywords { max-width: 12rem; font-size: 0.9em; }
td.explorer { min-width: 11.5rem; }
td.author, td.keywords, td.source, .meta { color: #666; }
td.source, .play { font-size: 0.9em; }
.play a { white-space: nowrap; }
dl.summary { display: flex; flex-wrap: wrap; gap: 0.3rem 1.4rem; margin: 0 0 0.6rem; }
dl.summary div { cursor: help; }
dl.summary dt { color: #666; font-size: 0.9em; }
dl.summary dd { margin: 0; font-size: 1.3em; font-weight: 600; }
.toolbar { display: flex; flex-wrap: wrap; align-items: center; gap: 0.5rem 1.2rem; margin: 0 0 0.6rem; }
tr.filters td { padding-top: 0; border-bottom: 2px solid #ccc; }
tr.filters input { width: 100%; box-sizing: border-box; font-size: 0.9em; }
.toolbar input[type="number"] { width: 4.5rem; }
.status { font-size: 0.8em; padding: 0 0.4em; border-radius: 0.3em; display: inline-block; max-width: 13rem; background: #eee; color: #333; }
.status.plays { background: #ddf4dd; color: #1d5e1d; }
.status.verified, .status.approved { background: #1d5e1d; color: #fff; }
.status.stops, .status.partial { background: #fff1cc; color: #6b4e00; }
.status.unbuilt { background: #e6e3fb; color: #3c2f86; }
.status.parked { background: #e3eefb; color: #24508a; }
.status.stub, .status.stale, .status.older { background: #eee; color: #555; font-style: italic; }
.status.error, .status.nostart { background: #fde2e1; color: #8a1c1c; }
details summary { cursor: pointer; }
td.status-cell details summary, td.explorer details summary { list-style: none; }
details.earlier { margin-top: 0.3rem; font-size: 0.85em; color: #555; }
details.earlier ul { margin: 0.2rem 0 0; padding-left: 1.1rem; }
td.status-cell details p, td.explorer details p, td.source details p { margin: 0.2rem 0; font-size: 0.85em; color: #555; }
button[data-pin] { font-size: 0.8em; }
@media (max-width: 60rem) {
  table.packages thead tr:not(.filters), tr.filters td:empty { display: none; }
  tr.filters td { border: 0; padding: 0.1rem 0; }
  table.packages, table.packages tbody, table.packages tr, table.packages td { display: block; }
  table.packages tr { border-bottom: 1px solid #ddd; padding: 0.5rem 0; }
  table.packages tr[hidden] { display: none; }
  table.packages td { border: 0; padding: 0.1rem 0; max-width: none; }
  td.keywords:not(:empty)::before { content: "Keywords: "; }
  td.explorer:not(:empty)::before { content: "Explorer: "; }
  td.pin { float: right; }
}
</style>
</head>
<body>
<h1>Converted SexScript teases</h1>
<p class="updated">Updated <time datetime="${escapeHtml(options.updatedAt)}" data-local>${utc}</time></p>
<dl class="summary">${counts}</dl>
<p class="meta">Click a title or a Play link to play the tease in the TeaseScript Player, and a status for its details.</p>
<h2>Pinned</h2>
<p id="pinned-none" class="meta">Nothing pinned yet. Use a Pin button to keep a tease here.</p>
<table class="packages" hidden>
<thead>${labels}</thead>
<tbody id="pinned"></tbody>
</table>
<h2>All packages</h2>
<div class="toolbar">
<span>Coverage <input type="number" id="coverage-min" min="0" max="100" placeholder="from" aria-label="Coverage from, in percent"> to <input type="number" id="coverage-max" min="0" max="100" placeholder="to" aria-label="Coverage up to, in percent"> %</span>
<label>Sort <select id="sort">
<option value="title">Title</option>
<option value="coverage-asc">Coverage, lowest first</option>
<option value="coverage-desc">Coverage, highest first</option>
<option value="crashes">Crashes, most first</option>
<option value="traps">Traps, most first</option>
</select></label>
<span id="shown" class="meta"></span>
</div>
<table class="packages">
<thead>${labels}${filters}</thead>
<tbody id="all">
${entries.map((entry, index) => renderRow(entry, index, options.playerOrigin)).join("\n")}
</tbody>
</table>
<script>
// The time the page was written, in the reader's time zone.
for (const time of document.querySelectorAll("time[data-local]")) {
  const date = new Date(time.dateTime);
  const pad = (value) => String(value).padStart(2, "0");
  time.textContent = date.getFullYear() + "-" + pad(date.getMonth() + 1) + "-" + pad(date.getDate()) + " " +
    pad(date.getHours()) + ":" + pad(date.getMinutes());
}

// Column filters, coverage range, and sort order of the table of all packages; every word of every filter must
// appear in its column; rows without a value sort last.
const all = document.getElementById("all");
const rows = [...all.children];
const filters = [...document.querySelectorAll("input[data-filter]")];
const coverageMin = document.getElementById("coverage-min");
const coverageMax = document.getElementById("coverage-max");
const sort = document.getElementById("sort");
const number = (text) => (text === undefined || text === "" ? null : Number(text));
function apply() {
  const wanted = filters.flatMap((input) =>
    input.value
      .toLowerCase()
      .split(/\\s+/)
      .filter((word) => word !== "")
      .map((word) => [input.dataset.filter, word]),
  );
  const low = number(coverageMin.value);
  const high = number(coverageMax.value);
  let shown = 0;
  for (const row of rows) {
    const coverage = number(row.dataset.coverage);
    row.hidden = !(
      wanted.every(([name, word]) => row.dataset[name].includes(word)) &&
      (low === null || (coverage !== null && coverage >= low)) &&
      (high === null || (coverage !== null && coverage <= high))
    );
    if (!row.hidden) shown++;
  }
  const order = sort.value;
  const key = order.startsWith("coverage") ? "coverage" : order;
  const sorted = [...rows].sort((left, right) => {
    if (order !== "title") {
      const a = number(left.dataset[key]);
      const b = number(right.dataset[key]);
      if (a !== b) {
        if (a === null) return 1;
        if (b === null) return -1;
        return order === "coverage-asc" ? a - b : b - a;
      }
    }
    return left.dataset.order - right.dataset.order;
  });
  all.append(...sorted);
  document.getElementById("shown").textContent =
    shown === rows.length ? "" : shown + " of " + rows.length + " shown";
}
for (const control of [...filters, coverageMin, coverageMax]) control.addEventListener("input", apply);
sort.addEventListener("change", apply);

// Favourites: package ids kept by the server that serves the page, so that they outlive regenerations of the page,
// restarts, and this browser's storage; localStorage holds a copy, and is all there is where the server has no pins.
const KEY = ${JSON.stringify(PIN_STORAGE_KEY)};
let pins = new Set(JSON.parse(localStorage.getItem(KEY) || "[]"));
let serverPins = false;
function savePins() {
  localStorage.setItem(KEY, JSON.stringify([...pins]));
  if (serverPins)
    fetch("pins.json", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify([...pins]),
    }).catch(() => {});
}
function render() {
  const list = document.getElementById("pinned");
  list.replaceChildren();
  for (const row of rows)
    if (pins.has(row.dataset.id)) {
      const copy = row.cloneNode(true);
      copy.hidden = false;
      list.append(copy);
    }
  document.getElementById("pinned-none").hidden = list.children.length > 0;
  list.closest("table").hidden = list.children.length === 0;
  for (const button of document.querySelectorAll("button[data-pin]"))
    button.textContent = pins.has(button.dataset.pin) ? "Unpin" : "Pin";
}
document.addEventListener("click", (event) => {
  const button = event.target.closest("button[data-pin]");
  if (button === null) return;
  const id = button.dataset.pin;
  if (!pins.delete(id)) pins.add(id);
  savePins();
  render();
});
render();
// 200: the server's pins; 204: the server keeps pins but has none yet, so this browser's pins become them.
fetch("pins.json", { cache: "no-store" })
  .then(async (response) => {
    if (response.status === 204) {
      serverPins = true;
      if (pins.size > 0) savePins();
    } else if (response.ok) {
      const stored = await response.json();
      if (!Array.isArray(stored)) return;
      serverPins = true;
      pins = new Set(stored.filter((id) => typeof id === "string"));
      localStorage.setItem(KEY, JSON.stringify([...pins]));
      render();
    }
  })
  .catch(() => {});
</script>
</body>
</html>
`;
}

function renderRow(entry: CatalogEntry, index: number, playerOrigin: string): string {
  const id = escapeHtml(entry.id);
  const play = (packageId: string) =>
    escapeHtml(`${playerOrigin}/player/?package=${encodeURIComponent(packageId)}`);
  const badge = (status: Status, className: string) =>
    `<details title="${escapeHtml(status.detail)}"><summary><span class="status ${className}">${escapeHtml(status.label)}</span></summary><p>${escapeHtml(status.detail)}</p></details>`;
  const statuses = [
    badge(entry.status, entry.status.kind),
    ...(entry.partial === null ? [] : [badge(entry.partial, entry.partial.kind)]),
    ...(entry.older === null ? [] : [badge(entry.older, "older")]),
  ].join("");
  // A verified copy is offered beside its latest conversion, each with a link that says which it plays.
  const title =
    entry.origin === "verified"
      ? `<b>${escapeHtml(entry.title)}</b><br><span class="play"><a href="${play(entry.id)}">Play (verified copy)</a>${entry.latest === null ? "" : `<br><a href="${play(`${LATEST_PREFIX}${entry.id}`)}">Play (latest conversion)</a>`}</span>`
      : entry.playable
        ? `<a href="${play(entry.id)}"><b>${escapeHtml(entry.title)}</b></a>`
        : `<b>${escapeHtml(entry.title)}</b>`;
  const cells = [
    ["pin", `<button type="button" data-pin="${id}">Pin</button>`],
    ["title", title],
    ["author", escapeHtml(entry.author ?? "")],
    ["keywords", entry.keywords.map(escapeHtml).join(", ")],
    ["description", escapeHtml(entry.description ?? "") + renderEarlier(entry)],
    ["status-cell", statuses],
    ["explorer", renderExplorer(entry)],
    ["source", renderSource(entry)],
  ];
  // What the column filters match, and the explorer's numbers for the coverage range and the sort order.
  const filtered: Array<[name: string, text: string]> = [
    ["title", entry.title],
    ["author", entry.author ?? ""],
    ["keywords", entry.keywords.join(", ")],
    ["description", entry.description ?? ""],
  ];
  const report = entry.explored?.report ?? null;
  const data = [
    `data-id="${id}"`,
    `data-order="${index}"`,
    ...filtered.map(([name, text]) => `data-${name}="${escapeHtml(text.toLowerCase())}"`),
    ...(report === null || report.coverage === null
      ? []
      : [`data-coverage="${report.coverage.percent}"`]),
    ...(report === null
      ? []
      : [`data-crashes="${report.crashes}"`, `data-traps="${report.traps}"`]),
  ].join(" ");
  return `<tr ${data}>${cells.map(([name, html]) => `<td class="${name}">${html}</td>`).join("")}</tr>`;
}

/** The explorer's line coverage, crashes, and traps; its details name the first crash and trap and the search. */
function renderExplorer(entry: CatalogEntry): string {
  if (entry.explored === null) return "";
  const { report, of } = entry.explored;
  const count = (value: number, one: string, many: string) =>
    `${value} ${value === 1 ? one : many}`;
  const label = report.compiles
    ? [
        report.coverage === null ? "coverage unknown" : `${report.coverage.percent}%`,
        count(report.crashes, "crash", "crashes"),
        count(report.traps, "trap", "traps"),
      ].join(" &middot; ")
    : "does not compile";
  const { coverage, endStates, firstCrash, firstTrap } = report;
  const detail = [
    ...(of === "stale" ? ["Stale: explored other files than the listed ones."] : []),
    ...(of === "conversion" ? ["Explored the latest conversion, not the verified copy."] : []),
    `Explored ${report.exploredAt.slice(0, 10)}${report.explorer === null ? "" : ` with explorer ${report.explorer}`}${report.budgetSeconds === null ? "" : `, ${report.budgetSeconds} s budget`}${report.budgetOps === null ? "" : `, ${report.budgetOps} operations budget`}.`,
    ...(report.compiles ? [] : ["The unit did not compile, so it was not explored."]),
    ...(report.states === null
      ? []
      : [
          `The search ${report.stoppedBy === "exhausted" ? "reached every state" : "stopped at its budget"} after ${report.states} states.`,
        ]),
    ...(coverage === null || coverage.visited === null || coverage.coverable === null
      ? []
      : [`It reached ${coverage.visited} of ${coverage.coverable} lines (${coverage.percent}%).`]),
    ...(endStates === null
      ? []
      : [
          `Paths: ${endStates.completed} ended normally, ${endStates.failed} failed, ${endStates.stuck} stuck, ${endStates.open} still open.`,
        ]),
    ...(firstCrash === null
      ? []
      : [
          `First crash: ${firstCrash.code}${firstCrash.where === null ? "" : ` at ${firstCrash.where}`}` +
            `${firstCrash.chosen === true ? ", only with chosen random outcomes" : ""}.` +
            `${firstCrash.message === "" ? "" : ` ${firstCrash.message}`}`,
        ]),
    ...(firstTrap === null
      ? []
      : [
          `First trap${firstTrap.kind === null ? "" : `: ${firstTrap.kind}`}${firstTrap.where === null ? "" : ` at ${firstTrap.where}`}.`,
        ]),
    ...(report.reach === null || Object.keys(report.reach).length === 0
      ? []
      : [
          `Lines by reach: ${Object.entries(report.reach)
            .map(([label, lines]) => `${lines} ${REACH_LABELS[label] ?? label}`)
            .join(", ")}.`,
        ]),
    ...(report.engineErrors === 0
      ? []
      : [
          `${count(report.engineErrors, "runtime operation", "runtime operations")} threw: an explorer or runtime problem.`,
        ]),
  ].join(" ");
  const kind =
    of === "stale"
      ? "stale"
      : !report.compiles || report.crashes > 0
        ? "error"
        : report.traps > 0
          ? "stops"
          : "plays";
  const suffix = { listed: "", conversion: " (latest conversion)", stale: " (stale)" }[of];
  return `<details title="${escapeHtml(detail)}"><summary><span class="status ${kind}">${label}${suffix}</span></summary><p>${escapeHtml(detail)}</p></details>`;
}

/** A collapsed list of the tease's earlier versions, each with its title, status, date, and original Groovy. */
function renderEarlier(entry: CatalogEntry): string {
  if (entry.earlier.length === 0) return "";
  const items = entry.earlier.map((version, index) => {
    const facts = [version.status, version.date, version.note].filter((fact) => fact !== null);
    const links = version.files.map(
      (file) =>
        `<a href="${escapeHtml(
          `source/${encodeURIComponent(entry.id)}/earlier/${index + 1}/${file.name.split("/").map(encodeURIComponent).join("/")}`,
        )}">${escapeHtml(file.name)}</a>`,
    );
    return `<li>${escapeHtml(version.title)}${facts.length === 0 ? "" : ` &middot; ${facts.map((fact) => escapeHtml(fact!)).join(" &middot; ")}`}${links.length === 0 ? "" : `<br>Groovy: ${links.join(", ")}`}</li>`;
  });
  return `<details class="earlier"><summary>Earlier versions (${entry.earlier.length})</summary><ul>${items.join("")}</ul></details>`;
}

/**
 * Links to the package's Groovy and `.tease` files, and to a verified copy's latest conversion: directly for one file of
 * each, else in a `<details>` list.
 */
function renderSource(entry: CatalogEntry): string {
  const url = (kind: string, relative: string) =>
    escapeHtml(
      `source/${encodeURIComponent(entry.id)}/${kind}/${relative.split("/").map(encodeURIComponent).join("/")}`,
    );
  const media = [
    ...(entry.images > 0 ? [`${entry.images} ${entry.images === 1 ? "image" : "images"}`] : []),
    ...(entry.audio > 0 ? [`${entry.audio} audio`] : []),
  ].join(", ");
  const verified = entry.origin === "verified";
  const kinds: Array<[kind: string, label: string, files: readonly string[]]> = [
    ["groovy", "Groovy", entry.groovy.paths],
    ["tease", verified ? "TeaseScript (verified copy)" : "TeaseScript", entry.tease.paths],
    ["latest", "TeaseScript (latest conversion)", entry.latest?.paths ?? []],
  ];
  if (kinds.every(([, , files]) => files.length <= 1))
    return (
      kinds
        .flatMap(([kind, label, files]) =>
          files.map((file) => `<a href="${url(kind, file)}">${label}</a>`),
        )
        .join(" &middot; ") + (media === "" ? "" : `<br>${media}`)
    );
  const latestCount = entry.latest === null ? "" : `, ${entry.latest.paths.length} latest`;
  const lists = kinds
    .filter(([, , files]) => files.length > 0)
    .map(
      ([kind, label, files]) =>
        `<p>${label}: ${files.map((file) => `<a href="${url(kind, file)}">${escapeHtml(file)}</a>`).join(", ")}</p>`,
    )
    .join("");
  return `<details><summary>${entry.groovy.paths.length} Groovy, ${entry.tease.paths.length} TeaseScript${latestCount}</summary>${lists}</details>${media}`;
}

function escapeHtml(text: string): string {
  return text.replace(
    /[&<>"']/gu,
    (character) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]!,
  );
}
