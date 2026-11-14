#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { posix } from "node:path";

import { remark } from "remark";
import remarkGfm from "remark-gfm";

// Checks backticked repository names in the two Player READMEs, the three start-route documents, and only
// "Repository ownership" in docs/ORCHESTRATION.md against Git's tracked files and folders.
//
//   node tools/repository-checks/readme-paths.mjs       (in the repository's top folder; `npm run check:readme-paths`)
//
// It runs in `check:pretest` and in `tools/check-changed.mjs`, for every change.
//
// In the Player READMEs: each Markdown inline code span (remark's `inlineCode`, with remark-gfm) whose
// text has no whitespace, does not start with `/` or `@`, and contains `/` or ends in `.ts`, `.vue`, `.mjs`, `.js`,
// `.json`, `.md` or `.css`. Its text, less one trailing `/`, must be a file Git tracks (`git ls-files --cached`) or a
// folder holding one, read first from the README's folder and then from the repository's top folder.
// The route and ownership surfaces additionally admit other file suffixes (area.sh included), tracked globs,
// and bare names. A bare name can use the preceding inline directory in the same paragraph; otherwise the document's
// folder and repository root are tried, then an exact basename only when unique among tracked files/folders.
// A glob must match a tracked path, or a tracked basename for a bare glob. An inline #fragment is removed for path
// resolution; this check does not validate its heading (doc-links checks Markdown link targets).
//
// What is skipped, and so not checked: in a Player README, code that is a link's whole text (`doc-links.mjs`
// checks the link's target); a span starting with `/` (a URL route, as `/player/`) or `@` (a package name, as
// `@vueuse/core`); a span with whitespace (a command); every other span (an identifier, a type, a call, a script
// name such as `main.tease` in a Player README); fenced code blocks; and every other file/section. URLs and explicit
// home/absolute paths are outside the repository claim. Commands and environmental tools are not validated.
// A path true from one of the stated places passes even if the prose meant another one.
//
// Exit status: 0 when every checked span names a tracked file or folder, 1 when one does not (each is printed as
// `README:line: \`token\``), 2 when it cannot run.

const DOCUMENTS = [
  { path: "player/README.md" },
  { path: "player/vue/src/README.md" },
  { path: "README-FIRST.md", extended: true },
  { path: "docs/agents/README.md", extended: true },
  { path: "docs/agents/DIRECT-REPOSITORY.md", extended: true },
  { path: "docs/ORCHESTRATION.md", extended: true, heading: "Repository ownership" },
];
const SOURCE = /\.(?:ts|vue|mjs|js|json|md|css)$/u;
const root = process.cwd();

/** Why the check cannot run: exit 2. */
class CannotRun extends Error {}

/** The files Git tracks, and every folder that holds one. */
function trackedPaths() {
  let listed;
  try {
    listed = execFileSync("git", ["ls-files", "-z", "--cached"], {
      cwd: root,
      encoding: "utf8",
      maxBuffer: 1024 * 1024 * 1024,
    });
  } catch (error) {
    throw new CannotRun(`readme-paths: cannot list the tracked files with Git: ${error.message}`);
  }
  // (the top folder holds every file: `.`, as a span such as `../` from `player/` reads)
  const paths = new Set(["."]);
  for (const file of listed.split("\0").filter(Boolean)) {
    paths.add(file);
    for (let folder = posix.dirname(file); folder !== "."; folder = posix.dirname(folder))
      paths.add(folder);
  }
  return paths;
}

/** Whether a code span's text is shaped like a path the check reads. */
function isPathShaped(text, extended) {
  return (
    !/\s/u.test(text) &&
    !/^[/@~]|^[a-z][\w+.-]*:/iu.test(text) &&
    (text.includes("/") || SOURCE.test(text) || (extended && /\.[\w-]+$|[*?[{]/u.test(text)))
  );
}

/** Each checked code span of `markdown`: its text and line. */
function pathSpans(markdown, { extended, heading }) {
  let nodes = remark().use(remarkGfm).parse(markdown).children;
  if (heading !== undefined) {
    const start = nodes.findIndex(
      (node) =>
        node.type === "heading" &&
        node.children.map((child) => child.value ?? "").join("") === heading,
    );
    if (start === -1) throw new CannotRun(`readme-paths: missing section ${heading}`);
    const end = nodes.findIndex(
      (node, index) => index > start && node.type === "heading" && node.depth <= nodes[start].depth,
    );
    nodes = nodes.slice(start + 1, end === -1 ? undefined : end);
  }
  const spans = [];
  const visit = (node, parent, directories) => {
    if (node.type === "paragraph") directories = [];
    if (node.type === "inlineCode") {
      const linkText =
        (parent?.type === "link" || parent?.type === "linkReference") &&
        parent.children.length === 1;
      if ((!linkText || extended) && isPathShaped(node.value, extended)) {
        spans.push({
          text: node.value,
          line: node.position.start.line,
          directory: directories.at(-1),
        });
        if (extended && node.value.endsWith("/") && node.value.slice(0, -1).includes("/"))
          directories.push(node.value);
      }
      return;
    }
    for (const child of node.children ?? []) visit(child, node, directories);
  };
  for (const node of nodes) visit(node, undefined, []);
  return spans;
}

/** Whether `text`, read from `folder` (relative to the top folder), names one of `paths`. */
function names(paths, folder, text, extended) {
  const path = posix.normalize(posix.join(folder, text.replace(/\/$/u, "")));
  if (path.startsWith("../") || path === "..") return false;
  return (
    paths.has(path) ||
    (extended &&
      /[*?[{]/u.test(path) &&
      [...paths].some((candidate) => posix.matchesGlob(candidate, path)))
  );
}

function resolves(paths, file, { text, directory }, extended) {
  const name = extended ? text.split("#", 1)[0] : text;
  const bare = !name.replace(/\/$/u, "").includes("/");
  if (
    extended &&
    bare &&
    directory !== undefined &&
    [posix.dirname(file), "."].some((folder) =>
      names(paths, folder, posix.join(directory, name), true),
    )
  )
    return true;
  if ([posix.dirname(file), "."].some((folder) => names(paths, folder, name, extended)))
    return true;
  if (!extended || !bare) return false;
  const basename = name.replace(/\/$/u, "");
  const matches = [...paths].filter(
    (candidate) =>
      posix.basename(candidate) === basename ||
      (/[*?[{]/u.test(basename) && posix.matchesGlob(posix.basename(candidate), basename)),
  );
  return /[*?[{]/u.test(basename) ? matches.length > 0 : matches.length === 1;
}

function main() {
  const paths = trackedPaths();
  const problems = [];
  let checked = 0;
  for (const document of DOCUMENTS) {
    const readme = document.path;
    let markdown;
    try {
      markdown = readFileSync(posix.join(root, readme), "utf8");
    } catch (error) {
      throw new CannotRun(`readme-paths: cannot read ${readme}: ${error.message}`);
    }
    for (const span of pathSpans(markdown, document)) {
      const { text, line } = span;
      checked += 1;
      if (!resolves(paths, readme, span, document.extended))
        problems.push(`${readme}:${line}: \`${text}\` names no tracked file or folder`);
    }
  }
  if (problems.length === 0) {
    console.log(
      `readme-paths: all ${checked} backticked names in ${DOCUMENTS.length} document surfaces resolve to tracked files or folders`,
    );
    return 0;
  }
  for (const problem of problems) console.error(problem);
  console.error(
    `readme-paths: ${problems.length} backticked paths name no tracked file or folder: write each as its current path from the README's folder or the top folder`,
  );
  return 1;
}

try {
  process.exitCode = main();
} catch (error) {
  if (!(error instanceof CannotRun)) throw error;
  console.error(error.message);
  process.exitCode = 2;
}
