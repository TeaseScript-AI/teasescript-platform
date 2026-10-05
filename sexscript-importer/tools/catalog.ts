/**
 * Writes one HTML page that lists every package of a root of converted packages (see `convert-corpus.ts`), each title
 * opening the package in the TeaseScript Player, and hard-links the packages' legacy Groovy and converted `.tease`
 * files next to it under `source/`, for `serve-catalog.ts` to show as plain text.
 *
 * Usage: node tools/catalog.ts [--player <origin>] <converted-root> <output.html>
 *
 * `--player https://host:port` makes the Player links absolute, for a page served from another origin than the
 * Player; without it they are `/player/?package=<id>`. A package is read and compiled as the Player does: the
 * playground server's package scan, then the real compiler's `compileProject` with the package images (repository
 * build required). The status also uses the importer's report in `.report.json`, written by `convert-corpus.ts`.
 */
import { copyFile, link, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

export interface CatalogEntry {
  readonly id: string;
  readonly title: string;
  readonly author: string | null;
  readonly description: string | null;
  readonly keywords: readonly string[];
  readonly compiles: boolean;
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
  readonly kind: "runs" | "stops" | "unbuilt" | "compiles" | "error" | "partial";
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
  const playerIndex = rawArgs.indexOf("--player");
  const playerOrigin = playerIndex < 0 ? "" : (rawArgs[playerIndex + 1] ?? "").replace(/\/+$/u, "");
  const args =
    playerIndex < 0
      ? rawArgs
      : rawArgs.filter((_, index) => index !== playerIndex && index !== playerIndex + 1);
  if (args.length !== 2 || (playerIndex >= 0 && playerOrigin === "")) {
    process.stderr.write(
      "Usage: node tools/catalog.ts [--player <origin>] <converted-root> <output.html>\n",
    );
    process.exit(2);
  }
  const root = path.resolve(args[0]!);
  const output = path.resolve(args[1]!);
  const entries = await readCatalogEntries(root, await loadRepositoryCatalogTools());
  const measurement = await readFile(path.join(root, ".conversion-summary.json"), "utf8").then(
    (text) => {
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
  const count = (kind: Status["kind"]) =>
    entries.filter((entry) => entry.status.kind === kind).length;
  process.stderr.write(
    `Listed ${entries.length} packages in ${output}: ${entries.filter((entry) => entry.compiles).length} compile, ` +
      `${count("runs")} run to the end, ${count("stops")} stop during the run, ${count("unbuilt")} need unbuilt ` +
      `commands, ${count("error")} do not compile or start.\n`,
  );
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
  return {
    scan: (folder) => new (PackageFolder as new (root: string) => Folder)(folder).scan(),
    compile: (sources, images) =>
      (compileProject as (...args: unknown[]) => ReturnType<CatalogTools["compile"]>)(sources, {
        images,
      }),
  };
}

/** Every package folder of `root` (each non-hidden subfolder), by title. */
export async function readCatalogEntries(
  root: string,
  tools: CatalogTools,
): Promise<CatalogEntry[]> {
  const ids = (await readdir(root, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
    .map((entry) => entry.name);
  const entries: CatalogEntry[] = [];
  // Scanning reads every image for its XMP tags, so a few packages at a time.
  for (let start = 0; start < ids.length; start += 4)
    entries.push(
      ...(await Promise.all(ids.slice(start, start + 4).map((id) => readEntry(root, id, tools)))),
    );
  return entries.sort(
    (left, right) =>
      left.title.localeCompare(right.title, "en", { sensitivity: "base" }) ||
      left.id.localeCompare(right.id, "en"),
  );
}

async function readEntry(root: string, id: string, tools: CatalogTools): Promise<CatalogEntry> {
  const folder = path.join(root, id);
  const scan = await tools.scan(folder);
  const compilation = tools.compile(scan.sources, scan.images);
  const sources = [...scan.sources].sort((left, right) =>
    left.path === MAIN ? -1 : right.path === MAIN ? 1 : 0,
  );
  const header = primaryHeader(sources, compilation.files);
  const readJson = (name: string) =>
    readFile(path.join(folder, name), "utf8").then(
      (text) => JSON.parse(text) as Record<string, unknown>,
      () => null,
    );
  const conversion = await readJson(".conversion.json");
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
    status: packageStatus(
      sources.some((file) => file.path === MAIN),
      compilation.plan !== null,
      compilation.diagnostics,
      report,
    ),
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
    return { kind: "compiles", label: "compiles", detail: "The importer report has no smoke run." };
  if (run.status === "halted")
    return {
      kind: "runs",
      label: "runs to the end",
      detail: `The smoke run with fixed answers reached the end after ${run.steps} steps.`,
    };
  if (run.status === "failed" && run.failure !== null) {
    const at = `${run.failure.script}${run.failure.line === null ? "" : `:${run.failure.line}`}`;
    return {
      kind: "stops",
      label: `stops at ${at}`,
      detail: `The smoke run failed at ${at}: ${run.failure.code} ${run.failure.message}`,
    };
  }
  if (run.status === "blocked")
    return {
      kind: "stops",
      label: `stops at ${run.blockedTarget ?? "a script"}`,
      detail: `The smoke run reached ${run.blockedTarget ?? "a script"}, which has no runnable conversion.`,
    };
  return {
    kind: "stops",
    label: "run inconclusive",
    detail: `The smoke run ended with ${run.status} after ${run.steps} steps; it may wait for typed text that the fixed answers never give.`,
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
  const measured = [
    ...(measuredAt === null ? [] : [`Measured ${measuredAt.slice(0, 10)}`]),
    ...(importerCommit === null ? [] : [`importer commit ${escapeHtml(importerCommit)}`]),
  ].join(" with ");
  const summary: Array<[string, number]> = [
    ["Listed", entries.length],
    ["Convert fully", entries.filter((entry) => entry.partial === null).length],
    ["Compile", entries.filter((entry) => entry.compiles).length],
    ["Run to the end", count("runs")],
    ["Stop during the run", count("stops")],
    ["Need unbuilt commands", count("unbuilt")],
    ["Do not compile", count("error")],
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
table.summary { width: auto; margin-bottom: 0.3rem; }
table.summary th { position: static; border: 0; font-weight: normal; color: #666; }
table.summary td { border: 0; font-size: 1.3em; font-weight: 600; }
.status { font-size: 0.8em; padding: 0 0.4em; border-radius: 0.3em; white-space: nowrap; background: #eee; color: #333; }
.status.runs { background: #ddf4dd; color: #1d5e1d; }
.status.stops, .status.partial { background: #fff1cc; color: #6b4e00; }
.status.unbuilt { background: #e6e3fb; color: #3c2f86; }
.status.error { background: #fde2e1; color: #8a1c1c; }
details summary { cursor: pointer; }
td.status-cell details summary { list-style: none; }
td.status-cell details p, td.source details p { margin: 0.2rem 0; font-size: 0.85em; color: #555; }
button[data-pin] { font-size: 0.8em; }
@media (max-width: 40rem) {
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
<table class="summary">
<tr>${summary.map(([label]) => `<th>${label}</th>`).join("")}</tr>
<tr>${summary.map(([, value]) => `<td>${value}</td>`).join("")}</tr>
</table>
<p class="meta">${measured}${measured === "" ? "" : ". "}"Run to the end" means that the importer's smoke run from
main.tease finished on one path, with fixed answers and simulated time. MIDI music does not play.</p>
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
    ["title", `<a href="${href}"><b>${escapeHtml(entry.title)}</b></a>`],
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
