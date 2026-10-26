import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";

/*
 * Scale regressions of deep literals (TABLE r4.56, r4.58): before the core charged the work its literal indexes keep,
 * the candidate route's analysis of a list literal nested 1,024 deep, and the core's of any literal nested 1,024 deep
 * with one read of it, grew until the process died (V8's heap abort, or a 2 GiB scope's OOM kill). Now the program's
 * work allowance stops them first. Per literal kind, a child process with a capped V8 heap compiles `let value =` the
 * literal nested 1,024, 4,096 and 4,097 deep on the candidate route (`compileSourceWithBackend(…, CORE_BACKEND)`;
 * after the switch, production `compileSource(source)` in its place) and analyses the same literal with one read of it
 * in the core. Each must end with a plan or the candidate's structured rejection (the allowance's stop, or the slice it
 * does not cover yet: records and dicts, lists deeper than its facts follow), and with the core's outcome, its
 * allowance's `budget-error` included; a signal exit (134, 137), an uncaught exception or the timeout fails the test.
 * 4,096 is the deepest depth measured, 4,097 one beyond it: scale regressions, not a supported maximum, since none
 * exists.
 */

const DEPTHS = [1_024, 4_096, 4_097];

/** Per literal kind: its opening and closing text around the leaf, and a read of its first level. */
const KINDS: readonly (readonly [string, string, string, string])[] = [
  ["list", "[", "]", "value[0]"],
  ["record", "{x:", "}", "value.x"],
  ["dict", "dict{x:", "}", 'value["x"]'],
];

/** The heap a child may use: about the deepest case's need with a margin, far below what the uncharged work took. */
const HEAP_MIB = 1_536;

const url = (path: string): string => JSON.stringify(new URL(path, import.meta.url).href);

/**
 * The lines `script` prints in a child with the capped heap and a timeout, each the depth, tab-separated from what it
 * reports there; a signal, an error, a non-zero exit or the timeout fails `name`.
 */
function childLines(name: string, script: string): string[] {
  const child = spawnSync(
    process.execPath,
    [`--max-old-space-size=${HEAP_MIB}`, "--input-type=module", "--eval", script],
    { encoding: "utf8", timeout: 120_000, maxBuffer: 256 * 1024 },
  );
  const lines = child.stdout.trim().split("\n").filter(Boolean);
  const reached = `after depth ${lines.at(-1)?.split("\t")[0] ?? "none"}`;
  assert.equal(child.error, undefined, `${name}: ${child.error?.message} ${reached}`);
  assert.equal(child.signal, null, `${name}: killed by ${child.signal} ${reached}`);
  assert.equal(
    child.status,
    0,
    `${name}: exit ${child.status} ${reached}\n${child.stderr.slice(-2_000)}`,
  );
  return lines;
}

for (const [kind, open, close, read] of KINDS)
  test(`a ${kind} literal nested ${DEPTHS.join(", ")} deep compiles or stops within the allowance, never crashing`, () => {
    const script = `
      import {compileSourceWithBackend} from ${url("../src/compiler.js")};
      import {CandidateOutsideSlice, CORE_BACKEND} from ${url("../src/type-inference/core/backend.js")};
      import {analyseCore} from ${url("../src/type-inference/core/answers.js")};
      import {coreRequest} from ${url("./helpers/type-core-analysis.js")};
      for (const depth of ${JSON.stringify(DEPTHS)}) {
        const literal = ${JSON.stringify(open)}.repeat(depth) + "1" + ${JSON.stringify(close)}.repeat(depth);
        let candidate;
        try {
          candidate = compileSourceWithBackend("let value = " + literal + "\\nexit\\n", {}, CORE_BACKEND).plan === null ? "no plan" : "plan";
        } catch (error) {
          if (!(error instanceof CandidateOutsideSlice)) throw error;
          candidate = "outside: " + error.what;
        }
        const request = coreRequest([{path: "main.tease", source: "let value = " + literal + "\\nlet n: integer = " + ${JSON.stringify(read)} + "\\nexit\\n"}]);
        console.log(depth + "\\t" + candidate + "\\t" + analyseCore(request).outcome);
      }
    `;
    // (a line per depth: the depth, the candidate's result and the core's outcome)
    const lines = childLines(kind, script);
    assert.deepEqual(
      lines.map((line) => Number(line.split("\t")[0])),
      DEPTHS,
    );
    for (const line of lines)
      assert.match(
        line,
        /^\d+\t(plan|outside: [^\t]+)\t(valid|warning-runtime-check|compile-error|budget-error)$/,
        `${kind}: ${line}`,
      );
  });

/**
 * A record nested 2,048 deep whose property names are each over 1,024 characters long, never read: admission kept the
 * text of its paths uncharged, and the analysis died at 5 % of the allowance (the deep-literal review's witness). The
 * core analyses it at that depth and one beyond in a child with the same heap; it must end with its outcome.
 */
test("a record nested 2,048 and 2,049 deep with long property names stops within the allowance, never crashing", () => {
  const depths = [2_048, 2_049];
  const script = `
    import {analyseCore} from ${url("../src/type-inference/core/answers.js")};
    import {coreRequest} from ${url("./helpers/type-core-analysis.js")};
    for (const depth of ${JSON.stringify(depths)}) {
      const names = Array.from({length: depth}, (_, i) => "field" + i + "_" + "q".repeat(1024));
      const source = "let value = " + names.map((name) => "{" + name + ":").join("") + "1" + "}".repeat(depth) + "\\nexit\\n";
      console.log(depth + "\\t" + analyseCore(coreRequest([{path: "main.tease", source}])).outcome);
    }
  `;
  const lines = childLines("long names", script);
  assert.deepEqual(
    lines.map((line) => Number(line.split("\t")[0])),
    depths,
  );
  for (const line of lines)
    assert.match(line, /^\d+\t(valid|warning-runtime-check|compile-error|budget-error)$/, line);
});
