#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { posix } from "node:path";

import { remark } from "remark";
import remarkGfm from "remark-gfm";

// The Player's maps name their files' places: in `player/README.md` and `player/vue/src/README.md`, every backticked
// path names a file or folder Git tracks.
//
//   node tools/repository-checks/readme-paths.mjs       (in the repository's top folder; `npm run check:readme-paths`)
//
// It runs in `check:pretest` and in `tools/check-changed.mjs`, for every change.
//
// What is checked: each Markdown inline code span (remark's `inlineCode`, with remark-gfm) of the two READMEs whose
// text has no whitespace, does not start with `/` or `@`, and contains `/` or ends in `.ts`, `.vue`, `.mjs`, `.js`,
// `.json`, `.md` or `.css`. Its text, less one trailing `/`, must be a file Git tracks (`git ls-files --cached`) or a
// folder holding one, read first from the README's folder and then from the repository's top folder.
//
// What is skipped, and so not checked: a code span that is a link's whole text, inline or by reference (`doc-links.mjs`
// checks the link's target); a span starting with `/` (a URL route, as `/player/`) or `@` (a package name, as
// `@vueuse/core`); a span with whitespace (a command); every other span (an identifier, a type, a call, a script
// name such as `main.tease`); fenced code blocks; and every other file. A path true from either of the two places
// passes, also when the README means the other one.
//
// Exit status: 0 when every checked span names a tracked file or folder, 1 when one does not (each is printed as
// `README:line: \`token\``), 2 when it cannot run.

const READMES = ["player/README.md", "player/vue/src/README.md"];
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
function isPathShaped(text) {
  return !/\s/u.test(text) && !/^[/@]/u.test(text) && (text.includes("/") || SOURCE.test(text));
}

/** Each checked code span of `markdown`: its text and line. */
function pathSpans(markdown) {
  const spans = [];
  const visit = (node, parent) => {
    if (node.type === "inlineCode") {
      const linkText =
        (parent?.type === "link" || parent?.type === "linkReference") &&
        parent.children.length === 1;
      if (!linkText && isPathShaped(node.value))
        spans.push({ text: node.value, line: node.position.start.line });
      return;
    }
    for (const child of node.children ?? []) visit(child, node);
  };
  visit(remark().use(remarkGfm).parse(markdown), undefined);
  return spans;
}

/** Whether `text`, read from `folder` (relative to the top folder), names one of `paths`. */
function names(paths, folder, text) {
  const path = posix.normalize(posix.join(folder, text.replace(/\/$/u, "")));
  return !path.startsWith("../") && path !== ".." && paths.has(path);
}

function main() {
  const paths = trackedPaths();
  const problems = [];
  let checked = 0;
  for (const readme of READMES) {
    let markdown;
    try {
      markdown = readFileSync(posix.join(root, readme), "utf8");
    } catch (error) {
      throw new CannotRun(`readme-paths: cannot read ${readme}: ${error.message}`);
    }
    for (const { text, line } of pathSpans(markdown)) {
      checked += 1;
      if (!names(paths, posix.dirname(readme), text) && !names(paths, ".", text))
        problems.push(`${readme}:${line}: \`${text}\` names no tracked file or folder`);
    }
  }
  if (problems.length === 0) {
    console.log(
      `readme-paths: all ${checked} backticked paths in ${READMES.length} READMEs name a tracked file or folder`,
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
