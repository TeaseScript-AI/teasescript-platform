#!/usr/bin/env node
import { execFileSync, spawnSync } from "node:child_process";
import { lstatSync } from "node:fs";
import { delimiter, dirname, join } from "node:path";

// The Markdown links (docs/TESTING.md "Normal and diagnostic verification"): remark-validate-links reports every
// relative link and heading anchor in the Markdown files that Git tracks or does not ignore that does not resolve.
//
//   node tools/repository-checks/doc-links.mjs       (in the repository's top folder; `npm run check:doc-links`)
//
// It runs in `check:pretest` and in `tools/check-changed.mjs`, for every change.
//
// It runs remark-cli's `remark` (from `node_modules/.bin`, on this Node) with the plugins of package.json's
// `remarkConfig` and no other configuration (`--rc-path package.json`, so a `.remarkrc` or a nested `package.json`
// cannot replace it): remark-gfm, and remark-validate-links with `repository: false`, so absolute URLs, this
// repository's included, are not checked. The files are Git's list (`git ls-files --cached --others
// --exclude-standard`) of `*.md` entries that are regular files in the working tree, so a deleted file, a symlink and a
// submodule are not passed; remark reads exactly those (`--no-ignore`, and `--` before the names, so a name such as
// `--help.md` is a file).
//
// Outside the claim, as remark-validate-links does not read them as GitHub does: raw-HTML links (`<a href>`), and
// GitHub's view forms: `?plain=1` and `?raw=1`, a folder's README anchors, and a heading GitHub's sanitizer filters a
// tag from. The docs have none of these; such a link does not get GitHub's reading, so it may be refused though GitHub
// resolves it, or pass though GitHub does not. A reference definition naming a missing file is reported even when no
// link uses it.
//
// Exit status: 0 when remark reports nothing, 1 when it reports a link that does not resolve (or another problem, in
// its report), 2 when it cannot run.

const root = process.cwd();
let files;
try {
  files = [
    ...new Set(
      execFileSync(
        "git",
        ["ls-files", "-z", "--cached", "--others", "--exclude-standard", "--", "*.md"],
        { cwd: root, encoding: "utf8", maxBuffer: 1024 * 1024 * 1024 },
      ).split("\0"),
    ),
  ].filter(
    (file) =>
      file !== "" && lstatSync(join(root, file), { throwIfNoEntry: false })?.isFile() === true,
  );
} catch (error) {
  console.error(`doc-links: cannot list the Markdown files with Git: ${error.message}`);
  process.exit(2);
}
if (files.length === 0) {
  console.log("doc-links: no Markdown files");
  process.exit(0);
}

/** remark's options: the root configuration only, Git's files only, and the names after `--`. */
const OPTIONS = [
  "--frail",
  "--quiet",
  "--no-stdout",
  "--no-color",
  "--rc-path",
  "package.json",
  "--no-ignore",
];
const result = spawnSync("remark", [...OPTIONS, "--", ...files], {
  cwd: root,
  stdio: "inherit",
  env: {
    ...process.env,
    PATH: [join(root, "node_modules/.bin"), dirname(process.execPath), process.env.PATH].join(
      delimiter,
    ),
  },
});
if (result.error !== undefined || result.signal !== null) {
  console.error(`doc-links: remark-cli did not run: ${result.error?.message ?? result.signal}`);
  process.exit(2);
}
if (result.status === 0)
  console.log(
    `doc-links: remark reports no unresolved relative link or heading anchor in ${files.length} Markdown files`,
  );
else
  console.error(
    `doc-links: remark reports the problems above (exit ${result.status}): fix each link, or the file or heading it names`,
  );
process.exit(result.status === 0 ? 0 : 1);
