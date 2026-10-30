#!/usr/bin/env node
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { readJson, writeJson } from "../lib/json.mjs";
import { mergeShards } from "../lib/merge.mjs";
try {
  const [out, ...dirs] = process.argv.slice(2);
  if (!out || !dirs.length) throw new Error("Usage: node bin/merge.mjs NEW_OUTPUT SHARD_DIR...");
  const result = mergeShards(
    dirs.map((dir) => ({
      plan: readJson(join(dir, "plan.json")),
      metadata: readJson(join(dir, "metadata.json")),
      summary: readJson(join(dir, "summary.json")),
      rows: readFileSync(join(dir, "results.jsonl"), "utf8")
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((s) => JSON.parse(s)),
    })),
  );
  mkdirSync(out, { recursive: false });
  writeJson(join(out, "plan.json"), result.plan);
  writeJson(join(out, "summary.json"), result.summary);
  writeFileSync(
    join(out, "results.jsonl"),
    result.rows.map((r) => JSON.stringify(r)).join("\n") + "\n",
  );
  console.log(JSON.stringify(result.summary));
} catch (error) {
  console.error(error.stack);
  process.exitCode = 2;
}
