import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { checkEvidenceComments } from "./check-evidence.mjs";
import { lintFiles, repositoryRoot } from "./files.mjs";

const files = lintFiles();
let invalidEvidence = false;
for (const file of files) {
  for (const diagnostic of checkEvidenceComments(
    file,
    readFileSync(resolve(repositoryRoot, file), "utf8"),
  )) {
    console.error(
      `${diagnostic.fileName}:${diagnostic.line}:${diagnostic.column}: ${diagnostic.message}`,
    );
    invalidEvidence = true;
  }
}

if (invalidEvidence) {
  process.exitCode = 1;
} else {
  const executable = fileURLToPath(
    new URL("./bin/oxlint", import.meta.resolve("oxlint/package.json")),
  );
  const result = spawnSync(
    process.execPath,
    [
      executable,
      "--config",
      ".oxlintrc.json",
      "--disable-nested-config",
      "--report-unused-disable-directives-severity",
      "error",
      ...files,
    ],
    { cwd: repositoryRoot, stdio: "inherit" },
  );
  if (result.error) throw result.error;
  if (result.signal) process.kill(process.pid, result.signal);
  else process.exitCode = result.status ?? 1;
}
