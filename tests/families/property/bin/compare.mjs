#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { compare } from "../lib/compare.mjs";
import { writeJson } from "../lib/json.mjs";
try {
  const [base, head, out] = process.argv.slice(2);
  if (!out) throw new Error("Usage: node bin/compare.mjs BASE.jsonl HEAD.jsonl OUT.json");
  const read = (p) => readFileSync(p, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse);
  const result = compare(read(base), read(head));
  writeJson(out, result);
  console.log(
    JSON.stringify({
      fixed: result.fixed.length,
      regressed: result.regressed.length,
      incomparable: result.incomparableCount,
    }),
  );
  if (result.regressed.length) process.exitCode = 1;
} catch (error) {
  console.error(error.stack);
  process.exitCode = 2;
}
