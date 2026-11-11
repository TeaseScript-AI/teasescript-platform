#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { lstatSync } from "node:fs";
import { join } from "node:path";

import { remark } from "remark";
import remarkValidateLinks from "remark-validate-links";
import { engine } from "unified-engine";
import { VFile } from "vfile";

import { MARKDOWN_PLUGINS } from "./markdown.mjs";

// The Markdown links (docs/TESTING.md "Normal and diagnostic verification"): remark-validate-links reports every
// relative link and heading anchor in the Markdown files that Git tracks or does not ignore that does not resolve.
//
//   node tools/repository-checks/doc-links.mjs       (in the repository's top folder; `npm run check:doc-links`)
//
// It runs in `check:pretest` and in `tools/check-changed.mjs`, for every change.
//
// Only Git is launched: unified-engine runs in this process, with remark as the processor and the repository's Markdown
// plugins (`markdown.mjs`: remark-gfm) and remark-validate-links (`repository: false`, so absolute URLs, this repository's included, are not checked) as its
// only plugins. No configuration file and no ignore file is searched for (`detectConfig` and `detectIgnore` off), and
// nothing is written. The files are Git's list (`git ls-files --cached --others --exclude-standard`) of `*.md` entries
// that are regular files in the working tree, so a deleted file, a symlink and a submodule are not read. Each goes to
// the engine as a file object, which it takes as that one file, never as a pattern. A name that is not UTF-8 is
// refused, as it cannot be passed on unchanged.
//
// Outside the claim, as remark-validate-links does not read them as GitHub does: raw-HTML links (`<a href>`), and
// GitHub's view forms: `?plain=1` and `?raw=1`, a folder's README anchors, and a heading GitHub's sanitizer filters a
// tag from. The docs have none of these; such a link does not get GitHub's reading, so it may be refused though GitHub
// resolves it, or pass though GitHub does not. A reference definition naming a missing file is reported even when no
// link uses it.
//
// Exit status: 0 when remark reports nothing, 1 when it reports a link that does not resolve (or another problem, in
// its report), 2 when it cannot run. A missing or broken installed package stops Node before the check starts, with
// Node's own exit 1.

const root = process.cwd();

/** Why the check cannot run: exit 2. */
class CannotRun extends Error {}

/** Git's list of the Markdown files that are regular files in the working tree, each name decoded exactly. */
function markdownFiles() {
  let listed;
  try {
    listed = execFileSync(
      "git",
      ["ls-files", "-z", "--cached", "--others", "--exclude-standard", "--", "*.md"],
      { cwd: root, maxBuffer: 1024 * 1024 * 1024 },
    );
  } catch (error) {
    throw new CannotRun(`doc-links: cannot list the Markdown files with Git: ${error.message}`);
  }
  const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
  const names = new Set();
  let start = 0;
  for (let end = listed.indexOf(0); end !== -1; end = listed.indexOf(0, start)) {
    const bytes = listed.subarray(start, end);
    start = end + 1;
    try {
      names.add(decoder.decode(bytes));
    } catch {
      throw new CannotRun(
        `doc-links: Git lists a Markdown file whose name is not UTF-8 (bytes ${bytes.toString("hex")}): rename it`,
      );
    }
  }
  return [...names].filter(
    (name) => lstatSync(join(root, name), { throwIfNoEntry: false })?.isFile() === true,
  );
}

/** remark-validate-links over `files` (relative to `root`): the engine's status, 0 when it reports nothing. */
function validate(files) {
  return new Promise((resolve, reject) => {
    engine(
      {
        processor: remark,
        plugins: [...MARKDOWN_PLUGINS, [remarkValidateLinks, { repository: false }]],
        files: files.map((name) => new VFile({ path: join(root, name) })),
        cwd: root,
        detectConfig: false,
        detectIgnore: false,
        frail: true,
        quiet: true,
        color: false,
        out: false,
        output: false,
        streamError: process.stderr,
      },
      (error, status) => (error ? reject(error) : resolve(status ?? 0)),
    );
  });
}

async function main() {
  const files = markdownFiles();
  if (files.length === 0) {
    console.log("doc-links: no Markdown files");
    return 0;
  }
  let status;
  try {
    status = await validate(files);
  } catch (error) {
    throw new CannotRun(`doc-links: remark did not run: ${error.message}`);
  }
  if (status === 0) {
    console.log(
      `doc-links: remark reports no unresolved relative link or heading anchor in ${files.length} Markdown files`,
    );
    return 0;
  }
  console.error(
    "doc-links: remark reports the problems above: fix each link, or the file or heading it names",
  );
  return 1;
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (error) => {
    console.error(error instanceof CannotRun ? error.message : (error?.stack ?? String(error)));
    process.exitCode = 2;
  },
);
