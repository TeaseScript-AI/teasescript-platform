// Makes the measurement lane's handoff of real Teases: for each package folder, its plan as JSON and the program's text
// in the three forms, for reading and sizes (the driver emits the same text from the plan when a session starts).
//   node study/js-route/tease-handoff.mjs OUT-DIR PACKAGE-DIR...
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { compileProject } from "../../dist/src/index.js";
import { emitProgram } from "./emit.mjs";

const [out, ...packages] = process.argv.slice(2);
const teaseFiles = (root, dir = root) =>
  fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1)).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return teaseFiles(root, full);
    return entry.name.endsWith(".tease") ? [path.relative(root, full).split(path.sep).join("/")] : [];
  });
const sizes = {};
for (const dir of packages) {
  const name = path.basename(dir).replace(/[^A-Za-z0-9._-]/g, "_");
  const paths = teaseFiles(dir);
  const ordered = ["main.tease", ...paths.filter((p) => p !== "main.tease")].filter((p) => paths.includes(p));
  const { plan } = compileProject(ordered.map((p) => ({ path: p, source: fs.readFileSync(path.join(dir, p), "utf8") })));
  const planJson = JSON.stringify(plan);
  fs.writeFileSync(path.join(out, `${name}.plan.json`), planJson);
  sizes[name] = { files: ordered.length, planInstructions: plan.instructions.length, planJson: planJson.length, planJsonGzip: zlib.gzipSync(planJson).length };
  for (const [form, options] of [["replay", {}], ["kept", { generators: true }], ["resumable", { resumable: true }]]) {
    const { source } = emitProgram(plan, options);
    fs.writeFileSync(path.join(out, `${name}.${form}.js`), source);
    sizes[name][form] = { bytes: source.length, gzip: zlib.gzipSync(source).length };
  }
}
fs.writeFileSync(path.join(out, "sizes.json"), JSON.stringify(sizes, null, 1));
