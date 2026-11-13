import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { checkChargedIteration } from "./check-charged-iteration.mjs";
import { checkCommentDeclarations } from "./check-comment-declarations.mjs";
import { checkCommentForecasts } from "./check-comment-forecasts.mjs";
import { checkEvidenceComments } from "./check-evidence.mjs";
import { checkObligationInventory } from "./check-obligation-inventory.mjs";
import { checkQuestionSources } from "./check-question-sources.mjs";
import { checkRetainedState } from "./check-retained-state.mjs";
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
// Without arguments it lints the whole repository. Any other argument, such as a file, is refused (exit 2), naming the
// command that runs oxlint alone on named files; except:
//
//   node tools/oxlint/run.mjs --files FILE…
//
// a builder's quick look at named files, not the lint: oxlint with the same options and the one per-file own check
// (evidence comments) on those files only; the own cross-file checks do not run. Its last line, in every outcome, says
// so. No file, or a file that does not exist or that the lint does not cover (`lintFiles`), exits 2 and names it.
// Exit status: 2 for an argument, else oxlint's when it failed, else 1 when the own checks found anything, else 0.

if (process.argv[2] === "--files") {
  const named = process.argv.slice(3);
  const refuse = (message) => {
    process.stderr.write(`oxlint/run.mjs --files: ${message}\n`);
    process.exit(2);
  };
  if (named.length === 0) refuse("names no file: --files FILE…");
  const covered = new Set(lintFiles());
  const files = named.map((file) => {
    const path = relative(repositoryRoot, resolve(file)).split(sep).join("/");
    if (!existsSync(resolve(file))) refuse(`${file} does not exist`);
    if (!covered.has(path)) refuse(`${file} is outside what the lint covers`);
    return path;
  });
  let findings = 0;
  for (const file of files)
    for (const diagnostic of checkEvidenceComments(
      file,
      readFileSync(resolve(repositoryRoot, file), "utf8"),
    )) {
      console.error(
        `${diagnostic.fileName}:${diagnostic.line}:${diagnostic.column}: ${diagnostic.message}`,
      );
      findings += 1;
    }
  const executable = fileURLToPath(
    new URL("./bin/oxlint", import.meta.resolve("oxlint/package.json")),
  );
  const result = spawnSync(process.execPath, [executable, ...OXLINT_OPTIONS, ...files], {
    cwd: repositoryRoot,
    stdio: "inherit",
  });
  if (result.error) console.error(`oxlint did not run: ${result.error.message}`);
  console.log(
    `lint --files: ${files.length} named files, oxlint and the evidence-comment check only; the repository's own cross-file checks did not run (npm run lint, check-changed)`,
  );
  if (result.error) process.exit(2);
  if (result.signal) process.kill(process.pid, result.signal);
  process.exit(result.status !== 0 ? (result.status ?? 1) : findings > 0 ? 1 : 0);
}

if (process.argv.length > 2) {
  process.stderr.write(
    "oxlint/run.mjs takes no arguments: it lints the whole repository, its own checks and then oxlint over every file, " +
      "as `npm run lint` does, which takes minutes.\n" +
      `oxlint alone on named files, without the repository's own checks: node node_modules/oxlint/bin/oxlint ${OXLINT_OPTIONS.join(" ")} <files>\n`,
  );
  process.exit(2);
}

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
  ...checkRetainedState(repositoryRoot),
  ...checkSiteKeys(repositoryRoot),
  ...(await checkWaitingOverrides(
    repositoryRoot,
    ".oxlintrc.json",
    readFileSync(resolve(repositoryRoot, ".oxlintrc.json"), "utf8"),
    new Set(files),
    executable,
  )),
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
