#!/usr/bin/env node
import { execFileSync, spawn } from "node:child_process";
import { lstatSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { cruise } from "dependency-cruiser";
import extractTSConfig from "dependency-cruiser/config-utl/extract-ts-config";

// The direction of the imports the repository's documents declare, and cycles (`npm run check:imports`, part of
// `check:pretest` and `tools/check-changed.mjs`):
//
//   node tools/repository-checks/imports.mjs       (in the repository's top folder)
//
// The claim: dependency-cruiser, cruising each tsconfig with the compiler's import elision, reports no edge a rule
// forbids, and its graph has no value cycle outside the waiting list.
//
// The files are Git's list (tracked, and untracked but not ignored) of `.ts`, `.tsx`, `.mts`, `.cts`, `.js`, `.mjs`,
// `.cjs` and `.vue` files that are regular files in the working tree, outside `tests/fixtures/`, whose files are
// deliberate shapes. dependency-cruiser cruises them twice, in two processes at once, because what the compiler erases
// depends on the project's options: `player/vue/` with `player/vue/tsconfig.json` (`verbatimModuleSyntax`, the `@/`
// paths), everything else with the root `tsconfig.json`. Each file's imports come from its own project's cruise, so a
// code file that such an import reaches and its own project's cruise did not read is refused: it is not among Git's
// files. `tsPreCompilationDeps: "specify"` marks each import the compiler erases; the others are value imports. It reads
// `.vue` scripts with `@vue/compiler-sfc`.
//
// The declared boundaries count every import, erased ones too, as they couple the folders alike:
// - B1, `src/` imports nothing under `player/` or `playground/`: `docs/ARCHITECTURE.md` "Implemented deterministic
//   vertical slice" (parse … runtime state and events, then the playground and the framework-independent Player
//   adapter, then the Vue Player).
// - B2, `src/` imports only the packages `PACKAGES` admits for it: `CURRENT-DESIGN.md` "System map" ("The engine and
//   shared domain contracts remain framework-independent TypeScript") and `docs/ARCHITECTURE.md` "Accepted
//   boundaries".
// - B3, `player/` outside `player/vue/` imports nothing under `player/vue/`, and only the packages `PACKAGES` admits for
//   it: `docs/ARCHITECTURE.md` "Implemented deterministic vertical slice" (the framework-independent Player adapter
//   before the Vue Player) and "Implemented source-layout seams"; `player/README.md` "Implementation seams".
// An area's admitted set is closed: anything it imports that is not one of the repository's files and not an admitted
// package is refused, Node's built-ins and an import dependency-cruiser cannot resolve included. Each admitted package
// names its reason; a package that belongs is one more line there, and adding a dependency needs `AGENTS.md`'s
// justification first. Node's built-ins are admitted only in `NODE_FILES`: the browser bundle loads the rest of
// `player/`.
//
// Cycles (`IMPLEMENTATION-AND-REVIEW.md` "Code structure": "dependencies run one way, without cycles"): a group of files
// that reach each other through value imports is refused. The groups are the strongly connected components of
// dependency-cruiser's graph, computed here: its `circular` rule judges one cycle per module, and named 4 files of a
// 10-file group in `player/engine-bridge/ops/` (#2026). One exception: `player/vue/src/components/ui/` is shadcn-vue's
// generated code (`player/vue/components.json`), whose `<dir>/index.ts` re-exports `<dir>/X.vue` while `X.vue` imports
// its variants from `"."`. A group of one `components/ui/<dir>/index.ts` and `.vue` files directly in that `<dir>` is
// admitted; any other group there is refused.
//
// `imports-waiting.json` lists what waits for other work, which each entry's `waits` cites: a cycle group, exactly, or
// one boundary crossing (the importing file, and the file or package dependency-cruiser resolves its import to:
// `player/p.ts`, not `../player/p.js`). Keep the list shrink-only: the check fails on an entry it no longer finds, but
// does not compare an added entry or an enlarged cycle with the base. Cycles through an erased import set no load order:
// they are not refused, and the last line counts the groups that form a cycle once erased imports count, advisory.
//
// Not seen: a `<script src>` block; a `.js` file beside a same-name `.ts`, which resolves to the `.js` (TypeScript picks
// the `.ts`); a `.vue` file Vue's parser refuses, which yields no imports (vue-tsc refuses it in CI); a computed
// `import()`, `new Worker(new URL(…))` and `new URL(…, import.meta.url)`. Not declared, so not checked: product code
// importing `tests/` or `tools/`; `src/runtime/` importing the compiler or the parser; `player/vue/` importing
// `playground/` (`player/vue/src/packageHost.ts` → `playground/package-catalog.ts`); ADR 0017's Standard Library and
// privileged adapter layers, which have no modules yet.
//
// Exit status: 0 when nothing is refused; 1 when a boundary is crossed, an unlisted cycle exists, an imported code file
// is not among Git's files or a listed entry is gone; 2 when it cannot run, as when the waiting list is malformed or has
// an entry of another shape, or a cruise's result is not JSON. It installs no signal handler: interrupted, it stops by
// the signal, and a cruise left running only reads files and ends by itself.

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

/** The `player/` files that only Node loads, which may import Node's built-ins, with why. */
export const NODE_FILES = {
  pattern: "^player/engine-bridge/node-[^/]+\\.ts$",
  reason:
    "the engine host's Node transport (`node:worker_threads`), which the browser bundle does not load",
};

const escape = (text) => text.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
/** A path pattern for the files of `packages`, wherever `node_modules` is. */
const packagesPattern = (packages) =>
  `(?:^|/)node_modules/(?:${Object.keys(packages).map(escape).join("|")})/`;
const FREE_PLAYER = "^player/(?!vue/)";

/** The boundaries as dependency-cruiser rules, each with the words its message quotes. */
const BOUNDARIES = {
  B1: {
    rule: "`src/` imports nothing under `player/` or `playground/`",
    source: '`docs/ARCHITECTURE.md` "Implemented deterministic vertical slice"',
    forbidden: [{ from: { path: "^src/" }, to: { path: "^(?:player|playground)/" } }],
  },
  B2: {
    rule: "`src/` imports only the packages `PACKAGES` admits for it",
    source: '`CURRENT-DESIGN.md` "System map", `docs/ARCHITECTURE.md` "Accepted boundaries"',
    forbidden: [
      {
        from: { path: "^src/" },
        to: { dependencyTypesNot: ["local"], pathNot: packagesPattern(PACKAGES["src/"]) },
      },
    ],
  },
  B3: {
    rule: "`player/` outside `player/vue/` imports nothing under `player/vue/`, and only the packages `PACKAGES` admits for it",
    source:
      '`docs/ARCHITECTURE.md` "Implemented deterministic vertical slice", `player/README.md` "Implementation seams"',
    forbidden: [
      { from: { path: FREE_PLAYER }, to: { path: "^player/vue/" } },
      {
        from: { path: FREE_PLAYER, pathNot: NODE_FILES.pattern },
        to: { dependencyTypesNot: ["local"], pathNot: packagesPattern(PACKAGES["player/"]) },
      },
      {
        from: { path: NODE_FILES.pattern },
        to: {
          dependencyTypesNot: ["local", "core"],
          pathNot: packagesPattern(PACKAGES["player/"]),
        },
      },
    ],
  },
};

/** The two projects: which files each owns, and the tsconfig its cruise reads. */
const PROJECTS = {
  root: { owns: (file) => !file.startsWith("player/vue/"), tsconfig: "tsconfig.json" },
  vue: { owns: (file) => file.startsWith("player/vue/"), tsconfig: "player/vue/tsconfig.json" },
};

/** Why the check cannot run: exit 2. */
class CannotRun extends Error {}

/** Git's list of the code files this check reads, relative to the top folder. */
function codeFiles() {
  const files = execFileSync(
    "git",
    ["ls-files", "-z", "--cached", "--others", "--exclude-standard", "--deduplicate"],
    { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
  )
    .split("\0")
    .filter((file) => CODE.test(file) && !file.startsWith("tests/fixtures/"))
    // a working-tree deletion, a symlink and a submodule are no file to read
    .filter((file) => lstatSync(file, { throwIfNoEntry: false })?.isFile() === true);
  // dependency-cruiser reads a name with one of these as a glob pattern
  const glob = files.find((file) => /[*?[\]{}()!]/u.test(file));
  if (glob !== undefined)
    throw new CannotRun(
      `check:imports: '${glob}' has a glob character in its name, which dependency-cruiser would read as a pattern: rename it`,
    );
  return files;
}

/** One project's cruise, in this process: dependency-cruiser's JSON result, on standard output. */
async function cruiseProject(name) {
  const project = PROJECTS[name];
  const result = await cruise(
    codeFiles().filter(project.owns),
    {
      validate: true,
      ruleSet: {
        forbidden: Object.entries(BOUNDARIES).flatMap(([boundary, { forbidden }]) =>
          forbidden.map((rule, index) => ({
            name: `${boundary}.${index}`,
            severity: "error",
            ...rule,
          })),
        ),
      },
      outputType: "json",
      tsPreCompilationDeps: "specify",
      tsConfig: { fileName: project.tsconfig },
      moduleSystems: ["es6", "cjs"],
      doNotFollow: { path: "(?:^|/)node_modules/" },
      exclude: { path: "^tests/fixtures/" },
      enhancedResolveOptions: {
        exportsFields: ["exports"],
        conditionNames: ["import", "require", "node", "default", "types"],
        extensions: [".ts", ".tsx", ".mts", ".cts", ".js", ".mjs", ".cjs", ".vue", ".json"],
      },
    },
    {},
    { tsConfig: extractTSConfig(project.tsconfig) },
  );
  process.stdout.write(result.output);
}

/** The two cruises, each in its own process at once; their JSON results, by project. */
async function cruiseBoth() {
  const children = Object.keys(PROJECTS).map((name) => {
    const child = spawn(process.execPath, [fileURLToPath(import.meta.url), "--cruise", name], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    const chunks = [];
    let stderr = "";
    child.stdout.on("data", (chunk) => chunks.push(chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    const done = new Promise((resolve) =>
      child.on("close", (status, signal) => resolve({ status, signal })),
    );
    return { name, done, chunks, stderr: () => stderr };
  });
  const results = {};
  for (const { name, done, chunks, stderr } of children) {
    const { status, signal } = await done;
    if (status !== 0)
      throw new CannotRun(
        `check:imports: the ${name} project's cruise failed (${signal ?? `exit ${status}`}):\n${stderr()}`,
      );
    try {
      results[name] = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch (error) {
      throw new CannotRun(
        `check:imports: the ${name} project's cruise printed no JSON result: ${error.message}`,
        { cause: error },
      );
    }
  }
  return results;
}

const WAITING = "tools/repository-checks/imports-waiting.json";

/** The waiting list: each entry a cycle (`cycle`, `waits`) or a crossing (`file`, `imports`, `waits`), or exit 2. */
function waitingList() {
  let entries;
  try {
    entries = JSON.parse(readFileSync(WAITING, "utf8"));
  } catch (error) {
    throw new CannotRun(`check:imports: cannot read ${WAITING}: ${error.message}`, {
      cause: error,
    });
  }
  const text = (value) => typeof value === "string" && value !== "";
  const shapeOf = (entry) =>
    typeof entry === "object" && entry !== null ? Object.keys(entry).sort().join(", ") : "";
  const valid = (entry) =>
    (shapeOf(entry) === "cycle, waits" &&
      Array.isArray(entry.cycle) &&
      entry.cycle.length > 1 &&
      entry.cycle.every(text) &&
      text(entry.waits)) ||
    (shapeOf(entry) === "file, imports, waits" &&
      text(entry.file) &&
      text(entry.imports) &&
      text(entry.waits));
  const invalid = Array.isArray(entries) ? entries.findIndex((entry) => !valid(entry)) : -1;
  if (!Array.isArray(entries) || invalid !== -1)
    throw new CannotRun(
      `check:imports: ${WAITING}${Array.isArray(entries) ? `, entry ${invalid + 1},` : ""} is not a list of cycles ({ "cycle": [files], "waits" }) and crossings ({ "file", "imports", "waits" }), each \`waits\` naming the work it waits for`,
    );
  return entries;
}

/** The strongly connected groups of more than one file in `edges` (a map from a file to the files it imports). */
export function cycleGroups(edges) {
  let next = 0;
  const index = new Map();
  const low = new Map();
  const stack = [];
  const onStack = new Set();
  const groups = [];
  const visit = (file) => {
    index.set(file, next);
    low.set(file, next);
    next += 1;
    stack.push(file);
    onStack.add(file);
    for (const target of edges.get(file) ?? []) {
      if (!index.has(target)) {
        visit(target);
        low.set(file, Math.min(low.get(file), low.get(target)));
      } else if (onStack.has(target)) low.set(file, Math.min(low.get(file), index.get(target)));
    }
    if (low.get(file) === index.get(file)) {
      const group = [];
      let member;
      do {
        member = stack.pop();
        onStack.delete(member);
        group.push(member);
      } while (member !== file);
      if (group.length > 1) groups.push(group.sort());
    }
  };
  for (const file of edges.keys()) if (!index.has(file)) visit(file);
  return groups;
}

/** Whether a value-cycle `group` is shadcn-vue's generated shape (header): one `<dir>/index.ts` and `.vue` files there. */
export function isGeneratedComponentGroup(group) {
  const shape = /^player\/vue\/src\/components\/ui\/([^/]+)\/([^/]+)$/u;
  const parts = group.map((file) => shape.exec(file));
  if (parts.some((part) => part === null)) return false;
  const dirs = new Set(parts.map((part) => part[1]));
  const indexes = parts.filter((part) => part[2] === "index.ts").length;
  return (
    dirs.size === 1 &&
    indexes === 1 &&
    parts.every((part) => /^(?:index\.ts|[^/]+\.vue)$/u.test(part[2]))
  );
}

/**
 * The findings of the two cruises' results against `waiting` (the parsed `imports-waiting.json`): `{ findings,
 * advisory }`, each finding one line, and the advisory line on the cycles through erased imports.
 */
export function judge(results, waiting) {
  const findings = [];
  const valueEdges = new Map();
  const allEdges = new Map();
  const crossings = new Map();
  const readBy = Object.fromEntries(
    Object.entries(results).map(([name, result]) => [
      name,
      new Set(result.modules.map((module) => module.source)),
    ]),
  );
  const unread = new Map();
  for (const [name, result] of Object.entries(results)) {
    const { owns } = PROJECTS[name];
    for (const module of result.modules) {
      if (!owns(module.source) || module.source.includes("node_modules/")) continue;
      const local = module.dependencies.filter(
        (dependency) => !dependency.couldNotResolve && dependency.dependencyTypes.includes("local"),
      );
      for (const { resolved } of local) {
        const [owner] = Object.entries(PROJECTS).find(([, project]) => project.owns(resolved));
        if (CODE.test(resolved) && !readBy[owner].has(resolved) && !unread.has(resolved))
          unread.set(resolved, module.source);
      }
      allEdges.set(
        module.source,
        local.map((dependency) => dependency.resolved),
      );
      valueEdges.set(
        module.source,
        local
          .filter((dependency) => !dependency.preCompilationOnly)
          .map((dependency) => dependency.resolved),
      );
    }
    for (const violation of result.summary.violations ?? []) {
      if (!owns(violation.from) || violation.cycle !== undefined) continue;
      const boundary = violation.rule.name.split(".")[0];
      crossings.set(`${violation.from}\n${violation.to}`, {
        boundary,
        file: violation.from,
        imports: violation.to,
      });
    }
  }

  for (const [file, importer] of [...unread].sort())
    findings.push(
      `${file}: ${importer} imports it, but it is not among Git's files (ignored, or outside the list), so its own project's cruise does not read it: track it, or stop importing it`,
    );

  const listedCrossings = new Set(
    waiting
      .filter((entry) => entry.file !== undefined)
      .map((entry) => `${entry.file}\n${entry.imports}`),
  );
  for (const [key, { boundary, file, imports }] of [...crossings].sort()) {
    if (listedCrossings.delete(key)) continue;
    const { rule, source } = BOUNDARIES[boundary];
    findings.push(`${file}: ${boundary} (${source}): ${rule}, but this imports '${imports}'`);
  }
  for (const key of listedCrossings) {
    const [file, imports] = key.split("\n");
    findings.push(
      `imports-waiting.json lists ${file} importing '${imports}', which no longer crosses a boundary: remove the entry (the list only shrinks)`,
    );
  }

  const valueGroups = cycleGroups(valueEdges).sort((one, other) => (one[0] < other[0] ? -1 : 1));
  const listedCycles = new Set(
    waiting
      .filter((entry) => entry.cycle !== undefined)
      .map((entry) => JSON.stringify([...entry.cycle].sort())),
  );
  for (const group of valueGroups) {
    if (listedCycles.delete(JSON.stringify(group)) || isGeneratedComponentGroup(group)) continue;
    findings.push(
      `${group[0]}: ${group.length} files reach each other through imports the compiler keeps (\`IMPLEMENTATION-AND-REVIEW.md\` "Code structure": dependencies run one way, without cycles): ${group.join(", ")}: break the cycle, or list the group in imports-waiting.json with what it waits for`,
    );
  }
  for (const key of listedCycles)
    findings.push(
      `imports-waiting.json lists the cycle ${JSON.parse(key).join(", ")}, which no longer exists as listed: remove or correct the entry (the list only shrinks)`,
    );

  const valueKeys = new Set(valueGroups.map((group) => JSON.stringify(group)));
  const erased = cycleGroups(allEdges).filter((group) => !valueKeys.has(JSON.stringify(group)));
  const largest = erased.reduce(
    (best, group) => (group.length > (best?.length ?? 0) ? group : best),
    null,
  );
  const advisory =
    largest === null
      ? "check:imports: no group of files forms a cycle once imports the compiler erases count (advisory)"
      : `check:imports: ${erased.length} groups of files form a cycle once imports the compiler erases count (advisory, not refused); the largest, ${largest.length} files, holds ${largest[0]}`;
  return { findings, advisory };
}

async function main() {
  const cruiseArgument = process.argv.indexOf("--cruise");
  if (cruiseArgument !== -1) return cruiseProject(process.argv[cruiseArgument + 1]);
  try {
    codeFiles();
    const waiting = waitingList();
    const { findings, advisory } = judge(await cruiseBoth(), waiting);
    for (const finding of findings) console.error(finding);
    console.log(advisory);
    if (findings.length > 0) {
      console.error(`check:imports: ${findings.length} findings`);
      process.exitCode = 1;
    }
  } catch (error) {
    if (!(error instanceof CannotRun)) throw error;
    console.error(error.message);
    process.exitCode = 2;
  }
}

if (import.meta.main) await main();
