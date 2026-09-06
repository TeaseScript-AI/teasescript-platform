import { spawnSync } from "node:child_process";

import { lintFiles, repositoryRoot } from "./files.mjs";

const tests = lintFiles().filter(
  (file) => file.startsWith("tools/oxlint/") && /\.test\.(?:ts|mjs)$/.test(file),
);
if (tests.length === 0) throw new Error("No lint rule or exception fixtures were found.");

const fullOutput = process.argv.includes("--full-output") ? ["--full-output"] : [];
const result = spawnSync(
  process.execPath,
  ["tools/test-output-filter.mjs", ...fullOutput, ...tests],
  { cwd: repositoryRoot, stdio: "inherit" },
);
if (result.error) throw result.error;
if (result.signal) process.kill(process.pid, result.signal);
else process.exitCode = result.status ?? 1;
