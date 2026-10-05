/**
 * Freezes a package that plays correctly as a verified copy, so later conversions cannot replace it, and records it in
 * `docs/VERIFIED.md`.
 *
 * Usage: node tools/verify-package.ts --checks <play-check-dir> --verified <dir> --manual "<what was played by hand>"
 *   <converted-root> <id>
 *
 * The package's latest `play-check.ts` result must be for its current `.tease` files, with every run ending normally
 * and no media missing. The copy holds the `.tease` files and the conversion records, with the media hard-linked, and
 * a `.verified.json` with the date, the importer commit, and the paths played. An existing verified copy is never
 * replaced.
 */
import { copyFile, link, mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { isRecord } from "../src/ast.ts";
import { packageContentHash, parsePlayCheck } from "./catalog.ts";

const DOC = fileURLToPath(new URL("../docs/VERIFIED.md", import.meta.url));
const DOC_HEADER = `# Verified packages

Converted packages that played correctly in the Player, automatically on several paths and in a manual check. Their
frozen copies in \`external/verified/<unit>/\` are served instead of later conversions; \`tools/verify-package.ts\` adds
a row. A newer conversion that fails where the verified copy passed is a regression to report, not a replacement.

| Unit | Date | Importer commit | Paths played |
| --- | --- | --- | --- |
`;

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: { checks: { type: "string" }, verified: { type: "string" }, manual: { type: "string" } },
});
if (
  positionals.length !== 2 ||
  values.checks === undefined ||
  values.verified === undefined ||
  values.manual === undefined
) {
  process.stderr.write(
    'Usage: node tools/verify-package.ts --checks <dir> --verified <dir> --manual "<note>" <converted-root> <id>\n',
  );
  process.exit(2);
}
const [root, id] = [path.resolve(positionals[0]!), positionals[1]!];
const source = path.join(root, id);
const target = path.join(path.resolve(values.verified), id);
if (
  await stat(target).then(
    () => true,
    () => false,
  )
)
  fail(`${target} already exists; a verified copy is never replaced.`);

const files = (await readdir(source, { recursive: true, withFileTypes: true }))
  .filter((entry) => entry.isFile())
  .map((entry) =>
    path.relative(source, path.join(entry.parentPath, entry.name)).split(path.sep).join("/"),
  )
  .filter(
    (file) =>
      !file.split("/").some((segment) => segment.startsWith(".")) ||
      /^\.(conversion|report)\.json$/u.test(file),
  );
const sources = await Promise.all(
  files
    .filter((file) => file.endsWith(".tease"))
    .map(async (file) => ({ path: file, source: await readFile(path.join(source, file), "utf8") })),
);
const check = parsePlayCheck(
  JSON.parse(await readFile(path.join(values.checks, id, "result.json"), "utf8")),
);
if (check === null) fail("The Player check result is malformed.");
if (check.contentHash !== packageContentHash(sources))
  fail("The Player check is of other .tease files than the package has now.");
if (check.verdict !== "plays") fail(`The Player check verdict is ${check.verdict}, not plays.`);
if (check.missingImages.length + check.missingMedia.length > 0)
  fail("The Player check found missing media.");
const importerCommit = await readFile(path.join(root, ".conversion-summary.json"), "utf8").then(
  (text) => {
    const summary: unknown = JSON.parse(text);
    return isRecord(summary) && typeof summary.importerCommit === "string"
      ? summary.importerCommit
      : "unknown";
  },
  () => "unknown",
);
const date = new Date().toISOString().slice(0, 10);
const { files: covered, fileCount, sites, siteCount, choices } = check.coverage;
const paths = `${check.runs.length} automated runs to the end (${covered.length}/${fileCount} files, ${sites}/${siteCount} interactions, ${choices} choices); manual: ${values.manual}`;

for (const file of files) {
  const from = path.join(source, ...file.split("/"));
  const to = path.join(target, ...file.split("/"));
  await mkdir(path.dirname(to), { recursive: true });
  // Text is copied so the frozen package keeps it; media keep sharing the corpus's unchanging content.
  if (file.endsWith(".tease") || file.endsWith(".json")) await copyFile(from, to);
  else await link(from, to);
}
await writeFile(
  path.join(target, ".verified.json"),
  `${JSON.stringify({ date, importerCommit, contentHash: check.contentHash, checkedAt: check.checkedAt, paths }, null, 2)}\n`,
);
const doc = await readFile(DOC, "utf8").catch(() => DOC_HEADER);
await writeFile(
  DOC,
  `${doc}| \`${id}\` | ${date} | ${importerCommit} | ${paths.replaceAll("|", "\\|")} |\n`,
);
process.stderr.write(`Verified ${id} into ${target}.\n`);

function fail(message: string): never {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}
