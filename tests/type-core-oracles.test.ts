import assert from "node:assert/strict";
import test from "node:test";

import { analyseCore, type Answers } from "../src/type-inference/core/answers.js";
import { withTestDemandAllowance } from "../src/type-inference/core/budget.js";
import { withConsumerOrder } from "../src/type-inference/core/consumers.js";
import { coreRequest } from "./helpers/type-core-analysis.js";
import { MODES, stoppedRecord, stopSet } from "./helpers/type-core-oracles.js";

/*
 * Controls of the stop-set comparison (`stopSet`, `tests/helpers/type-core-oracles.ts`), which later reviews and the
 * generator corpus trust to report what a stop changes (PR #1427's Astra review).
 */

const GLOBALS = ["hostValue", "hostOther", "hostInit"];

test("the stop-set comparison reports a change confined to a stopped diagnostic's code", () => {
  const source = 'let counts: integer[] = ["red", "blue"]\nexit\n';
  const request = coreRequest([{ path: "main.tease", source }], GLOBALS);
  assert.ok(request !== null);
  const stopped = withTestDemandAllowance(16, () => analyseCore(request));
  assert.ok((stopped.budget.counts.get("stopPasses") ?? 0) > 0, "the analysis stops at 16");
  const deferred = stopped.diagnostics.find((d) => d.code === "TSV041");
  assert.ok(deferred !== undefined, "the stop defers the store's check");
  // EVIDENCE: invariant: only the code changes; the diagnostic keeps the shape the analysis gave it.
  const recoded = { ...deferred, code: "TSV044" } as typeof deferred;
  // (the same answers but that one diagnostic's code: what a defect confined to the stop would publish)
  const changed: Answers = {
    ...stopped,
    diagnostics: stopped.diagnostics.map((d) => (d === deferred ? recoded : d)),
  };
  assert.notEqual(stoppedRecord(changed, ["main.tease"]), stoppedRecord(stopped, ["main.tease"]));
});

test("an analysis run inside a consumer-order callback leaves the stop trace of the analysis around it alone", () => {
  const files = [
    {
      path: "main.tease",
      source:
        "let seed = [1]\nlet a = seed\nlet b = a\nlet c = b\na = c\nb = [hostValue]\nsay c[0]\nexit",
    },
  ];
  const inner = coreRequest(
    [{ path: "main.tease", source: "let count = 4\nsay count + 2\nexit" }],
    GLOBALS,
  );
  assert.ok(inner !== null);
  const plain = stopSet(files, MODES[0]!, GLOBALS, 1);
  assert.ok(plain !== null && plain.stops.length > 0, "the analysis stops at 1");
  let nested = false;
  const around = withConsumerOrder(
    (list) => {
      if (!nested) {
        nested = true;
        assert.ok(
          analyseCore(inner).budget.counts.get("stopPasses"),
          "the inner analysis stops too",
        );
      }
      return [...list];
    },
    () => stopSet(files, MODES[0]!, GLOBALS, 1),
  );
  assert.ok(nested);
  assert.deepEqual(around, plain);
});
