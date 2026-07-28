import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const rootArgument = process.argv[2] === "--root" ? process.argv[3] : undefined;
if (process.argv.length !== (rootArgument === undefined ? 2 : 4)) {
  throw new Error("Usage: node tools/check-legacy-imports.mjs [--root directory]");
}
const root = rootArgument === undefined ? repositoryRoot : path.resolve(rootArgument);
const compatibilityTest = "tests/source-layout-compatibility.test.ts";
const legacyModules = [
  {
    legacyPath: "src/instructions.ts",
    canonicalPath: "src/plan/model.ts, src/plan/capture.ts, src/plan/validation.ts, or src/compiler/compile-program.ts",
  },
  {
    legacyPath: "src/libraries/public.ts",
    canonicalPath: "src/library-tooling/public.ts",
  },
  {
    legacyPath: "playground/workspace.ts",
    canonicalPath: "playground/workspace/controller.ts",
  },
];
const extensions = new Set([".ts", ".mjs", ".js"]);
const allowedFiles = new Set([
  "src/instructions.ts",
  "src/libraries/public.ts",
  "playground/workspace.ts",
  compatibilityTest,
]);
const checkerFixtureDirectory = path.resolve(
  repositoryRoot,
  "tests/fixtures/legacy-import-checker",
);

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

function staticModuleSpecifiers(source) {
  const matches = [];
  const patterns = [
    /\bimport\s*(["'])([^"']+)\1/gu,
    /\b(?:import|export)\s+(?:type\s+)?[\s\S]*?\s+from\s*(["'])([^"']+)\1/gu,
  ];
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) {
      const specifierStart = match.index + match[0].lastIndexOf(match[2]);
      matches.push({ specifier: match[2], offset: specifierStart });
    }
  }
  return matches.sort((left, right) => left.offset - right.offset || left.specifier.localeCompare(right.specifier));
}

function normalizeModulePath(absolute) {
  const extension = path.extname(absolute);
  return extension === ".ts" || extension === ".js" || extension === ".mjs"
    ? absolute.slice(0, -extension.length)
    : absolute;
}

function resolveSpecifier(importingFile, specifier) {
  if (specifier.startsWith(".")) return normalizeModulePath(path.resolve(path.dirname(importingFile), specifier));
  if (specifier.startsWith("src/") || specifier.startsWith("playground/")) {
    return normalizeModulePath(path.resolve(root, specifier));
  }
  return null;
}

function lineForOffset(source, offset) {
  return source.slice(0, offset).split(/\r?\n/u).length;
}

const violations = [];
for (const absolute of filesIn(root)) {
  // These deliberately-invalid static files are invoked only through --root by
  // the focused checker test below; they are not repository import consumers.
  if (root === repositoryRoot && absolute.startsWith(`${checkerFixtureDirectory}${path.sep}`)) continue;
  const relative = path.relative(root, absolute).split(path.sep).join("/");
  if (allowedFiles.has(relative)) continue;
  const source = fs.readFileSync(absolute, "utf8");
  for (const { specifier, offset } of staticModuleSpecifiers(source)) {
    const resolved = resolveSpecifier(absolute, specifier);
    if (resolved === null) continue;
    const legacy = legacyModules.find((entry) =>
      resolved === normalizeModulePath(path.resolve(root, entry.legacyPath)));
    if (legacy === undefined) continue;
    violations.push(
      `${relative}:${lineForOffset(source, offset)}: legacy import '${specifier}' resolves to ${legacy.legacyPath}; import ${legacy.canonicalPath} instead.`,
    );
  }
}

if (violations.length > 0) {
  console.error(violations.join("\n"));
  process.exitCode = 1;
} else {
  console.log("legacy import check passed");
}
