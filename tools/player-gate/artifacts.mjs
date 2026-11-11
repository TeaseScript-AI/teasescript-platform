// The artifact inventory of one Player build (`l5-gate.md` part 4, bytes): each served file of its output (source maps
// left out) with its raw, gzip and brotli size, and its classes:
// - eager: what `index.html` names, and the files those import statically;
// - Worker: each Worker entry (a file whose name says Worker), and the files it imports, statically or by `import()`;
// - lazy: the rest of what `index.html`'s files reach by `import()`, and every file that is not JavaScript.
// A file in two classes is listed once, under both, and counted once in the overall total. An import is read only in
// the forms the build writes, `from "./x.js"`, `import "./x.js"` and `import("./x.js")`, the last also with a template
// string without substitutions: a JavaScript file that no root reaches, or an `import(` of any other form, fails the
// inventory, as its class would be a guess.
//   node tools/player-gate/artifacts.mjs --app DIR --build NAME > inventory.json
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { parseArgs } from "node:util";
import { brotliCompressSync, constants, gzipSync } from "node:zlib";

const STATIC = /(?:\bfrom|\bimport)\s*["']\.\/([^"']+)["']/gu;
// A path with a substitution (`${…}`) is no path the inventory can read, so it is left to ANY_DYNAMIC's count.
const DYNAMIC = /(?<![\w$.])import\(\s*(["'`])\.\/([^"'`$]+)\1\s*\)/gu;
// Every `import(`, also with spaces or comments before its parenthesis.
const ANY_DYNAMIC = /(?<![\w$.])import(?:\s|\/\*[\s\S]*?\*\/)*\(/gu;

/** The inventory of the build in `app`, named `build`; throws for a file it cannot class. */
export function inventoryOf(app, build) {
  const files = [];
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) walk(path);
      else if (!name.endsWith(".map")) files.push(relative(app, path));
    }
  };
  walk(app);
  const text = (file) => readFileSync(join(app, file), "utf8");
  const byName = new Map(files.map((file) => [file.split("/").at(-1), file]));
  const isScript = (file) => file.endsWith(".js");

  /** The files `file` imports by `pattern`'s form, by their output path. */
  const imports = (file, pattern) =>
    isScript(file)
      ? [...text(file).matchAll(pattern)].map((match) => byName.get(match.at(-1))).filter(Boolean)
      : [];
  for (const file of files.filter(isScript)) {
    const all = [...text(file).matchAll(ANY_DYNAMIC)].length;
    const read = [...text(file).matchAll(DYNAMIC)].length;
    if (all !== read)
      throw new Error(`${file}: ${all - read} import() of a form the inventory does not read`);
  }
  /** `roots` and what they import by the given forms. */
  const closure = (roots, patterns) => {
    const seen = new Set();
    const visit = (file) => {
      if (seen.has(file)) return;
      seen.add(file);
      for (const pattern of patterns) for (const next of imports(file, pattern)) visit(next);
    };
    for (const root of roots) visit(root);
    return seen;
  };

  const named = [...text("index.html").matchAll(/(?:src|href)="[^"]*\/([^"/]+)"/gu)]
    .map((match) => byName.get(match[1]))
    .filter((file) => file !== undefined);
  const eager = closure(["index.html", ...named], [STATIC]);
  const lazy = closure(eager, [STATIC, DYNAMIC]);
  const worker = closure(
    files.filter((file) => /worker/iu.test(file.split("/").at(-1))),
    [STATIC, DYNAMIC],
  );
  const unreached = files.filter((file) => isScript(file) && !lazy.has(file) && !worker.has(file));
  if (unreached.length > 0)
    throw new Error(`no root reaches ${unreached.join(", ")}: their class is unknown`);
  const inventory = files.sort().map((file) => {
    const bytes = readFileSync(join(app, file));
    const classes = [
      eager.has(file) && "eager",
      worker.has(file) && "Worker",
      !eager.has(file) && (lazy.has(file) || !isScript(file)) && "lazy",
    ].filter(Boolean);
    return {
      file,
      classes,
      raw: bytes.length,
      gzip: gzipSync(bytes, { level: 9 }).length,
      brotli: brotliCompressSync(bytes, { params: { [constants.BROTLI_PARAM_QUALITY]: 11 } })
        .length,
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
  return { build, files: inventory, totals };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { values } = parseArgs({ options: { app: { type: "string" }, build: { type: "string" } } });
  if (!values.app || !values.build) throw new Error("usage: artifacts.mjs --app DIR --build NAME");
  console.log(JSON.stringify(inventoryOf(values.app, values.build), null, 2));
}
