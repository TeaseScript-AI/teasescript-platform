#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { posix } from "node:path";

import { headingText, markdownProcessor } from "./markdown.mjs";

// The repository names that maps, the start route and the ownership map give, in inline code, name tracked files or
// folders.
//
//   node tools/repository-checks/readme-paths.mjs       (in the repository's top folder; `npm run check:readme-paths`)
//
// It runs in `check:pretest` and in `tools/check-changed.mjs`, for every change. The documents are `DOCUMENTS` below;
// of `docs/ORCHESTRATION.md` only "Repository ownership", up to the next heading of its level, is read. Markdown is read
// as `markdown.mjs` reads it, and only inline code (`inlineCode`) is checked, never fenced code. The tracked files and
// folders are Git's (`git ls-files --cached`), a folder counting when it holds one, the top folder as `.`.
//
// The Player READMEs, whose names are paths: a span is checked when its text has no whitespace, does not start with `/`
// (a URL route, as `/player/`), `@` (a package, as `@vueuse/core`), `~` or a scheme (`https:`), is not a link's whole
// text (`doc-links.mjs` checks the link's target), and contains `/` or ends in `.ts`, `.vue`, `.mjs`, `.js`, `.json`,
// `.md` or `.css`. Its text, less one trailing `/`, must name a tracked file or folder from the README's folder or from
// the top folder. So a script name such as `main.tease` is not checked there.
//
// The route and ownership documents, which also name files by their bare name: a span is checked under the same
// exclusions, link text included, when its text before any `#` contains `/`, ends in any `.suffix`, or is a glob
// (`*`, `?`, `[`, `{`). That text, less a trailing `/` and the `#` fragment (whose heading `doc-links.mjs` checks only
// in links), resolves when:
//
// - it names a tracked file or folder from the document's folder or the top folder, a glob when it matches one;
// - it is bare (no `/` but a trailing one) and names one under a folder an earlier span of the same paragraph, heading
//   or table cell resolved to, at any depth and with or without `./`, the latest first (so "`src/plan/` (`model.ts` and
//   `validation/`)" names `src/plan/model.ts`);
// - it is bare and exactly one tracked file or folder has that name, or, for a glob, at least one name matches it.
//
// Not checked: commands, npm scripts and tool names without a suffix (`check-changed`), URLs and paths outside the
// repository, and whether a name that resolves is the one the prose meant: a name true from any of the places above
// passes.
//
// Exit status: 0 when every checked span resolves, 1 when one does not (each printed as `document:line: \`text\``), 2
// when the check cannot run (Git fails, a document or the ownership heading is missing).

/** The checked documents; `bareNames` marks those whose spans follow the route and ownership rules above. */
export const DOCUMENTS = [
  { path: "player/README.md" },
  { path: "player/vue/src/README.md" },
  { path: "README-FIRST.md", bareNames: true },
  { path: "docs/agents/README.md", bareNames: true },
  { path: "docs/agents/DIRECT-REPOSITORY.md", bareNames: true },
  { path: "docs/ORCHESTRATION.md", bareNames: true, section: "Repository ownership" },
];

const SOURCE = /\.(?:ts|vue|mjs|js|json|md|css)$/u;
const SUFFIX = /\.[\w-]+$/u;
const GLOB = /[*?[{]/u;
/** The blocks whose spans share folder context: an earlier span's folder is context for the later ones. */
const CONTEXT_BLOCKS = new Set(["paragraph", "heading", "tableCell"]);

/** Why the check cannot run: exit 2. */
export class CannotRun extends Error {}

/** The tracked `files` (paths from the top folder) as the check looks them up. */
export function trackedPaths(files) {
  const paths = new Set(["."]);
  for (const file of files) {
    paths.add(file);
    for (let folder = posix.dirname(file); folder !== "."; folder = posix.dirname(folder))
      paths.add(folder);
  }
  const byName = new Map();
  for (const path of paths) {
    if (path === ".") continue;
    const name = posix.basename(path);
    if (byName.has(name)) byName.get(name).push(path);
    else byName.set(name, [path]);
  }
  return { paths, byName };
}

function gitFiles() {
  try {
    return execFileSync("git", ["ls-files", "-z", "--cached"], {
      encoding: "utf8",
      maxBuffer: 1024 * 1024 * 1024,
    })
      .split("\0")
      .filter(Boolean);
  } catch (error) {
    throw new CannotRun(`readme-paths: cannot list the tracked files with Git: ${error.message}`);
  }
}

/** Whether a span's text, its fragment removed for `bareNames`, is one the check reads. */
function isChecked(text, bareNames) {
  if (/\s/u.test(text) || /^[/@~]|^[a-z][\w+.-]*:/iu.test(text)) return false;
  return (
    text.includes("/") || SOURCE.test(text) || (bareNames && (SUFFIX.test(text) || GLOB.test(text)))
  );
}

/** The tracked path `name` names from `folder`, the matched pattern for a glob; undefined when none. */
function lookUp({ paths }, folder, name) {
  const path = posix.normalize(posix.join(folder, name));
  if (path === ".." || path.startsWith("../")) return undefined;
  if (GLOB.test(path))
    return [...paths].some((candidate) => posix.matchesGlob(candidate, path)) ? path : undefined;
  return paths.has(path) ? path : undefined;
}

/** The tracked path a span's `name` resolves to, under the document's rule; undefined when it resolves to none. */
function resolve(tracked, document, name, folders) {
  const places = [posix.dirname(document.path), "."];
  const bare = !name.includes("/");
  if (document.bareNames && bare) places.unshift(...folders.toReversed());
  for (const place of places) {
    const path = lookUp(tracked, place, name);
    if (path !== undefined) return path;
  }
  if (!document.bareNames || !bare) return undefined;
  if (!GLOB.test(name)) {
    const named = tracked.byName.get(name) ?? [];
    return named.length === 1 ? named[0] : undefined;
  }
  return [...tracked.byName.keys()].some((candidate) => posix.matchesGlob(candidate, name))
    ? name
    : undefined;
}

/** The nodes of `markdown` the document reads: all, or its section's. */
function readNodes(markdown, document) {
  const nodes = markdownProcessor().parse(markdown).children;
  if (document.section === undefined) return nodes;
  const start = nodes.findIndex(
    (node) => node.type === "heading" && headingText(node) === document.section,
  );
  if (start === -1)
    throw new CannotRun(`readme-paths: ${document.path} has no heading "${document.section}"`);
  const end = nodes.findIndex(
    (node, index) => index > start && node.type === "heading" && node.depth <= nodes[start].depth,
  );
  return nodes.slice(start + 1, end === -1 ? undefined : end);
}

/** The checked spans of one document and those that resolve to no tracked file or folder, each with its line. */
export function checkDocument(tracked, document, markdown) {
  let checked = 0;
  const problems = [];
  const visit = (node, parent, folders) => {
    if (CONTEXT_BLOCKS.has(node.type)) folders = [];
    if (node.type !== "inlineCode") {
      for (const child of node.children ?? []) visit(child, node, folders);
      return;
    }
    const linkText =
      (parent?.type === "link" || parent?.type === "linkReference") && parent.children.length === 1;
    const text = node.value;
    const name = document.bareNames ? text.split("#", 1)[0] : text;
    if ((linkText && !document.bareNames) || !isChecked(name, document.bareNames)) return;
    checked += 1;
    const path = resolve(tracked, document, name.replace(/\/$/u, ""), folders);
    if (path === undefined) problems.push({ line: node.position.start.line, text });
    else if (document.bareNames && name.endsWith("/") && !GLOB.test(path)) folders.push(path);
  };
  for (const node of readNodes(markdown, document)) visit(node, undefined, []);
  return { checked, problems };
}

function main() {
  const tracked = trackedPaths(gitFiles());
  let checked = 0;
  const problems = [];
  for (const document of DOCUMENTS) {
    let markdown;
    try {
      markdown = readFileSync(document.path, "utf8");
    } catch (error) {
      throw new CannotRun(`readme-paths: cannot read ${document.path}: ${error.message}`);
    }
    const result = checkDocument(tracked, document, markdown);
    checked += result.checked;
    for (const { line, text } of result.problems)
      problems.push(`${document.path}:${line}: \`${text}\` names no tracked file or folder`);
  }
  if (problems.length === 0) {
    console.log(
      `readme-paths: all ${checked} checked names in ${DOCUMENTS.length} documents name a tracked file or folder`,
    );
    return 0;
  }
  for (const problem of problems) console.error(problem);
  console.error(
    `readme-paths: ${problems.length} checked names resolve to no tracked file or folder: write each as its current path from the document's folder or the top folder`,
  );
  return 1;
}

if (import.meta.main) {
  try {
    process.exitCode = main();
  } catch (error) {
    if (!(error instanceof CannotRun)) throw error;
    console.error(error.message);
    process.exitCode = 2;
  }
}
