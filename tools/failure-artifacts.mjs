// Where a browser tool keeps a run's artifacts, which it keeps only when the run fails. In a queue job (`$SX_OUT` set),
// the folder is made in the job's results folder, which the queue copies back: the job's own `TMPDIR` is removed with
// the job. Elsewhere it is made in the system's temporary folder.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";

/** A new folder for a run of `tool`: in `$SX_OUT` when it is set, else in the system's temporary folder. */
export function artifactsFolder(tool) {
  return mkdtempSync(join(process.env.SX_OUT || tmpdir(), `${tool}-`));
}

/** After the run: removes `folder` when the run passed; else keeps it and names it, in a queue job as its results do. */
export function settleArtifacts(tool, folder, passed) {
  if (passed) {
    rmSync(folder, { recursive: true, force: true });
    return;
  }
  const results = process.env.SX_OUT;
  console.error(
    `${tool}: failure artifacts retained at ${folder}${results ? ` (the queue job's results: out/${relative(results, folder)})` : ""}`,
  );
}
