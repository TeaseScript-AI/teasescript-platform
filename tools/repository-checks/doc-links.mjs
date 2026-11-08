#!/usr/bin/env node
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

// The Markdown links (docs/TESTING.md "Normal and diagnostic verification"): remark-validate-links reports every
// relative link and heading anchor in the Markdown files that Git tracks or does not ignore that does not resolve.
//
//   node tools/repository-checks/doc-links.mjs       (in the repository's top folder; `npm run check:doc-links`)
//
// It runs in `check:pretest` and in `tools/check-changed.mjs`, for every change.
//
// It runs remark-cli with the plugins of package.json's `remarkConfig`: remark-gfm, and remark-validate-links with
// `repository: false`, so absolute URLs, this repository's included, are not checked. The files are Git's list
// (`git ls-files --cached --others --exclude-standard`) of `*.md` files, those that exist in the working tree.
//
// Outside the claim, as remark-validate-links does not read them as GitHub does: raw-HTML links (`<a href>`), and
// GitHub's view forms: `?plain=1` and `?raw=1`, a folder's README anchors, and a heading GitHub's sanitizer filters a
// tag from. The docs have none of these; one that appears is not checked. A reference definition naming a missing file
// is reported even when no link uses it.
//
// Exit status: 0 when every link resolves, 1 when remark reports one that does not (or another problem, in its report),
// 2 when it cannot run.

const root = process.cwd();
let files;
try {
  files = [
    ...new Set(
      execFileSync(
        "git",
        ["ls-files", "-z", "--cached", "--others", "--exclude-standard", "--", "*.md"],
        { cwd: root, encoding: "utf8" },
      ).split("\0"),
    ),
  ].filter((file) => file !== "" && existsSync(join(root, file)));
} catch (error) {
  console.error(`doc-links: cannot list the Markdown files with Git: ${error.message}`);
  process.exit(2);
}
if (files.length === 0) {
  console.log("doc-links: no Markdown files");
  process.exit(0);
}

const result = spawnSync(
  process.execPath,
  [
    join(root, "node_modules/remark-cli/cli.js"),
    "--frail",
    "--quiet",
    "--no-stdout",
    "--no-color",
    ...files,
  ],
  { cwd: root, stdio: "inherit" },
);
if (result.error !== undefined || result.signal !== null) {
  console.error(`doc-links: remark-cli did not run: ${result.error?.message ?? result.signal}`);
  process.exit(2);
}
if (result.status === 0)
  console.log(
    `doc-links: every relative link and heading anchor in ${files.length} Markdown files resolves`,
  );
else
  console.error(
    `doc-links: remark reports the problems above (exit ${result.status}): fix each link, or the file or heading it names`,
  );
process.exit(result.status === 0 ? 0 : 1);
