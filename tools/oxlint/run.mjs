import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { checkChargedIteration } from "./check-charged-iteration.mjs";
import { checkCommentDeclarations } from "./check-comment-declarations.mjs";
import { checkCommentForecasts } from "./check-comment-forecasts.mjs";
import { checkEvidenceComments } from "./check-evidence.mjs";
import { checkObligationInventory } from "./check-obligation-inventory.mjs";
import { checkQuestionSources } from "./check-question-sources.mjs";
import { checkSiteKeys } from "./check-site-keys.mjs";
import { checkWaitingOverrides } from "./check-waiting-overrides.mjs";
import { lintFiles, OXLINT_OPTIONS, repositoryRoot } from "./files.mjs";

// Runs the repository's own lint checks, then oxlint with its type-aware rules (`--type-aware`, through
// `oxlint-tsgolint`), over the same files (`npm run lint`):
//
//   node tools/oxlint/run.mjs
//
// The own checks print their findings first; oxlint always runs after them, so one finding does not hide the other's.
// When the own checks found anything, a last line counts their findings, as oxlint's output would bury them.
// Exit status: oxlint's when it failed, else 1 when the own checks found anything, else 0.

const files = lintFiles();
const executable = fileURLToPath(
  new URL("./bin/oxlint", import.meta.resolve("oxlint/package.json")),
);
let ownFindings = 0;
for (const file of files) {
  for (const diagnostic of checkEvidenceComments(
    file,
    readFileSync(resolve(repositoryRoot, file), "utf8"),
  )) {
    console.error(
      `${diagnostic.fileName}:${diagnostic.line}:${diagnostic.column}: ${diagnostic.message}`,
    );
    ownFindings += 1;
  }
}
for (const diagnostic of [
  ...checkChargedIteration(repositoryRoot),
  ...checkCommentForecasts(repositoryRoot),
  ...checkCommentDeclarations(repositoryRoot),
  ...checkObligationInventory(repositoryRoot),
  ...checkQuestionSources(repositoryRoot),
  ...checkSiteKeys(repositoryRoot),
  ...checkWaitingOverrides(
    repositoryRoot,
    ".oxlintrc.json",
    readFileSync(resolve(repositoryRoot, ".oxlintrc.json"), "utf8"),
    new Set(files),
    executable,
  ),
]) {
  console.error(
    `${diagnostic.fileName}:${diagnostic.line}:${diagnostic.column}: ${diagnostic.message}`,
  );
  ownFindings += 1;
}

const result = spawnSync(process.execPath, [executable, ...OXLINT_OPTIONS, ...files], {
  cwd: repositoryRoot,
  stdio: "inherit",
});
if (result.error) throw result.error;
if (ownFindings > 0)
  console.error(
    `lint: ${ownFindings} findings of the repository's own checks, above oxlint's output`,
  );
if (result.signal) process.kill(process.pid, result.signal);
else process.exitCode = result.status !== 0 ? (result.status ?? 1) : ownFindings > 0 ? 1 : 0;
