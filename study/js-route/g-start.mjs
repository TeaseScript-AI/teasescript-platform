// Part G (research code of the study): the start cost of making the JavaScript where it runs against loading it made.
// Made there: the plan (compiled from the sources, as the editor's Run does, or parsed from a published plan's JSON),
// emitted, and turned into a function. Loaded: a module file holding the same program, imported. Each step's first
// time in this process and its median over three more; sizes in bytes.
//   node study/js-route/g-start.mjs FILE.tease|PACKAGE-DIR   (one JSON line)
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { performance } from "node:perf_hooks";
import zlib from "node:zlib";
import { compileProject, compileSource } from "../../dist/src/index.js";
import { emitProgram, Unsupported } from "./emit.mjs";

function teaseFiles(root, dir = root, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) teaseFiles(root, full, out);
    else if (entry.name.endsWith(".tease")) out.push(path.relative(root, full).split(path.sep).join("/"));
  }
  return out;
}
const file = process.argv[2];
const sources = fs.statSync(file).isDirectory()
  ? (() => {
      const paths = teaseFiles(file);
      return ["main.tease", ...paths.filter((p) => p !== "main.tease")].filter((p) => paths.includes(p)).map((p) => ({ path: p, source: fs.readFileSync(path.join(file, p), "utf8") }));
    })()
  : [{ path: "main.tease", source: fs.readFileSync(file, "utf8") }];
const compile = () => (sources.length === 1 && !fs.statSync(file).isDirectory() ? compileSource(sources[0].source) : compileProject(sources)).plan;

const timed = (f) => {
  const t0 = performance.now();
  const value = f();
  return [performance.now() - t0, value];
};
const timedAsync = async (f) => {
  const t0 = performance.now();
  const value = await f();
  return [performance.now() - t0, value];
};
const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
const round = (x) => Math.round(x * 100) / 100;

const row = { file: path.basename(file), sourceBytes: sources.reduce((n, s) => n + s.source.length, 0) };
const steps = { compile: [], parsePlan: [], emit: [], newFunction: [], importModule: [] };
// The module files stay behind: G_DIR is the job's scratch folder, which the queue removes.
const dir = fs.mkdtempSync(path.join(process.env.G_DIR ?? os.tmpdir(), "g-start-"));
{
  for (let i = 0; i < 4; i += 1) {
    const [compileMs, plan] = timed(compile);
    if (!plan) {
      console.log(JSON.stringify({ ...row, verdict: "uncompiled" }));
      process.exit(0);
    }
    steps.compile.push(compileMs);
    const planJson = JSON.stringify(plan);
    const [parseMs, parsed] = timed(() => JSON.parse(planJson));
    steps.parsePlan.push(parseMs);
    let emitted;
    try {
      const [emitMs, value] = timed(() => emitProgram(parsed));
      steps.emit.push(emitMs);
      emitted = value;
    } catch (error) {
      if (!(error instanceof Unsupported)) throw error;
      console.log(JSON.stringify({ ...row, verdict: "unsupported" }));
      process.exit(0);
    }
    const [functionMs] = timed(() => new Function("rt", "K", emitted.source));
    steps.newFunction.push(functionMs);
    // The published form: the constants as JSON in the module, the program as its default export.
    const moduleText = `const K = JSON.parse(${JSON.stringify(JSON.stringify(emitted.constants))});\nexport default function program(rt) {\n${emitted.source}\n}\nexport { K };\n`;
    const modulePath = path.join(dir, `program-${i}.mjs`);
    fs.writeFileSync(modulePath, moduleText);
    const [importMs] = await timedAsync(() => import(pathToFileURL(modulePath).href));
    steps.importModule.push(importMs);
    if (i === 0)
      Object.assign(row, {
        planJsonBytes: planJson.length, planJsonGzip: zlib.gzipSync(planJson).length,
        moduleBytes: moduleText.length, moduleGzip: zlib.gzipSync(moduleText).length,
        constantsRoundTrip: JSON.stringify(JSON.parse(JSON.stringify(emitted.constants))) === JSON.stringify(emitted.constants),
      });
  }
}
for (const [step, times] of Object.entries(steps)) row[step] = { first: round(times[0]), later: round(median(times.slice(1))) };
console.log(JSON.stringify({ ...row, verdict: "measured" }));
