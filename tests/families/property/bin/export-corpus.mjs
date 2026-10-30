#!/usr/bin/env node
// node bin/export-corpus.mjs PLAN.json NEW_MODULE.mjs "<where the plan's run is recorded>"
import { writeFileSync } from "node:fs";
import { readJson } from "../lib/json.mjs";
import { corpusModule } from "../lib/export.mjs";
try {
  const [plan, out, where, ...extra] = process.argv.slice(2);
  if (!plan || !out || !where || extra.length)
    throw new Error(
      'Usage: node bin/export-corpus.mjs PLAN.json NEW_MODULE.mjs "<where recorded>"',
    );
  writeFileSync(out, corpusModule(readJson(plan), where), { flag: "wx" });
  console.log(JSON.stringify({ exported: out, comparisonOnly: true }));
} catch (error) {
  console.error(error.stack);
  process.exitCode = 2;
}
