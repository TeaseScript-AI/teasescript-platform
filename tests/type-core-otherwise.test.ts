import assert from "node:assert/strict";
import test from "node:test";

import type { TypeCheckResult } from "../src/type-inference/backend.js";
import { CORE_BACKEND } from "../src/type-inference/core/backend.js";
import { withTestAllowance } from "../src/type-inference/core/budget.js";
import { analyzeTypes } from "../src/type-inference/index.js";
import { coreRequest } from "./helpers/type-core-analysis.js";
import { MODES, inMode } from "./helpers/type-core-oracles.js";

// #1072 (A59 + A68), V30 §18: the fallbacks of `otherwise` from its first link whose left side is never `null` never
// run (TSV062), decided once from the core's answer at that left read, for the warning and the plan's ways alike.

const GLOBALS = ["hostValue"];

/** A source's TSV062 warnings, as code, span and message, and its `otherwise` ways, by the core and by the legacy. */
function analysed(source: string, mode: (typeof MODES)[number]) {
  const request = coreRequest([{ path: "main.tease", source }], GLOBALS);
  assert.ok(request !== null, source);
  const warnings = (checked: TypeCheckResult) =>
    checked.diagnostics
      .flat()
      .filter((d) => d.code === "TSV062")
      .map((d) => [d.severity, d.span.start.offset, d.span.end.offset, d.message].join(" "));
  const core = inMode(mode, () => CORE_BACKEND.analyze(request).checked);
  const legacy = analyzeTypes(request).checked;
  return { core, legacy, coreWarnings: warnings(core), legacyWarnings: warnings(legacy) };
}

test("a fallback after a value that is never null warns as the current checker does: its site, its sentence and its ways", () => {
  // (the gate's three named witnesses, then chains, parentheses and the read forms V30 §18 names; each a warning the
  // current checker gives, at the same site and in the same words, with the same ways for its fallbacks)
  const sources = [
    "let n = null\nn = 1\nrepeat (n otherwise 2) {}\nexit\n",
    "say (1 otherwise null)\nexit\n",
    "let n = 9\nsay n otherwise 2\nexit\n",
    "let a = 1\nsay a otherwise 2 otherwise 3\nexit\n",
    'let nickname: string? = null\nsay nickname otherwise "pet" otherwise "x"\nexit\n',
    "let a = 1\nsay (a otherwise 2) otherwise 3\nexit\n",
    'let n = 1\nsay "${n otherwise 0}"\nexit\n',
    "let o = {p: 1}\nsay o.p otherwise 2\nexit\n",
    "let xs = [1, 2]\nsay xs[0] otherwise 0\nexit\n",
    'let d = dict {"a": 1}\nsay d["a"] otherwise 0\nexit\n',
    'let t = "14" otherwise "bad"\nsay toInteger(t, default: 0)\nexit\n',
  ];
  for (const mode of MODES)
    for (const source of sources) {
      const { core, legacy, coreWarnings, legacyWarnings } = analysed(source, mode);
      assert.ok(legacyWarnings.length > 0, `${source}: the current checker warns`);
      assert.deepEqual(coreWarnings, legacyWarnings, source);
      // (each way the core decides is the current checker's: the fallback never runs, the value always kept)
      for (const [place, ways] of core.ways.operands)
        assert.deepEqual(
          [...ways],
          [...(legacy.ways.operands.get(place) ?? [])],
          `${source}: ${place}`,
        );
      assert.ok(core.ways.operands.size > 0, `${source}: a dead fallback's way`);
    }
});

test("a value that may be null, of unknown type, from a parameter or unread after a stop gets no warning", () => {
  const sources = [
    "let n = null\nsay n otherwise 2\nexit\n",
    "say hostValue otherwise 1\nexit\n",
    'let v = load("k")\nsay v otherwise 1\nexit\n',
    "function f(x) {\n  say x otherwise 0\n}\nf(1)\nexit\n",
    "let n = 1\nif hostValue is integer {\n  n = null\n}\nsay n otherwise 2\nexit\n",
  ];
  for (const mode of MODES)
    for (const source of sources) {
      const { core } = analysed(source, mode);
      assert.deepEqual(
        core.diagnostics.flat().filter((d) => d.code === "TSV062"),
        [],
        source,
      );
      assert.equal(core.ways.operands.size, 0, source);
    }
  // (a stopped read proves nothing: at a small allowance the analysis stops before the left side's answer)
  const stopped = "let n = 9\nsay n otherwise 2\nexit\n";
  const request = coreRequest([{ path: "main.tease", source: stopped }], GLOBALS);
  assert.ok(request !== null);
  for (const mode of MODES) {
    const checked = withTestAllowance(1, () =>
      inMode(mode, () => CORE_BACKEND.analyze(request).checked),
    );
    const codes = checked.diagnostics.flat().map((d) => d.code);
    assert.ok(codes.includes("TSV076"), `stopped: ${codes.join(" ")}`);
    assert.ok(!codes.includes("TSV062"), `stopped: ${codes.join(" ")}`);
  }
});

test("a fallback that never runs is still checked: its error stays (ADR 0021 1.8)", () => {
  // (a fallback of another type is a compile error, also where it never runs, V30 §18)
  for (const mode of MODES) {
    const { core } = analysed('let n = 1\nsay n otherwise "x"\nexit\n', mode);
    const codes = core.diagnostics.flat().map((d) => `${d.severity} ${d.code}`);
    assert.ok(
      codes.some((code) => code.startsWith("error")),
      codes.join(" "),
    );
  }
});
