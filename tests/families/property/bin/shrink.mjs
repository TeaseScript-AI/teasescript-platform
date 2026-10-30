#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { readJson, writeJson } from "../lib/json.mjs";
import { verifyBuild } from "../lib/build.mjs";
import { loadCompiler } from "../adapters/compiler.mjs";
import { shrink } from "../lib/shrink.mjs";
try {
  const [build, results, out, seed = "1442", ...flags] = process.argv.slice(2);
  if (
    !build ||
    !results ||
    !out ||
    flags.some((f) => f !== "--allow-runtime-mismatch")
  )
    throw new Error(
      "Usage: node bin/shrink.mjs BUILD results.jsonl output.json SEED [--allow-runtime-mismatch]",
    );
  const provenance = verifyBuild(
    build,
    flags.includes("--allow-runtime-mismatch"),
  );
  const result = readFileSync(results, "utf8")
    .trim()
    .split("\n")
    .map(JSON.parse)
    .find((r) => r.status === "FAIL" && r.reproduction);
  if (!result)
    throw new Error("No reproducible failing configuration in input");
  const config = { id: result.id, ...result.reproduction };
  const reduced = shrink(await loadCompiler(build), config, {
    seed: Number(seed),
  });
  writeJson(out, { ...reduced, provenance });
  console.log(
    JSON.stringify({
      identity: reduced.identity,
      attempts: reduced.attempts,
      original: reduced.originalSource.length,
      reduced: reduced.source.length,
    }),
  );
} catch (error) {
  console.error(error.stack);
  process.exitCode = 2;
}
