import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const compatibilityTest = "tests/source-layout-compatibility.test.ts";
const rules = [
  { label: "src/instructions", pattern: /(?:\.\.\/|\.\/|from\s*["'])src\/instructions(?:\.js|\.ts)?/u },
  { label: "src/libraries/public", pattern: /(?:\.\.\/|\.\/|from\s*["'])src\/libraries\/public(?:\.js|\.ts)?/u },
  { label: "playground/workspace", pattern: /(?:\.\.\/|\.\/|from\s*["'])playground\/workspace(?:\.js|\.ts)(?:["']|$)/u },
];
const extensions = new Set([".ts", ".mjs", ".js"]);
const allowedFiles = new Set([
  "src/instructions.ts",
  "src/libraries/public.ts",
  compatibilityTest,
]);

function filesIn(directory) {
  const output = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === "dist" || entry.name.startsWith(".")) continue;
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) output.push(...filesIn(absolute));
    else if (extensions.has(path.extname(entry.name))) output.push(absolute);
  }
  return output;
}

const violations = [];
for (const absolute of filesIn(root)) {
  const relative = path.relative(root, absolute).split(path.sep).join("/");
  if (allowedFiles.has(relative)) continue;
  const lines = fs.readFileSync(absolute, "utf8").split(/\r?\n/u);
  lines.forEach((line, index) => {
    for (const rule of rules) {
      if (rule.pattern.test(line)) violations.push(`${relative}:${index + 1}: legacy import '${rule.label}' is not allowed; import the canonical module or use ${compatibilityTest}`);
    }
  });
}

if (violations.length > 0) {
  console.error(violations.join("\n"));
  process.exitCode = 1;
} else {
  console.log("legacy import check passed");
}
