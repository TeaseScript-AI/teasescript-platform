/**
 * Writes one HTML page that lists every package of a root of converted packages (see `convert-corpus.ts`), each title
 * opening the package in the TeaseScript Player, and hard-links the packages' legacy Groovy and converted `.tease`
 * files next to it under `source/`, for `serve-catalog.ts` to show as plain text.
 *
 * Usage: node tools/catalog.ts [--player <origin>] [--play-checks <dir>] [--verified <dir>] [--approved <file>]
 *   <converted-root> <output.html>
 *
 * `--player https://host:port` makes the Player links absolute, for a page served from another origin than the
 * Player; without it they are `/player/?package=<id>`. A package is read and compiled as the Player does: the
 * playground server's package scan, then the real compiler's `compileProject` with the package images (repository
 * build required). The status comes from, in this order: the owner-approved list (`--approved`, a Markdown table
 * whose first column names the package), the frozen verified copies (`--verified`, which replace the converted
 * package in the list), the Player checks of `play-check.ts` (`--play-checks`) for the package's current `.tease`
 * files, and otherwise the compiler and the importer's report in `.report.json`.
 */
import { createHash } from "node:crypto";
import { copyFile, link, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
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
  /** Legacy Groovy files, from the package's `scripts/` folder, and converted `.tease` files, by relative path. */
  readonly groovy: SourceFiles;
  readonly tease: SourceFiles;
  readonly images: number;
  readonly audio: number;
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
    | "stub";
  /** A few words for the table. */
  readonly label: string;
  readonly detail: string;
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
  readonly verdict: "plays" | "stops" | "no-start";
  readonly checkedAt: string;
  readonly runs: ReadonlyArray<{
    readonly stop: { readonly kind: string; readonly detail: string };
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

/** Where the status beyond the compiler comes from; see the module comment. */
export interface StatusSources {
  /** Folders of `play-check.ts` results; for each package the latest check of its current files counts. */
  readonly playChecks?: readonly string[];
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

if (process.argv[1] === fileURLToPath(import.meta.url)) await main(process.argv.slice(2));

async function main(rawArgs: string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args: rawArgs,
    allowPositionals: true,
    options: {
      player: { type: "string", default: "" },
      "play-checks": { type: "string", multiple: true },
      verified: { type: "string" },
      approved: { type: "string" },
    },
  });
  if (positionals.length !== 2) {
    process.stderr.write(
      "Usage: node tools/catalog.ts [--player <origin>] [--play-checks <dir>] [--verified <dir>] [--approved <file>] <converted-root> <output.html>\n",
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
  const groovyRoot =
    typeof conversion?.source === "string" ? path.join(conversion.source, "scripts") : null;
  const groovy =
    groovyRoot === null
      ? []
      : (await readdir(groovyRoot, { recursive: true, withFileTypes: true }).catch(() => []))
          .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".groovy"))
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
        ? ` A newer conversion does not play: ${playStatus(play, compileStatus).detail}`
        : "";
    status = {
      kind: "verified",
      label: regression === "" ? "verified" : "verified, newer conversion regresses",
      detail: `Played and checked on ${String(verifiedRecord?.date ?? "?")} with importer commit ${String(verifiedRecord?.importerCommit ?? "?")}; this frozen copy is served.${regression}`,
    };
  } else status = current === null ? compileStatus : playStatus(current, compileStatus);
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
    groovy: { root: groovyRoot, paths: groovy },
    tease: { root: folder, paths: sources.map((file) => file.path).sort() },
    images: scan.images.length,
    audio: scan.media.filter((file) => AUDIO_EXTENSIONS.has(path.extname(file).toLowerCase()))
      .length,
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
  if (verdict !== "plays" && verdict !== "stops" && verdict !== "no-start") return null;
  if (typeof checkedAt !== "string" || !Array.isArray(runs) || !isRecord(coverage)) return null;
  const strings = (item: unknown): string[] =>
    Array.isArray(item) ? item.filter((entry): entry is string => typeof entry === "string") : [];
  const count = (item: unknown): number => (typeof item === "number" ? item : 0);
  return {
    contentHash: value.contentHash,
    verdict,
    checkedAt,
    runs: runs.map((run) => {
      const stop = isRecord(run) && isRecord(run.stop) ? run.stop : {};
      return {
        stop: {
          kind: typeof stop.kind === "string" ? stop.kind : "harness",
          detail: typeof stop.detail === "string" ? stop.detail : "",
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

/** The status from a Player check: how far the runs got, or why the package does not start. */
function playStatus(play: PlayCheck, compileStatus: Status): Status {
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
      detail:
        compileStatus.kind === "error" ? compileStatus.detail : (play.runs[0]?.stop.detail ?? ""),
    };
  const markup =
    play.rawMarkup.length === 0
      ? ""
      : ` Its text shows legacy HTML as written, such as "${play.rawMarkup[0]}".`;
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

/** Hard-links each entry's Groovy and `.tease` files under `<folder>/source/<id>/{groovy,tease}/`. */
export async function writeSourceViews(
  entries: readonly CatalogEntry[],
  folder: string,
): Promise<void> {
  const sourceRoot = path.join(folder, "source");
  await rm(sourceRoot, { recursive: true, force: true });
  for (const entry of entries)
    for (const [kind, files] of [
      ["groovy", entry.groovy],
      ["tease", entry.tease],
    ] as const) {
      if (files.root === null) continue;
      for (const relative of files.paths) {
        const source = path.join(files.root, ...relative.split("/"));
        const target = path.join(sourceRoot, entry.id, kind, ...relative.split("/"));
        await mkdir(path.dirname(target), { recursive: true });
        // Text files only, so on another filesystem a copy is fine.
        await link(source, target).catch((error: unknown) => {
          if (error instanceof Error && "code" in error && error.code === "EXDEV")
            return copyFile(source, target);
          throw error;
        });
      }
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
  const summary: Array<[string, number]> = [
    ["Listed", entries.length],
    ["Convert fully", entries.filter((entry) => entry.partial === null).length],
    ["Compile", entries.filter((entry) => entry.compiles).length],
    ["Play to the end", count("plays") + count("verified") + count("approved")],
    ["Stop during play", count("stops")],
    ["Do not start", count("nostart")],
    ["Do not compile", count("error")],
    ["Not played yet", count("compiles") + count("unbuilt")],
    ["Blocked by unbuilt commands", count("unbuilt")],
    ["Verified", count("verified")],
    ["Owner-approved", count("approved")],
    ["Unfinished stubs", count("stub")],
  ];
  const head =
    "<thead><tr><th>Pin</th><th>Title</th><th>Author</th><th>Keywords</th><th>Description</th><th>Status</th><th>Source</th></tr></thead>";
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Converted SexScript teases</title>
<style>
body { margin: 2rem auto; padding: 0 1rem; max-width: 84rem; font: 15px/1.45 system-ui, sans-serif; color: #222; }
table { width: 100%; border-collapse: collapse; }
th { position: sticky; top: 0; background: #fff; text-align: left; border-bottom: 2px solid #ccc; }
th, td { padding: 0.4rem 0.5rem; vertical-align: top; }
td { border-bottom: 1px solid #eee; }
td.description { min-width: 14rem; max-width: 26rem; }
td.keywords { max-width: 12rem; font-size: 0.9em; }
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
.status.stub { background: #eee; color: #555; font-style: italic; }
.status.error, .status.nostart { background: #fde2e1; color: #8a1c1c; }
details summary { cursor: pointer; }
td.status-cell details summary { list-style: none; }
td.status-cell details p, td.source details p { margin: 0.2rem 0; font-size: 0.85em; color: #555; }
button[data-pin] { font-size: 0.8em; }
@media (max-width: 60rem) {
  table.packages thead { display: none; }
  table.packages, table.packages tbody, table.packages tr, table.packages td { display: block; }
  table.packages tr { border-bottom: 1px solid #ddd; padding: 0.5rem 0; }
  table.packages td { border: 0; padding: 0.1rem 0; max-width: none; }
  td.keywords:not(:empty)::before { content: "Keywords: "; }
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
"Verified" packages also passed a manual check and are served as frozen copies. MIDI music does not play.</p>
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
  const statuses = [entry.status, ...(entry.partial === null ? [] : [entry.partial])]
    .map(
      (status) =>
        `<details title="${escapeHtml(status.detail)}"><summary><span class="status ${status.kind}">${escapeHtml(status.label)}</span></summary><p>${escapeHtml(status.detail)}</p></details>`,
    )
    .join("");
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
    ["description", escapeHtml(entry.description ?? "")],
    ["status-cell", statuses],
    ["source", renderSource(entry)],
  ];
  return `<tr data-id="${id}">${cells.map(([name, html]) => `<td class="${name}">${html}</td>`).join("")}</tr>`;
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
