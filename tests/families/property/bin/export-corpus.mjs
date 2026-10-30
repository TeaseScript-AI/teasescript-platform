#!/usr/bin/env node
import { writeFileSync } from "node:fs";
import { readJson } from "../lib/json.mjs";
import { corpusModule } from "../lib/export.mjs";
try {
  const [plan, out, ...extra] = process.argv.slice(2);
  if (!plan || !out || extra.length)
    throw new Error(
      "Usage: node bin/export-corpus.mjs PLAN.json NEW_MODULE.mjs",
    );
  writeFileSync(out, corpusModule(readJson(plan)), { flag: "wx" });
  console.log(JSON.stringify({ exported: out, comparisonOnly: true }));
} catch (error) {
  console.error(error.stack);
  process.exitCode = 2;
}
