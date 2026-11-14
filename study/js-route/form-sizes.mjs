// The program's size in the three forms, raw and compressed, for Tease packages; and for the largest, the time to turn
// the text into a function and to import it as a module (Node's reference for the phone).
//   node study/js-route/form-sizes.mjs sizes PACKAGE-DIR...          one JSON line per package: raw and gzip per form
//   node study/js-route/form-sizes.mjs detail OUT-DIR PACKAGE-DIR... per form: raw, gzip -9, brotli 11, load times;
//                                                                     writes NAME.FORM.js to OUT-DIR
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { pathToFileURL } from "node:url";
import { performance } from "node:perf_hooks";
import { compileProject } from "../../dist/src/index.js";
import { emitProgram } from "./emit.mjs";

const FORMS = [["replay", {}], ["kept", { generators: true }], ["resumable", { resumable: true }]];
const teaseFiles = (root, dir = root) =>
  fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1)).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return teaseFiles(root, full);
    return entry.name.endsWith(".tease") ? [path.relative(root, full).split(path.sep).join("/")] : [];
  });
function planOf(dir) {
  const paths = teaseFiles(dir);
  const ordered = ["main.tease", ...paths.filter((p) => p !== "main.tease")].filter((p) => paths.includes(p));
  return compileProject(ordered.map((p) => ({ path: p, source: fs.readFileSync(path.join(dir, p), "utf8") }))).plan;
}
const gzip = (text) => zlib.gzipSync(text, { level: 9 }).length;
const brotli = (text) => zlib.brotliCompressSync(text, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 11, [zlib.constants.BROTLI_PARAM_SIZE_HINT]: text.length } }).length;
const [mode, ...rest] = process.argv.slice(2);
if (mode === "sizes") {
  for (const dir of rest) {
    const plan = planOf(dir);
    if (!plan) continue;
    const row = { file: path.basename(dir) };
    for (const [form, options] of FORMS) {
      try {
        const { source } = emitProgram(plan, options);
        row[form] = { raw: source.length, gzip: gzip(source) };
      } catch (error) {
        row[form] = { error: String(error.message).slice(0, 80) };
      }
    }
    console.log(JSON.stringify(row));
  }
} else {
  const [out, ...dirs] = rest;
  for (const dir of dirs) {
    const name = path.basename(dir).replace(/[^A-Za-z0-9._-]/g, "_");
    const plan = planOf(dir);
    for (const [form, options] of FORMS) {
      const { source, constants } = emitProgram(plan, options);
      fs.writeFileSync(path.join(out, `${name}.${form}.js`), source);
      const t0 = performance.now();
      new Function("rt", "K", source);
      const newFunctionMs = performance.now() - t0;
      const modulePath = path.join(process.env.G_DIR ?? os.tmpdir(), `${name}.${form}.mjs`);
      fs.writeFileSync(modulePath, `const K = JSON.parse(${JSON.stringify(JSON.stringify(constants))});\nexport default function program(rt) {\n${source}\n}\nexport { K };\n`);
      const t1 = performance.now();
      await import(pathToFileURL(modulePath).href);
      const importMs = performance.now() - t1;
      console.log(JSON.stringify({ file: name, form, raw: source.length, gzip: gzip(source), brotli: brotli(source), newFunctionMs: Math.round(newFunctionMs * 10) / 10, moduleImportMs: Math.round(importMs * 10) / 10, moduleBytes: fs.statSync(modulePath).size }));
    }
  }
}
