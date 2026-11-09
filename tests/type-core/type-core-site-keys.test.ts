import assert from "node:assert/strict";
import test from "node:test";

import { compileProject } from "../../src/compiler.js";
import { analyseCore } from "../../src/type-inference/core/answers.js";
import { enclosingFunction, planFileOf, planSiteKey, siteKey } from "../helpers/site-keys.js";
import { coreRequest } from "../helpers/type-core-analysis.js";

test("a site's key names its file: a plan's instruction by the file it comes from, a function in the site's own file (#1700)", () => {
  // (two files whose offsets meet: other.tease's function spans offsets where main.tease reads `xs` outside any, and its
  // global's start value is an instruction in main.tease's range that names other.tease, Codex r5's item 2 on #1687)
  const files = [
    { path: "main.tease", source: 'let xs = [1, 2]\nsay "${xs[0]}"\ncall "other.tease"\nexit\n' },
    {
      path: "other.tease",
      source: 'global g = 3\nfunction shadow(xs: list) {\n  say "${xs[0]}"\n}\n',
    },
  ];
  const { plan, diagnostics } = compileProject(files);
  assert.ok(plan !== null, diagnostics.map((d) => d.code).join(","));
  const start = plan.instructions.findIndex((instruction) => instruction.kind === "declareGlobal");
  assert.ok(start >= plan.files[0]!.startInstruction && start < plan.files[0]!.endInstruction);
  assert.equal(planFileOf(plan, start), 1);
  const { so, eo } = plan.instructions[start]!.span;
  assert.equal(planSiteKey(plan, start), `1:${so}:${eo}`);
  assert.equal(siteKey({ file: 1, start: so, end: eo }), planSiteKey(plan, start));
  assert.throws(() => planSiteKey(plan, plan.instructions.length), /outside every file/);
  const { graph } = analyseCore(coreRequest(files, [])!);
  const read = files[0]!.source.indexOf("xs[0]");
  const inside = files[1]!.source.indexOf("xs[0]");
  assert.equal(
    enclosingFunction(graph, { file: 0, start: read, end: read + 2 })?.declaration.name.name,
    undefined,
  );
  assert.equal(
    enclosingFunction(graph, { file: 1, start: inside, end: inside + 2 })?.declaration.name.name,
    "shadow",
  );
});
