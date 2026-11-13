// Ruling 3's typed probe (research code): for each workload, how many of the plan's expression sites the emitter asked
// a type for found one by span and AST kind, and whether the typed program says what today's engine says.
//   node study/js-route/typed-check.mjs FACTS.json WORKLOAD.tease...   (FACTS: { name: facts().values })
import fs from "node:fs";
import path from "node:path";
import { compileSource, createFreshRuntimeSession } from "../../dist/src/index.js";
import { compileProgram, createEmittedSession } from "./driver.mjs";
const [factsFile, ...files] = process.argv.slice(2);
const facts = JSON.parse(fs.readFileSync(factsFile, "utf8"));
const FRESH = { seed: 5, wallClockMs: 1791633600000 };
const said = (events) => events.filter((e) => e.kind === "say").map((e) => JSON.stringify(e.content));
for (const file of files) {
  const name = path.basename(file, ".tease");
  const plan = compileSource(fs.readFileSync(file, "utf8")).plan;
  const typed = compileProgram(plan, false, false, facts[name]);
  const today = createFreshRuntimeSession(plan, FRESH);
  const expected = said(today.run({ instructionBudget: 2e9 }).events);
  const session = createEmittedSession(plan, FRESH, { facts: facts[name] });
  const actual = said(session.run().events);
  const same = JSON.stringify(expected) === JSON.stringify(actual) && today.exportSnapshot().rng.state === session.state.rng.state;
  console.log(JSON.stringify({ name, same, ...typed.typeStats, typedSize: typed.source.length, untypedSize: compileProgram(plan).source.length }));
}
