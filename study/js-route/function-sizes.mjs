// The size of each generated JavaScript function (its own text, without the functions nested in it), per Tease: the
// largest, and how many functions; prints one JSON line per package or file (research code of the study).
//   node study/js-route/function-sizes.mjs PATH...   (files or package directories, as compare.mjs takes them)
import fs from "node:fs";
import path from "node:path";
import { compileProject, compileSource } from "../../dist/src/index.js";
import { compileProgram } from "./driver.mjs";

function teaseFiles(root, dir = root, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) teaseFiles(root, full, out);
    else if (entry.name.endsWith(".tease")) out.push(path.relative(root, full).split(path.sep).join("/"));
  }
  return out;
}
function planOf(file) {
  if (fs.statSync(file).isDirectory()) {
    const paths = teaseFiles(file);
    const ordered = ["main.tease", ...paths.filter((p) => p !== "main.tease")].filter((p) => paths.includes(p));
    return compileProject(ordered.map((p) => ({ path: p, source: fs.readFileSync(path.join(file, p), "utf8") }))).plan ?? null;
  }
  return compileSource(fs.readFileSync(file, "utf8")).plan ?? null;
}
/** Each function's own length: from `function` to its closing brace, less the functions inside it. */
export function functionSizes(source) {
  const sizes = [];
  const stack = [];
  const re = /function\*? *([\w$]*)\s*\([^)]*\)\s*\{|[{}]|"(?:[^"\\]|\\.)*"|`(?:[^`\\]|\\.)*`/g;
  let m;
  while ((m = re.exec(source)) !== null) {
    const token = m[0];
    if (token.startsWith("function")) stack.push({ name: m[1], start: m.index, depth: 1, nested: 0, isFunction: true });
    else if (token === "{") { if (stack.length > 0) stack.at(-1).depth += 1; }
    else if (token === "}") {
      const top = stack.at(-1);
      if (top === undefined) continue;
      top.depth -= 1;
      if (top.depth === 0) {
        stack.pop();
        const total = m.index + 1 - top.start;
        sizes.push({ name: top.name, own: total - top.nested });
        if (stack.length > 0) stack.at(-1).nested += total;
      }
    }
  }
  return sizes;
}
for (const file of process.argv.slice(2)) {
  const plan = planOf(file);
  if (plan === null) continue;
  for (const form of [false, true]) {
    let source;
    try {
      source = compileProgram(plan, form).source;
    } catch (error) {
      console.log(JSON.stringify({ file: path.basename(file), form: form ? "resumable" : "replay", error: String(error.message).slice(0, 120) }));
      continue;
    }
    const sizes = functionSizes(source).sort((a, b) => b.own - a.own);
    console.log(JSON.stringify({ file: path.basename(file), form: form ? "resumable" : "replay", functions: sizes.length, largest: sizes[0]?.own ?? 0, largestName: sizes[0]?.name, second: sizes[1]?.own ?? 0, total: source.length, planInstructions: plan.instructions.length }));
  }
}
