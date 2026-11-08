import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { posix } from "node:path";
import { fileURLToPath } from "node:url";

import { ts } from "ts-morph";

// Checks the direction of the imports that the repository's documents declare, and refuses cycles of value imports
// (`npm run check:imports`, part of `check:pretest`); one line per finding, then an advisory line:
//
//   node tools/repository-checks/imports.mjs
//
// Every code file Git lists (tracked, and untracked but not ignored; `.ts`, `.tsx`, `.mts`, `.cts`, `.js`, `.mjs`,
// `.cjs`, and a `.vue` file's `<script>` blocks) is read with TypeScript's parser, outside `tests/fixtures/`, whose
// files are deliberate shapes. An import is a static `import` or `export … from`, an `import()`, a `require()` or an
// `import("…")` type; it is type-only when TypeScript erases it (`import type`, all-`type` specifiers, `export type`,
// an `import("…")` type). Relative specifiers resolve from the file (a `.js` name to its `.ts` source), `@/` to
// `player/vue/src/`; a query (`?raw`) is not part of the path.
//
// The declared boundaries count every import, type-only ones too, as they couple the folders alike:
// - B1, `src/` imports nothing under `player/` or `playground/`: `docs/ARCHITECTURE.md` "Implemented deterministic
//   vertical slice" (parse … runtime state and events, then the playground and the framework-independent Player
//   adapter, then the Vue Player).
// - B2, `src/` imports only the packages `PACKAGES` admits for it: `CURRENT-DESIGN.md` "System map" ("The engine and
//   shared domain contracts remain framework-independent TypeScript") and `docs/ARCHITECTURE.md` "Accepted
//   boundaries".
// - B3, `player/` outside `player/vue/` imports nothing under `player/vue/`, and only the packages `PACKAGES` admits for
//   it: `docs/ARCHITECTURE.md` "Implemented deterministic vertical slice" (the framework-independent Player adapter
//   before the Vue Player) and "Implemented source-layout seams"; `player/README.md` "Implementation seams".
// Each admitted package names its reason; a package that belongs is one more line there, and adding a dependency
// needs `AGENTS.md`'s justification first. Node's built-ins are admitted only in `NODE_FILES`: the browser bundle
// loads the rest of `player/`.
//
// Cycles (`IMPLEMENTATION-AND-REVIEW.md` "Code structure": "dependencies run one way, without cycles"): a group of
// files that reach each other through value imports (static or dynamic) is refused.
//
// `imports-waiting.json` lists what waits for another pull request: a cycle group, exactly, or one boundary crossing
// (the importing file and what it imports). A listed entry no longer found fails, so the list only shrinks. Type-only imports set no
// load order, and their usual cycle is a callee typed against its caller's interface: their cycles are not refused,
// and the last line counts the groups that form a cycle once they count, advisory.
//
// Not declared, so not checked: product code (`src/`, `player/`, `playground/`) importing `tests/` or `tools/`;
// `src/runtime/` importing the compiler or the parser; `player/vue/` importing `playground/`
// (`player/vue/src/packageHost.ts` → `playground/package-catalog.ts`); ADR 0017's Standard Library and privileged
// adapter layers, which have no modules yet.
//
// Exit status: 1 when a boundary is crossed, an unlisted cycle exists or a listed one is gone, else 0.

const repositoryRoot = fileURLToPath(new URL("../../", import.meta.url));

const CODE = /\.(?:ts|tsx|mts|cts|js|mjs|cjs|vue)$/u;

/** The packages each framework-independent area may import, each with why it may. */
export const PACKAGES = {
  "src/": {
    "colorjs.io": "colour values' conversions and contrast (`src/color.ts`)",
    re2js: "regular expressions on RE2, as the built-ins rule requires (`src/regex-engine.ts`)",
  },
  "player/": {
    "@material/material-color-utilities":
      "the Player's theme palettes (`player/theme/material.ts`)",
    "@noble/ciphers": "the encryption of locked values (`player/encryption/age.ts`)",
    "@noble/curves": "the encryption's key agreement and time locks (`player/encryption/`)",
    "@noble/hashes": "the encryption's hashes (`player/encryption/`)",
    "colorjs.io": "theme colours (`player/theme/color.ts`)",
  },
};

/** The `player/` files that only Node loads, which may import Node's built-ins, each pattern with why. */
export const NODE_FILES = [
  {
    pattern: /^player\/engine-bridge\/node-[^/]+\.ts$/u,
    reason:
      "the engine host's Node transport (`node:worker_threads`), which the browser bundle does not load",
  },
];

const BOUNDARIES = {
  B1: {
    rule: "`src/` imports nothing under `player/` or `playground/`",
    source: '`docs/ARCHITECTURE.md` "Implemented deterministic vertical slice"',
  },
  B2: {
    rule: "`src/` imports only the packages `PACKAGES` admits for it",
    source: '`CURRENT-DESIGN.md` "System map", `docs/ARCHITECTURE.md` "Accepted boundaries"',
  },
  B3: {
    rule: "`player/` outside `player/vue/` imports nothing under `player/vue/`, and only the packages `PACKAGES` admits for it",
    source:
      '`docs/ARCHITECTURE.md` "Implemented deterministic vertical slice", `player/README.md` "Implementation seams"',
  },
};

/** The area of `file` whose boundaries apply to it, if any. */
const areaOf = (file) =>
  file.startsWith("src/")
    ? "src/"
    : file.startsWith("player/") && !file.startsWith("player/vue/")
      ? "player/"
      : null;

/** A package specifier's package: `node:` for a Node built-in, the scope and name for a scoped one. */
function packageOf(specifier) {
  if (specifier.startsWith("node:")) return "node:";
  const parts = specifier.split("/");
  return specifier.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0];
}

/** Each import in a parsed `source`: `{ specifier, typeOnly, line }`, lines from 1 plus `lineOffset`. */
function importsOf(source, lineOffset) {
  const found = [];
  const add = (literal, typeOnly) =>
    found.push({
      specifier: literal.text,
      typeOnly,
      line: source.getLineAndCharacterOfPosition(literal.getStart(source)).line + 1 + lineOffset,
    });
  const visit = (node) => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      const clause = node.importClause;
      const named = clause?.namedBindings;
      add(
        node.moduleSpecifier,
        clause !== undefined &&
          (clause.isTypeOnly ||
            (clause.name === undefined &&
              named !== undefined &&
              ts.isNamedImports(named) &&
              named.elements.length > 0 &&
              named.elements.every((element) => element.isTypeOnly))),
      );
    } else if (
      ts.isExportDeclaration(node) &&
      node.moduleSpecifier !== undefined &&
      ts.isStringLiteral(node.moduleSpecifier)
    )
      add(node.moduleSpecifier, node.isTypeOnly);
    else if (
      ts.isCallExpression(node) &&
      (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(node.expression) && node.expression.text === "require")) &&
      node.arguments[0] !== undefined &&
      ts.isStringLiteralLike(node.arguments[0])
    )
      add(node.arguments[0], false);
    else if (
      ts.isImportTypeNode(node) &&
      ts.isLiteralTypeNode(node.argument) &&
      ts.isStringLiteral(node.argument.literal)
    )
      add(node.argument.literal, true);
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

/** A code file's parsed scripts: the file itself, or a `.vue` file's `<script>` blocks, each with its line offset. */
function scriptsOf(file, text) {
  const parse = (name, script) =>
    ts.createSourceFile(
      name,
      script,
      ts.ScriptTarget.Latest,
      true,
      ts.getScriptKindFromFileName(name) || ts.ScriptKind.TS,
    );
  if (!file.endsWith(".vue")) return [{ source: parse(file, text), lineOffset: 0 }];
  return [...text.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gu)].map((match) => ({
    source: parse(`${file}.ts`, match[1]),
    lineOffset: text.slice(0, match.index + match[0].indexOf(match[1])).split("\n").length - 1,
  }));
}

/** The repository file a relative or `@/` `specifier` in `file` names, or `null` for a package. */
function resolved(file, specifier, files) {
  let base;
  if (specifier.startsWith("./") || specifier.startsWith("../"))
    base = posix.normalize(posix.join(posix.dirname(file), specifier.split("?")[0]));
  else if (specifier.startsWith("@/"))
    base = posix.normalize(`player/vue/src/${specifier.slice(2).split("?")[0]}`);
  else return null;
  const candidates = [base];
  for (const [js, sources] of [
    [".js", [".ts", ".tsx"]],
    [".mjs", [".mts"]],
    [".cjs", [".cts"]],
  ])
    if (base.endsWith(js))
      for (const source of sources) candidates.push(base.slice(0, -js.length) + source);
  for (const extension of [".ts", ".tsx", ".vue", ".mjs", ".js", "/index.ts", "/index.js"])
    candidates.push(base + extension);
  return candidates.find((candidate) => files.has(candidate)) ?? base;
}

/** Strongly connected groups of more than one file in `edges` (a map of file to the files it imports), each sorted. */
function cycleGroups(nodes, edges) {
  let next = 0;
  const index = new Map();
  const low = new Map();
  const stack = [];
  const onStack = new Set();
  const groups = [];
  for (const start of nodes) {
    if (index.has(start)) continue;
    const work = [[start, 0]];
    index.set(start, next);
    low.set(start, next);
    next += 1;
    stack.push(start);
    onStack.add(start);
    while (work.length > 0) {
      const top = work[work.length - 1];
      const [node, at] = top;
      const targets = edges.get(node) ?? [];
      if (at < targets.length) {
        top[1] += 1;
        const target = targets[at];
        if (!index.has(target)) {
          index.set(target, next);
          low.set(target, next);
          next += 1;
          stack.push(target);
          onStack.add(target);
          work.push([target, 0]);
        } else if (onStack.has(target)) low.set(node, Math.min(low.get(node), index.get(target)));
        continue;
      }
      work.pop();
      if (work.length > 0) {
        const parent = work[work.length - 1][0];
        low.set(parent, Math.min(low.get(parent), low.get(node)));
      }
      if (low.get(node) === index.get(node)) {
        const group = [];
        let member;
        do {
          member = stack.pop();
          onStack.delete(member);
          group.push(member);
        } while (member !== node);
        if (group.length > 1) groups.push(group.sort());
      }
    }
  }
  return groups.sort((one, other) => other.length - one.length || (one[0] < other[0] ? -1 : 1));
}

/** One loop through a cycle group, from its first file, along value imports inside the group. */
function loopThrough(group, edges) {
  const inside = new Set(group);
  const start = group[0];
  const previous = new Map([[start, null]]);
  const queue = [start];
  while (queue.length > 0) {
    const node = queue.shift();
    for (const target of edges.get(node) ?? []) {
      if (!inside.has(target)) continue;
      if (target === start) {
        const path = [];
        for (let at = node; at !== null; at = previous.get(at)) path.unshift(at);
        return [...path, start];
      }
      if (!previous.has(target)) {
        previous.set(target, node);
        queue.push(target);
      }
    }
  }
  return [start];
}

/** The files Git lists at `root` (tracked, and untracked but not ignored), relative and `/`-separated. */
function repositoryFiles(root) {
  return execFileSync("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  })
    .split("\0")
    .filter((file) => file !== "");
}

/**
 * The findings of the repository at `root` against the waiting list `waiting`, whose entries each name a cycle group
 * (`{ cycle, waits }`) or one boundary crossing (`{ file, imports, waits }`: the importing file, and the imported file
 * or package as its message names it): each finding `{ fileName, line, message }`; and the advisory count of
 * type-only cycles, `{ groups, largest }`.
 */
export function checkImports(root, waiting) {
  const crossings = waiting
    .filter((entry) => entry.file !== undefined)
    .map((entry) => ({ ...entry, found: false }));
  const files = new Set(
    repositoryFiles(root).filter((file) => CODE.test(file) && !file.startsWith("tests/fixtures/")),
  );
  const findings = [];
  const valueEdges = new Map();
  const allEdges = new Map();
  for (const file of [...files].sort()) {
    const area = areaOf(file);
    for (const { source, lineOffset } of scriptsOf(file, readFileSync(`${root}/${file}`, "utf8")))
      for (const { specifier, typeOnly, line } of importsOf(source, lineOffset)) {
        const target = resolved(file, specifier, files);
        const report = (id, message) => {
          const imported = target ?? packageOf(specifier);
          const entry = crossings.find((each) => each.file === file && each.imports === imported);
          if (entry !== undefined) entry.found = true;
          else
            findings.push({
              fileName: file,
              line,
              message: `${id} (${BOUNDARIES[id].source}): ${BOUNDARIES[id].rule}, but this ${message}${typeOnly ? " (a type-only import, which couples the folders too)" : ""}`,
            });
        };
        if (target === null) {
          if (area === null) continue;
          const name = packageOf(specifier);
          const id = area === "src/" ? "B2" : "B3";
          if (name === "node:" && area === "player/") {
            if (!NODE_FILES.some(({ pattern }) => pattern.test(file)))
              report(
                id,
                `imports '${specifier}', a Node built-in, which only the files \`NODE_FILES\` names may import: the browser bundle loads this one`,
              );
          } else if (!Object.hasOwn(PACKAGES[area], name))
            report(
              id,
              name === "node:"
                ? `imports '${specifier}', a Node built-in, which \`PACKAGES\` does not admit for \`src/\`: the engine also runs in the browser`
                : `imports the package '${name}', which \`PACKAGES\` does not admit for \`${area}\`: one that belongs is one line there, with its reason`,
            );
          continue;
        }
        if (area === "src/" && (target.startsWith("player/") || target.startsWith("playground/")))
          report("B1", `imports '${target}'`);
        if (area === "player/" && target.startsWith("player/vue/"))
          report("B3", `imports '${target}'`);
        if (!files.has(target) || target === file) continue;
        if (!allEdges.has(file)) allEdges.set(file, []);
        allEdges.get(file).push(target);
        if (!typeOnly) {
          if (!valueEdges.has(file)) valueEdges.set(file, []);
          valueEdges.get(file).push(target);
        }
      }
  }

  const listed = waiting
    .filter((entry) => entry.cycle !== undefined)
    .map((entry) => ({ ...entry, key: [...entry.cycle].sort().join("\n"), found: false }));
  for (const group of cycleGroups([...files].sort(), valueEdges)) {
    const entry = listed.find(({ key }) => key === group.join("\n"));
    if (entry !== undefined) {
      entry.found = true;
      continue;
    }
    findings.push({
      fileName: group[0],
      line: 1,
      message: `${group.length} files reach each other through value imports (\`IMPLEMENTATION-AND-REVIEW.md\` "Code structure": dependencies run one way, without cycles), as ${loopThrough(group, valueEdges).join(" → ")}: break the cycle, for example by moving what both need into a module of its own${group.length > 2 ? `; the group: ${group.join(", ")}` : ""}`,
    });
  }
  for (const entry of listed)
    if (!entry.found)
      findings.push({
        fileName: "tools/repository-checks/imports-waiting.json",
        line: 1,
        message: `the waiting cycle of ${entry.cycle.join(", ")} is no longer found as exactly that group: remove its entry, or list the group as it is now`,
      });
  for (const entry of crossings)
    if (!entry.found)
      findings.push({
        fileName: "tools/repository-checks/imports-waiting.json",
        line: 1,
        message: `the waiting import of '${entry.imports}' by ${entry.file} is no longer found: remove its entry`,
      });

  const typeCycles = cycleGroups([...files].sort(), allEdges).filter(
    (group) => !cycleGroups(group, valueEdges).some((value) => value.length === group.length),
  );
  return { findings, typeOnly: { groups: typeCycles.length, largest: typeCycles[0] ?? [] } };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const waiting = JSON.parse(
    readFileSync(new URL("./imports-waiting.json", import.meta.url), "utf8"),
  );
  const { findings, typeOnly } = checkImports(repositoryRoot, waiting);
  for (const { fileName, line, message } of findings)
    console.error(`${fileName}:${line}: ${message}`);
  console.log(
    `check:imports: ${typeOnly.groups} groups of files form a cycle once type-only imports count (advisory, not refused)` +
      (typeOnly.groups > 0
        ? `; the largest, ${typeOnly.largest.length} files, holds ${typeOnly.largest[0]}`
        : ""),
  );
  if (findings.length > 0) {
    console.error(`check:imports: ${findings.length} findings`);
    process.exitCode = 1;
  }
}
