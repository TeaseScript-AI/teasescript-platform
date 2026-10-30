#!/usr/bin/env node
import { loadCompiler, observe, judgeRuns, storeInstruction } from "../adapters/compiler.mjs";
import { generate } from "../families/s8-stores.mjs";
import { modes } from "../lib/selection.mjs";
import { verifyBuild } from "../lib/build.mjs";
import { writeJson, hash } from "../lib/json.mjs";
try {
  const [build, out, ...flags] = process.argv.slice(2);
  if (!build || !out || flags.some((f) => f !== "--allow-runtime-mismatch"))
    throw new Error("Usage: node bin/canaries.mjs BUILD OUTPUT [--allow-runtime-mismatch]");
  const provenance = verifyBuild(build, flags.includes("--allow-runtime-mismatch")),
    api = await loadCompiler(build),
    rows = [];
  const cases = generate().filter(
    (c) =>
      c.dimensions.depth === 2 &&
      c.dimensions.nullable === "none" &&
      c.dimensions.carrier === "copy",
  );
  for (const c of cases) {
    const clean = observe(
      api,
      { id: c.id, case: c, mode: modes[0], policy: { kind: "demand", units: 64 } },
      { keepPlan: true },
    );
    if (clean.status !== "PASS")
      throw new Error(`Clean mutant anchor is not PASS: ${c.id}: ${clean.status}`);
    for (const mutation of ["delete-check", "outer-only", "wrong-leaf", "wrong-site"]) {
      const plan = structuredClone(clean.plan),
        store = storeInstruction(plan, c);
      if (mutation === "delete-check") delete store.typeCheck;
      if (mutation === "outer-only") store.typeCheck.type = { kind: "list", element: null };
      if (mutation === "wrong-leaf")
        store.typeCheck.type.element.element = {
          kind: c.dimensions.leaf === "integer" ? "string" : "integer",
        };
      if (mutation === "wrong-site") {
        store.value.span.so++;
        store.value.span.sc++;
      }
      const validation = api.validateInstructionPlan(plan);
      if (!validation.valid)
        throw new Error(
          `Invalid mutant (not detection): ${mutation}: ${JSON.stringify(validation)}`,
        );
      const result = judgeRuns(api, plan, c);
      rows.push({
        caseId: c.id,
        mutation,
        cleanHash: hash(clean.plan),
        mutantHash: hash(plan),
        valid: true,
        detected: result.failures.length > 0,
        properties: [...new Set(result.failures.map((x) => x.property))],
        executions: result.executions,
      });
    }
  }
  const result = {
    schemaVersion: 1,
    provenance,
    cleanBaselines: cases.length,
    mutants: rows.length,
    detected: rows.filter((x) => x.detected).length,
    rows,
  };
  writeJson(out, result);
  console.log(JSON.stringify(result));
  if (result.detected !== result.mutants) process.exitCode = 1;
} catch (error) {
  console.error(error.stack);
  process.exitCode = 2;
}
