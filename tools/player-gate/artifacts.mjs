// The artifact inventory of one Player build (`l5-gate.md` part 4, bytes): each served file of its output (source maps
// left out) with its raw, gzip and brotli size, and its classes: eager (what `index.html` names and their static
// imports), Worker (each Worker entry, a file whose name says Worker, and its static imports), lazy (the rest). A file in
// two classes is listed once, under both, and counted once in the overall total.
//   node tools/player-gate/artifacts.mjs --app DIR --build NAME > inventory.json
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { parseArgs } from "node:util";
import { brotliCompressSync, constants, gzipSync } from "node:zlib";

const { values } = parseArgs({ options: { app: { type: "string" }, build: { type: "string" } } });
if (!values.app || !values.build) throw new Error("usage: artifacts.mjs --app DIR --build NAME");

const files = [];
const walk = (dir) => {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) walk(path);
    else if (!name.endsWith(".map")) files.push(relative(values.app, path));
  }
};
walk(values.app);
const text = (file) => readFileSync(join(values.app, file), "utf8");
const byName = new Map(files.map((file) => [file.split("/").at(-1), file]));

/** The files `file` imports statically (`import "./x.js"`, `from "./x.js"`), by their output path. */
function staticImports(file) {
  if (!file.endsWith(".js")) return [];
  const found = [];
  for (const match of text(file).matchAll(/(?:\bfrom|\bimport)\s*["']\.\/([^"']+)["']/gu)) {
    const target = byName.get(match[1]);
    if (target !== undefined) found.push(target);
  }
  return found;
}
/** `roots` and everything they import statically. */
function closure(roots) {
  const seen = new Set();
  const visit = (file) => {
    if (seen.has(file)) return;
    seen.add(file);
    for (const next of staticImports(file)) visit(next);
  };
  for (const root of roots) visit(root);
  return seen;
}

const named = [...text("index.html").matchAll(/(?:src|href)="[^"]*\/([^"/]+)"/gu)]
  .map((match) => byName.get(match[1]))
  .filter((file) => file !== undefined);
const eager = closure(["index.html", ...named]);
const worker = closure(files.filter((file) => /worker/iu.test(file.split("/").at(-1))));
const inventory = files.sort().map((file) => {
  const bytes = readFileSync(join(values.app, file));
  const classes = [eager.has(file) && "eager", worker.has(file) && "Worker"].filter(Boolean);
  return {
    file,
    classes: classes.length === 0 ? ["lazy"] : classes,
    raw: bytes.length,
    gzip: gzipSync(bytes, { level: 9 }).length,
    brotli: brotliCompressSync(bytes, { params: { [constants.BROTLI_PARAM_QUALITY]: 11 } }).length,
  };
});
const totals = {};
const add = (name, entry) => {
  totals[name] ??= { raw: 0, gzip: 0, brotli: 0 };
  for (const size of ["raw", "gzip", "brotli"]) totals[name][size] += entry[size];
};
for (const entry of inventory) {
  for (const name of entry.classes) add(name, entry);
  add("all, each file once", entry);
}
console.log(JSON.stringify({ build: values.build, files: inventory, totals }, null, 2));
