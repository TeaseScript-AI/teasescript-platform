/**
 * Writes one HTML page that lists every package of a root of converted packages (see `convert-corpus.ts`), each title
 * opening the package in the TeaseScript Player, and hard-links the packages' legacy Groovy and converted `.tease`
 * files next to it under `source/`, for `serve-catalog.ts` to show as plain text.
 *
 * Usage: node tools/catalog.ts [--player <origin>] [--play-checks <dir>]... [--explorer <dir>]... [--verified <dir>]
 *   [--approved <file>] <converted-root> <output.html>
 *
 * `--player https://host:port` makes the Player links absolute, for a page served from another origin than the
 * Player; without it they are `/player/?package=<id>`. A package is read and compiled as the Player does: the
 * playground server's package scan, then the real compiler's `compileProject` with the package images (repository
 * build required). The status comes from, in this order: the owner-approved list (`--approved`, a Markdown table
 * whose first column names the package), the frozen verified copies (`--verified`, which replace the converted
 * package in the list), the Player checks of `play-check.ts` (`--play-checks`) for the package's current `.tease`
 * files, and otherwise the compiler and the importer's report in `.report.json`. The Explorer column shows the latest
 * report of `explore.ts` (`--explorer`, folders of `<unit>.json` or `<unit>/<unit>.json`) for the package's current
 * files, or for a verified copy of the unit's newer conversion, else its latest report of other files, marked stale.
 */
import { createHash } from "node:crypto";
import { copyFile, link, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
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
  /** The importer commit that converted the unit, from `.conversion.json`, when it records one. */
  readonly converter: string | null;
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

/** When and with which importer the converted root was measured, from `.conversion-summary.json`. */
export interface Measurement {
  readonly importerCommit: string | null;
  readonly measuredAt: string | null;
}

const MAIN = "main.tease";
const AUDIO_EXTENSIONS = new Set([".mp3", ".wav", ".ogg"]);
const PIN_STORAGE_KEY = "sexscript-catalog-pins";
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
      "play-checks": { type: "string", multiple: true },
      explorer: { type: "string", multiple: true },
      verified: { type: "string" },
      approved: { type: "string" },
    },
  });
  if (positionals.length !== 2) {
    process.stderr.write(
      "Usage: node tools/catalog.ts [--player <origin>] [--play-checks <dir>]... [--explorer <dir>]... [--verified <dir>] [--approved <file>] <converted-root> <output.html>\n",
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
  const entries = await readCatalogEntries(root, await loadRepositoryCatalogTools(), {
    ...(values["play-checks"] === undefined
      ? {}
      : { playChecks: values["play-checks"].map((folder) => path.resolve(folder)) }),
    ...(values.explorer === undefined
      ? {}
      : { explorer: values.explorer.map((folder) => path.resolve(folder)) }),
    ...(values.verified === undefined ? {} : { verified: path.resolve(values.verified) }),
    approved,
  });
  const measurement = await readFile(path.join(root, ".conversion-summary.json"), "utf8").then(
    (text) => {
      // EVIDENCE: convert-corpus.ts writes .conversion-summary.json as one JSON object of counts.
      const summary = JSON.parse(text) as Record<string, unknown>;
      return {
        importerCommit: typeof summary.importerCommit === "string" ? summary.importerCommit : null,
        measuredAt: typeof summary.measuredAt === "string" ? summary.measuredAt : null,
      };
    },
    () => ({ importerCommit: null, measuredAt: null }),
  );
  await mkdir(path.dirname(output), { recursive: true });
  await writeSourceViews(entries, path.dirname(output));
  await writeFile(output, renderCatalogPage(entries, { playerOrigin, measurement }), "utf8");
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

/** Loads the playground server's package scan and the compiler from the repository build (`npm run build`). */
export async function loadRepositoryCatalogTools(): Promise<CatalogTools> {
  const distRoot = new URL("../../dist/", import.meta.url);
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
  // A verified copy is frozen, while the explorer explores the unit's current conversion: the one other current hash.
  const conversionHash =
    isVerified && explorerReports.some((report) => report.contentHash !== hash)
      ? await tools.scan(path.join(convertedRoot, id)).then(
          (conversionScan) => packageContentHash(conversionScan.sources),
          () => null,
        )
      : null;
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
    converter: typeof conversion?.converter === "string" ? conversion.converter : null,
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
 * Hard-links each entry's Groovy and `.tease` files under `<folder>/source/<id>/{groovy,tease}/`, and the Groovy
 * files of its earlier versions under `<folder>/source/<id>/earlier/<n>/`.
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
    ] as const) {
      if (files.root === null) continue;
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
 * The page: a summary of the conversion, then one table with a row per package, each with a Pin button; pinned rows
 * are copied into a table at the top. A few lines of inline CSS; on a narrow screen the rows stack. Its only script
 * is the pinning.
 */
export function renderCatalogPage(
  entries: readonly CatalogEntry[],
  options: { readonly playerOrigin: string; readonly measurement: Measurement },
): string {
  const count = (kind: Status["kind"]) =>
    entries.filter((entry) => entry.status.kind === kind).length;
  const { importerCommit, measuredAt } = options.measurement;
  // A unit converted again records its own importer commit; the others share the root's.
  const commits = new Map<string, number>();
  for (const entry of entries) {
    const commit = entry.converter ?? importerCommit;
    if (commit !== null) commits.set(commit, (commits.get(commit) ?? 0) + 1);
  }
  const commitText =
    commits.size <= 1
      ? [...commits.keys()].map((commit) => `importer commit ${escapeHtml(commit)}`)
      : [
          `importer commits ${[...commits]
            .sort((left, right) => right[1] - left[1])
            .map(([commit, units]) => `${escapeHtml(commit)} (${units} units)`)
            .join(", ")}`,
        ];
  const measured = [
    ...(measuredAt === null ? [] : [`Measured ${measuredAt.slice(0, 10)}`]),
    ...commitText,
  ].join(" with ");
  // Units whose current files the explorer explored; a stale report is counted apart.
  const explored = entries.flatMap((entry) =>
    entry.explored === null || entry.explored.of === "stale" ? [] : [entry.explored],
  );
  const summary: Array<[string, number]> = [
    ["Listed", entries.length],
    ["Convert fully", entries.filter((entry) => entry.partial === null).length],
    ["Compile", entries.filter((entry) => entry.compiles).length],
    ["Play to the end", count("plays") + count("verified") + count("approved")],
    [
      "Played to the end on an older conversion",
      entries.filter((entry) => entry.older?.kind === "plays").length,
    ],
    ["Stop during play", count("stops")],
    ["Parked (step limit)", count("parked")],
    ["Do not start", count("nostart")],
    ["Do not compile", count("error")],
    ["Not played in the Player", count("compiles") + count("unbuilt")],
    ["Blocked by unbuilt commands", count("unbuilt")],
    ["Verified", count("verified")],
    ["Owner-approved", count("approved")],
    ["Unfinished stubs", count("stub")],
    ["Explored", explored.length],
    ["Explorer found crashes", explored.filter(({ report }) => report.crashes > 0).length],
    ["Explorer found traps", explored.filter(({ report }) => report.traps > 0).length],
    ["Explorer result stale", entries.filter((entry) => entry.explored?.of === "stale").length],
  ];
  const head =
    "<thead><tr><th>Pin</th><th>Title</th><th>Author</th><th>Keywords</th><th>Description</th><th>Status</th><th>Explorer</th><th>Source</th></tr></thead>";
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Converted SexScript teases</title>
<style>
body { margin: 2rem auto; padding: 0 1rem; max-width: 96rem; font: 15px/1.45 system-ui, sans-serif; color: #222; }
table { width: 100%; border-collapse: collapse; }
th { position: sticky; top: 0; background: #fff; text-align: left; border-bottom: 2px solid #ccc; }
th, td { padding: 0.4rem 0.5rem; vertical-align: top; }
td { border-bottom: 1px solid #eee; }
td.description { min-width: 14rem; max-width: 26rem; }
td.keywords { max-width: 12rem; font-size: 0.9em; }
td.explorer { min-width: 11.5rem; }
td.author, td.keywords, td.source, .meta { color: #666; }
td.source { font-size: 0.9em; }
dl.summary { display: flex; flex-wrap: wrap; gap: 0.3rem 1.4rem; margin: 0 0 0.3rem; }
dl.summary dt { color: #666; font-size: 0.9em; }
dl.summary dd { margin: 0; font-size: 1.3em; font-weight: 600; }
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
  table.packages thead { display: none; }
  table.packages, table.packages tbody, table.packages tr, table.packages td { display: block; }
  table.packages tr { border-bottom: 1px solid #ddd; padding: 0.5rem 0; }
  table.packages td { border: 0; padding: 0.1rem 0; max-width: none; }
  td.keywords:not(:empty)::before { content: "Keywords: "; }
  td.explorer:not(:empty)::before { content: "Explorer: "; }
  td.pin { float: right; }
}
</style>
</head>
<body>
<h1>Converted SexScript teases</h1>
<p>Legacy SexScript packages converted by the TeaseScript importer. Each title opens its package in the TeaseScript
Player; click a status for its details.</p>
<dl class="summary">${summary.map(([label, value]) => `<div><dt>${label}</dt><dd>${value}</dd></div>`).join("")}</dl>
<p class="meta">${measured}${measured === "" ? "" : ". "}"Play to the end" means that automated play in the real
Player, on several paths through buttons, choices, and typed answers, with waits skipped, ended normally every time.
A grey "older conversion" mark shows the Player check of files that the importer has converted again since; the counts
above take only checks of the current files. "Verified" packages also passed a manual check and are served as frozen copies.
"Explorer" is the headless explorer:
it tries every button, choice, and answer it can within a time budget, and shows the share of script lines it reached,
crashes (runtime failures), and traps (loops the player cannot leave). For a verified package it may show the newer
conversion; "stale" results explored other files than the listed ones. MIDI music does not play.</p>
<h2>Pinned</h2>
<p id="pinned-none" class="meta">Nothing pinned yet. Use a Pin button to keep a tease here.</p>
<table class="packages" hidden>
${head}
<tbody id="pinned"></tbody>
</table>
<h2>All packages</h2>
<table class="packages">
${head}
<tbody id="all">
${entries.map((entry) => renderRow(entry, options.playerOrigin)).join("\n")}
</tbody>
</table>
<script>
// Favourites: package ids in localStorage; pinned rows are copied into the table at the top.
const KEY = ${JSON.stringify(PIN_STORAGE_KEY)};
const pins = new Set(JSON.parse(localStorage.getItem(KEY) || "[]"));
function render() {
  const list = document.getElementById("pinned");
  list.replaceChildren();
  for (const row of document.querySelectorAll("#all > tr"))
    if (pins.has(row.dataset.id)) list.append(row.cloneNode(true));
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
  localStorage.setItem(KEY, JSON.stringify([...pins]));
  render();
});
render();
</script>
</body>
</html>
`;
}

function renderRow(entry: CatalogEntry, playerOrigin: string): string {
  const id = escapeHtml(entry.id);
  const href = escapeHtml(`${playerOrigin}/player/?package=${encodeURIComponent(entry.id)}`);
  const badge = (status: Status, className: string) =>
    `<details title="${escapeHtml(status.detail)}"><summary><span class="status ${className}">${escapeHtml(status.label)}</span></summary><p>${escapeHtml(status.detail)}</p></details>`;
  const statuses = [
    badge(entry.status, entry.status.kind),
    ...(entry.partial === null ? [] : [badge(entry.partial, entry.partial.kind)]),
    ...(entry.older === null ? [] : [badge(entry.older, "older")]),
  ].join("");
  const cells = [
    ["pin", `<button type="button" data-pin="${id}">Pin</button>`],
    [
      "title",
      entry.playable
        ? `<a href="${href}"><b>${escapeHtml(entry.title)}</b></a>`
        : `<b>${escapeHtml(entry.title)}</b>`,
    ],
    ["author", escapeHtml(entry.author ?? "")],
    ["keywords", entry.keywords.map(escapeHtml).join(", ")],
    ["description", escapeHtml(entry.description ?? "") + renderEarlier(entry)],
    ["status-cell", statuses],
    ["explorer", renderExplorer(entry)],
    ["source", renderSource(entry)],
  ];
  return `<tr data-id="${id}">${cells.map(([name, html]) => `<td class="${name}">${html}</td>`).join("")}</tr>`;
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
    ...(of === "conversion"
      ? ["Explored the unit's newer conversion, not the verified copy listed here."]
      : []),
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
  const suffix = { listed: "", conversion: " (newer conversion)", stale: " (stale)" }[of];
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

/** Links to the package's Groovy and `.tease` files: directly for one of each, else in a `<details>` list. */
function renderSource(entry: CatalogEntry): string {
  const url = (kind: string, relative: string) =>
    escapeHtml(
      `source/${encodeURIComponent(entry.id)}/${kind}/${relative.split("/").map(encodeURIComponent).join("/")}`,
    );
  const media = [
    ...(entry.images > 0 ? [`${entry.images} ${entry.images === 1 ? "image" : "images"}`] : []),
    ...(entry.audio > 0 ? [`${entry.audio} audio`] : []),
  ].join(", ");
  const groovy = entry.groovy.paths;
  const tease = entry.tease.paths;
  if (groovy.length <= 1 && tease.length <= 1)
    return (
      [
        ...groovy.map((file) => `<a href="${url("groovy", file)}">Groovy</a>`),
        ...tease.map((file) => `<a href="${url("tease", file)}">TeaseScript</a>`),
      ].join(" &middot; ") + (media === "" ? "" : `<br>${media}`)
    );
  const list = (kind: string, label: string, files: readonly string[]) =>
    files.length === 0
      ? ""
      : `<p>${label}: ${files.map((file) => `<a href="${url(kind, file)}">${escapeHtml(file)}</a>`).join(", ")}</p>`;
  return `<details><summary>${groovy.length} Groovy, ${tease.length} TeaseScript</summary>${list("groovy", "Groovy", groovy)}${list("tease", "TeaseScript", tease)}</details>${media}`;
}

function escapeHtml(text: string): string {
  return text.replace(
    /[&<>"']/gu,
    (character) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]!,
  );
}
