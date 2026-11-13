// C13's checks on the candidate route: each new warning's check is its use's own, and a check that owes the runtime
// nothing reaches every reader, also past a stop.

import assert from "node:assert/strict";
import test from "node:test";

import { compileSourceWithBackend } from "../../../src/compiler.js";
import type { InstructionPlan } from "../../../src/plan/model.js";
import { run } from "../../../src/runtime/engine.js";
import {
  createCapturedSerializableList,
  createCapturedSerializableObject,
  type SerializableRuntimeValue,
} from "../../../src/runtime/values/serializable-values.js";
import { analyseCore } from "../../../src/type-inference/core/answers.js";
import { CandidateOutsideSlice, CORE_BACKEND } from "../../../src/type-inference/core/backend.js";
import { withTestAllowance } from "../../../src/type-inference/core/budget.js";
import { CoreProgram } from "../../../src/type-inference/core/program.js";
import { createImmediatePacingRuntimeSnapshot } from "../../helpers/immediate-pacing-runtime.js";
import { compactAnalysis, coreRequest } from "../../helpers/type-core-analysis.js";
import type { CompactRecord } from "../../helpers/type-core-records.js";
import { publishedAnswers } from "../../helpers/type-core-oracles.js";

/** A run of `plan` to its end with `hostValue`: what it said, and the code and span of its failure. */
function ran(plan: InstructionPlan, hostValue: SerializableRuntimeValue) {
  const result = run(plan, createImmediatePacingRuntimeSnapshot(plan, { globals: { hostValue } }));
  const failure = result.events.find((event) => event.kind === "runtimeFailure");
  return {
    said: result.events.flatMap((event) => (event.kind === "say" ? [event.text] : [])),
    failure:
      failure?.kind === "runtimeFailure"
        ? `${failure.code}@${failure.span.start.offset}:${failure.span.end.offset}`
        : null,
  };
}

/**
 * The source-to-runtime pairs of C13's new consumers on the candidate route: each warning's check is the use's own,
 * so the plan holds no check content for it and the same plan as the production route's checks; a value that fits
 * runs on, one that does not stops the run at the use, before the next effect.
 */
test("each new C13 warning's check is its use's own on the candidate route: a fitting run goes on, a misfit stops at the use", () => {
  // each program, its warned use, the call whose own check stops the run, its code, a fitting and a misfit value
  const object = createCapturedSerializableObject([{ name: "n", value: 1 }]);
  const cases: readonly (readonly [
    string,
    string,
    string,
    string,
    SerializableRuntimeValue,
    SerializableRuntimeValue,
  ])[] = [
    // (an argument of text, of a list; the elements `join` shows, `sort` orders; what `toJson` writes)
    [
      'say "abc".contains(hostValue)\nsay "after"\nexit\n',
      "hostValue",
      '"abc".contains(hostValue)',
      "TSV043",
      "a",
      1,
    ],
    [
      'let r = [1].union(hostValue)\nsay "after"\nexit\n',
      "hostValue",
      "[1].union(hostValue)",
      "TSV043",
      createCapturedSerializableList([2]),
      1,
    ],
    [
      'let xs = [hostValue]\nsay xs.join()\nsay "after"\nexit\n',
      "xs.join()",
      "xs.join()",
      "TSV042",
      "a",
      object,
    ],
    [
      'let xs = [hostValue, hostValue]\nxs.sort()\nsay "after"\nexit\n',
      "xs.sort()",
      "xs.sort()",
      "TSV043",
      2,
      object,
    ],
    [
      'say toJson(hostValue otherwise /a/)\nsay "after"\nexit\n',
      "hostValue otherwise /a/",
      "toJson(hostValue otherwise /a/)",
      "TSV043",
      "x",
      null,
    ],
  ];
  for (const [source, use, stops, code, fitting, misfit] of cases) {
    const result = compileSourceWithBackend(source, { globals: ["hostValue"] }, CORE_BACKEND);
    assert.ok(result.plan !== null, source);
    const at = source.indexOf(use);
    assert.ok(
      result.diagnostics.some(
        (d) =>
          d.severity === "warning" &&
          d.span.start.offset === at &&
          d.span.end.offset === at + use.length,
      ),
      `${source}: ${result.diagnostics.map((d) => d.message).join(" | ")}`,
    );
    const fits = ran(result.plan, fitting);
    assert.equal(fits.failure, null, `${source}: fitting`);
    assert.equal(fits.said.at(-1), "after", `${source}: fitting`);
    const call = source.indexOf(stops);
    assert.deepEqual(
      ran(result.plan, misfit),
      { said: [], failure: `${code}@${call}:${call + stops.length}` },
      `${source}: misfit`,
    );
  }
});

/**
 * G3's seam at every reader and stop (Sol r1 B3): a check that owes the runtime nothing, an ordinary warning or an
 * error, stands in the core's record (`compactAnalysis`), its publication (`publishedAnswers`) and the candidate route's
 * diagnostics beside a retained runtime obligation; at every allowance, also one that stops a question after the
 * finished analysis, each reader answers, and holds the check or the stop's warning.
 */
test("a check that owes the runtime nothing reaches every reader, and a stop after the finished analysis keeps the readers answering", () => {
  const cases: readonly (readonly [string, "warning" | "compile-error", string])[] = [
    ["let n: integer = hostValue\nfor i in 3..1 {}\nexit\n", "warning", "TSV046"],
    ['repeat toInteger("-2", default: 0) {}\nexit\n', "compile-error", "TSV011"],
    ['say toInteger("bad", default: 0)\nexit\n', "compile-error", "TSV043"],
    [
      'let a: integer = hostValue\nsay toInteger("bad", default: 0)\nfor i in 3..1 {}\nexit\n',
      "compile-error",
      "TSV043",
    ],
  ];
  const failures: string[] = [];
  for (const [source, wanted, code] of cases) {
    const request = coreRequest([{ path: "main.tease", source }], ["hostValue"]);
    assert.ok(request !== null, source);
    const bindings = new CoreProgram(request).places
      .filter(({ kind }) => kind.kind === "binding")
      .map((place) => place.id);
    const holds = (record: CompactRecord): boolean =>
      record.diagnostics.some((d) => d.kind === "static" && d.class === wanted);
    const stopped = (record: CompactRecord): boolean =>
      record.diagnostics.some((d) => d.kind === "budget");
    const record = compactAnalysis(request);
    if (!holds(record)) failures.push(`${source}: the record lacks it`);
    if (source.includes("hostValue") && record.checks.length === 0)
      failures.push(`${source}: the record lacks the retained obligation`);
    const published = JSON.parse(publishedAnswers(analyseCore(request), bindings, request).record);
    if (
      !published.serialized.diagnostics.some(
        (d: { kind: string; class: string }) => d.kind === "static" && d.class === wanted,
      )
    )
      failures.push(`${source}: the publication lacks it`);
    const compiled = compileSourceWithBackend(source, { globals: ["hostValue"] }, CORE_BACKEND);
    if (!compiled.diagnostics.some((d) => d.code === code))
      failures.push(`${source}: the candidate route lacks it`);
    const total = analyseCore(request).budget.total;
    for (let allowance = 1; allowance <= total + 400; allowance += 1) {
      let made: CompactRecord;
      // (the route's diagnostics' codes, or `null` where it declines)
      let codes: string[] | null;
      try {
        made = withTestAllowance(allowance, () => compactAnalysis(request));
        const { budget } = withTestAllowance(allowance, () => {
          const answers = analyseCore(request);
          publishedAnswers(answers, bindings, request);
          return answers;
        });
        try {
          codes = withTestAllowance(allowance, () =>
            compileSourceWithBackend(source, { globals: ["hostValue"] }, CORE_BACKEND),
          ).diagnostics.map((d) => d.code);
        } catch (error) {
          // (before admission settled the stop leaves the loop variable's store undecided, and the plain gate
          // declines, #2080 part 2: the route's answer, beside the readers')
          if (
            !(error instanceof CandidateOutsideSlice) ||
            error.what !== "a store whose check was left undecided at the budget" ||
            budget.exhausted === null ||
            budget.settled
          )
            throw error;
          codes = null;
        }
      } catch (error) {
        failures.push(`${source} at ${allowance}: ${String(error)}`);
        break;
      }
      if (!holds(made) && !stopped(made)) {
        failures.push(`${source} at ${allowance}: neither the check nor a stop`);
        break;
      }
      if (codes !== null && !codes.includes(code) && !codes.includes("TSV076")) {
        failures.push(`${source} at ${allowance}: the route has neither the check nor a stop`);
        break;
      }
    }
  }
  assert.deepEqual(failures, []);
});
