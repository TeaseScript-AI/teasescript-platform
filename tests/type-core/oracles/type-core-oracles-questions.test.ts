import assert from "node:assert/strict";
import test from "node:test";

import { analyseCore, type Answers } from "../../../src/type-inference/core/answers.js";
import { withTestAllowance } from "../../../src/type-inference/core/budget.js";
import { CoreProgram } from "../../../src/type-inference/core/program.js";
import { coreRequest } from "../../helpers/type-core-analysis.js";
import {
  everyAnswer,
  ingressAnswers,
  inMode,
  MODES,
  occurrences,
  publication,
  publicationHashes,
  publicationParts,
  publishedAnswers,
  publishedRoute,
  publishedUpToOrder,
  QUESTION_BYTES_PER_CELL,
  QUESTION_UNITS_PER_CELL,
  questionRoomOf,
  questionWork,
  withQuestionBound,
  withQuestionMemory,
} from "../../helpers/type-core-oracles.js";
import {
  GLOBALS,
  main,
  sha256,
  SMALL,
  cellsOf,
} from "../../helpers/type-core/type-core-oracles-setup.js";

/*
 * Controls of the oracle library (`tests/helpers/type-core-oracles.ts`), which later reviews and the generator corpus
 * trust: the stop-set comparison reports what a stop changes (PR #1427's Astra review), and a publication is published
 * whatever its size or depth, or its questions' cost (#1503).
 */

test("each projection's questions past a finished analysis's allowance stop there, never escaping (#1503)", () => {
  const files = main(SMALL[0]!);
  const request = coreRequest(files, GLOBALS);
  assert.ok(request !== null);
  const bindings = new CoreProgram(request).places
    .filter(({ kind }) => kind.kind === "binding")
    .map((place) => place.id);
  const projections: Record<string, (answers: Answers) => string | null> = {
    publishedUpToOrder: (answers) => publishedUpToOrder(answers, bindings),
    everyAnswer,
    ingressAnswers,
    publication: () => publication(files, MODES[0]!, GLOBALS),
  };
  const total = analyseCore(request).budget.total;
  for (const [name, project] of Object.entries(projections)) {
    const whole = project(analyseCore(request));
    let stopped = 0;
    // (just above the analysis's own total it finishes, and each projection's questions after it cross the allowance)
    for (const above of [40, 100, 160])
      withTestAllowance(total + above, () => {
        const answers = analyseCore(request);
        assert.equal(answers.budget.exhausted, null, `the analysis finishes at ${total + above}`);
        if (project(answers) !== whole) stopped += 1;
      });
    assert.ok(stopped > 0, `${name}: some allowance stops its questions`);
  }
});

/** `files`' bindings (`publishedAnswers`' places). */
const bindingsOf = (request: NonNullable<ReturnType<typeof coreRequest>>) =>
  new CoreProgram(request).places
    .filter(({ kind }) => kind.kind === "binding")
    .map((place) => place.id);

test("the oracle's own questions stop past their bound, leaving the occurrences from there on unanswered, apart from the parts (#1499, #1837)", () => {
  const files = main(SMALL[0]!);
  const request = coreRequest(files, GLOBALS);
  assert.ok(request !== null);
  const full = publicationParts(files, MODES[0]!, GLOBALS);
  assert.ok(full !== null && full.unanswered === 0);
  // (what its questions spent apart, and the cells they returned: two a binding and each occurrence's)
  const { units, cells } = questionWork();
  const answered = analyseCore(request);
  assert.equal(answered.budget.exhausted, null);
  const asked = inMode(MODES[0]!, () => occurrences(analyseCore(request), (items) => items));
  assert.equal(
    cells,
    2 * bindingsOf(request).length + asked.map(cellsOf).reduce((a, b) => a + b, 0),
  );
  assert.ok(units > 0);
  // (with no units per cell, the least allowance that answers it all is exactly what they spent)
  const at = (allowance: number) =>
    withQuestionBound(allowance, 0, () => publicationParts(files, MODES[0]!, GLOBALS)!);
  assert.deepEqual(at(units), full);
  const stopped = at(units - 1);
  assert.deepEqual(
    [stopped.answers, stopped.record, stopped.route],
    [full.answers, full.record, full.route],
  );
  assert.ok(stopped.unanswered > 0, "the occurrences' questions stop");
  assert.deepEqual(stopped.occurrences, full.occurrences.slice(0, stopped.occurrences.length));
  assert.ok(stopped.occurrences.length < full.occurrences.length, "an occurrence stays unanswered");
  // (why: the analysis finished, so its questions passed their bound, from the first node left)
  const nodes = analyseCore(request).graph.nodes;
  const first = nodes[nodes.length - stopped.unanswered]!.id;
  assert.deepEqual(stopped.unansweredBy, { reason: "questions", node: first });
  assert.equal(full.unansweredBy, undefined);
  // (the count and why stay apart from the hashes, and the joined text never equals one answered in full)
  withQuestionBound(units - 1, 0, () => {
    assert.deepEqual(publicationHashes(files, MODES[0]!, GLOBALS), {
      parts: [stopped.answers, stopped.record, ...stopped.occurrences, stopped.route].map(sha256),
      unanswered: stopped.unanswered,
      unansweredBy: { reason: "questions", node: first },
    });
    assert.equal(
      publication(files, MODES[0]!, GLOBALS),
      `[${stopped.answers},${stopped.record},[${stopped.occurrences.join(",")}],${stopped.route},{"unanswered":${stopped.unanswered}}]`,
    );
  });
  // (at the natural bound, the program's allowance and 64 a cell, it is answered whole)
  assert.ok(units <= answered.budget.allowance + QUESTION_UNITS_PER_CELL * cells);
});

test("the published answers' own questions stop under the same bound, never answered again on a stopped analysis: every node is left after the bindings left (#1837)", () => {
  const files = main(SMALL[0]!);
  const request = coreRequest(files, GLOBALS);
  assert.ok(request !== null);
  const bindings = bindingsOf(request);
  const full = publicationParts(files, MODES[0]!, GLOBALS);
  assert.ok(full !== null);
  // (the admitted types' questions alone, on their own meter)
  inMode(MODES[0]!, () => publishedAnswers(analyseCore(request), bindings, request));
  const { units, cells } = questionWork();
  assert.ok(units > 0);
  assert.equal(cells, 2 * bindings.length);
  withQuestionBound(units - 1, 0, () => {
    assert.throws(
      () => inMode(MODES[0]!, () => publishedAnswers(analyseCore(request), bindings, request)),
      { name: "AnswersStopped" },
    );
    const stopped = publicationParts(files, MODES[0]!, GLOBALS)!;
    const nodes = analyseCore(request).graph.nodes.length;
    assert.deepEqual(
      [stopped.answers, stopped.record, stopped.occurrences, stopped.route],
      ["null", "null", [], full.route],
    );
    assert.ok(stopped.unanswered > nodes, "a binding and every node are left");
    const by = stopped.unansweredBy;
    assert.ok(by !== undefined && "binding" in by && by.reason === "questions");
    assert.equal(bindings[bindings.length - (stopped.unanswered - nodes)], by.binding);
  });
});

test("the bound credits each cell returned: one unit a cell answers what no credit stops, and at K a cell the least allowance answering all lies K or more below what the questions spent (#1837, Codex r1)", () => {
  const properties = Array.from({ length: 64 }, (_, index) => `p${index}: ${index}`).join(", ");
  for (const source of [SMALL[0]!, `let o = {${properties}}\nsay "\${o.p0}"\nexit\n`]) {
    const files = main(source);
    const full = publicationParts(files, MODES[0]!, GLOBALS);
    assert.ok(full !== null && full.unanswered === 0);
    const { units, cells } = questionWork();
    const at = (allowance: number, perCell: number) =>
      withQuestionBound(allowance, perCell, () => publicationParts(files, MODES[0]!, GLOBALS)!);
    // (from the first binding's two cells on, one unit a cell lifts the bound past what they spent)
    assert.ok(at(units - 1, 0).unanswered > 0);
    assert.deepEqual(at(units - 1, 1), full);
    // (at K a cell, the least allowance that answers it all, by bisection, and one unit less stops)
    const answered = (allowance: number) => at(allowance, QUESTION_UNITS_PER_CELL).unanswered === 0;
    let [low, high] = [-QUESTION_UNITS_PER_CELL * cells - 1, units];
    assert.ok(!answered(low) && answered(high));
    while (high - low > 1) {
      const middle = Math.floor((low + high) / 2);
      if (answered(middle)) high = middle;
      else low = middle;
    }
    assert.deepEqual(at(high, QUESTION_UNITS_PER_CELL), full);
    const stopped = at(high - 1, QUESTION_UNITS_PER_CELL);
    assert.equal(stopped.unansweredBy?.reason, "questions");
    // (the credit counts: K a cell answers below what the questions spent by at least K)
    assert.ok(high <= units - QUESTION_UNITS_PER_CELL, `${high} against ${units}`);
  }
});

test("a stop the oracle's own questions would make is never published: at the least allowance the compiler's route finishes in, the record is the compiler's (#1837, Codex r1)", () => {
  // (main asked the admitted types on the analysis's ledger before its checks: there they passed that allowance, and the
  // publication was asked again on the stopped analysis, with a stop warning the compiler does not give)
  const files = main("let count = 1\nexit\n");
  const request = coreRequest(files, GLOBALS);
  assert.ok(request !== null);
  const full = publicationParts(files, MODES[0]!, GLOBALS);
  assert.ok(full !== null);
  // (the route stops where its plan or diagnostics differ from the natural allowance's)
  const natural = publishedRoute(files, GLOBALS).text;
  const stops = (allowance: number) =>
    withTestAllowance(allowance, () => publishedRoute(files, GLOBALS).text) !== natural;
  let [low, high] = [1, analyseCore(request).budget.total];
  assert.ok(stops(low));
  while (stops(high)) {
    [low, high] = [high, 2 * high];
    assert.ok(high < 2 ** 40, "some allowance finishes the route");
  }
  while (high - low > 1) {
    const middle = Math.floor((low + high) / 2);
    if (stops(middle)) low = middle;
    else high = middle;
  }
  const parts = withTestAllowance(high, () => publicationParts(files, MODES[0]!, GLOBALS));
  assert.ok(parts !== null);
  assert.deepEqual(
    [parts.answers, parts.record, parts.route, parts.unanswered],
    [full.answers, full.record, full.route, 0],
  );
});

test("the oracle's questions stop as memory where their bytes a cell pass their room in the heap, before V8 runs out of it (#1837)", () => {
  const files = main(SMALL[0]!);
  const full = publicationParts(files, MODES[0]!, GLOBALS);
  assert.ok(full !== null && full.unanswered === 0);
  const { cells } = questionWork();
  const at = (room: number) =>
    withQuestionMemory(room, () => publicationParts(files, MODES[0]!, GLOBALS)!);
  // (room for every cell answers it whole; a byte less stops at the question that returned the last cell)
  assert.deepEqual(at(QUESTION_BYTES_PER_CELL * cells), full);
  const stopped = at(QUESTION_BYTES_PER_CELL * cells - 1);
  assert.ok(stopped.unanswered > 0);
  assert.equal(stopped.unansweredBy?.reason, "memory");
  assert.deepEqual(stopped.occurrences, full.occurrences.slice(0, stopped.occurrences.length));
  // (no room even for the first binding's cells: the answers' own questions stop, at that binding)
  const none = at(0);
  assert.deepEqual([none.answers, none.unansweredBy?.reason], ["null", "memory"]);
});

/**
 * A heap as the questions' room reads it (`questionRoomOf`), in MiB: its limit, the heap in use when the meter is made,
 * and the live heap after each collection (the last repeated), with the collections counted.
 */
function heapOf(limit: number, used: number, afterEach: readonly number[] | null) {
  const MiB = 2 ** 20;
  let collections = 0;
  const heap = {
    statistics: () => ({
      heap_size_limit: limit * MiB,
      used_heap_size:
        (collections === 0 ? used : afterEach![Math.min(collections, afterEach!.length) - 1]!) *
        MiB,
    }),
    collect: afterEach === null ? null : () => (collections += 1),
  };
  return { room: () => questionRoomOf(heap) / MiB, collections: () => collections };
}

test("the questions' room leaves out what a run just before left for V8 to keep through two collections, and keeps out what is still live (#2002)", () => {
  // (the witness: W45-conditional at k = 1,024 and 6,144 MB, a young process; V8's limit 6,240 MiB, the room's
  // default 4,704)
  // the head's meter, right after the base's run: 3,055 MiB in use, the base's analysis held through two collections
  // (2,796 MiB live after one), gone after the third: the default room, as on a fresh tree
  const young = heapOf(6240, 3055, [2796, 2796, 50]);
  assert.equal(young.room(), 4704);
  assert.equal(young.collections(), 3);
  // a reused process's meter: the heap in use under the reserve, no collection made, the default room
  const reused = heapOf(6240, 1414, [50]);
  assert.equal(reused.room(), 4704);
  assert.equal(reused.collections(), 0);
  // live state carried beside the publication: still live after the collections, so the room is what is left beside
  // it less the headroom
  const carried = heapOf(6240, 3055, [2800]);
  assert.equal(carried.room(), 6240 - 2800 - 512);
  // a process that cannot collect (no `--expose-gc`): the default room
  assert.equal(heapOf(6240, 3055, null).room(), 4704);
});

test("an analysis its own budget stopped is answered whole within its questions' bound, so no node is left unanswered and none is stopped (#1837)", () => {
  const files = main(SMALL[0]!);
  const request = coreRequest(files, GLOBALS);
  assert.ok(request !== null);
  const total = analyseCore(request).budget.total;
  // (an allowance the analysis itself passes: its own budget stops it; the oracle then answers its stopped answers
  // without asking again, within its questions' bound)
  const allowance = Math.floor(total / 2);
  assert.notEqual(
    withTestAllowance(allowance, () => analyseCore(request).budget.exhausted),
    null,
  );
  const parts = withTestAllowance(allowance, () => publicationParts(files, MODES[0]!, GLOBALS));
  assert.ok(parts !== null);
  assert.deepEqual([parts.unanswered, parts.unansweredBy], [0, undefined]);
});

test("an analysis that finished past the nesting limit leaves its later questions' nodes unanswered as questions, never stopped (#1837, Codex r1 on #1839)", () => {
  // (a finished analysis with `exhausted: "nesting"` and no stop phase: the oracle's own questions after it stop)
  const source = `let item = {a: 1, b: "x"}\nlet alias = item\nsay "\${alias.a}"\n${"if hostValue == 1 {\n".repeat(257)}say "\${hostValue}"\n${"}\n".repeat(257)}exit\n`;
  const files = [{ path: "main.tease", source }];
  const request = coreRequest(files, GLOBALS);
  assert.ok(request !== null);
  const analysis = analyseCore(request);
  assert.deepEqual([analysis.budget.exhausted, analysis.budget.stoppedIn], ["nesting", null]);
  const full = publicationParts(files, MODES[0]!, GLOBALS);
  assert.ok(full !== null && full.unanswered === 0);
  const { units } = questionWork();
  const parts = withQuestionBound(units - 1, 0, () => publicationParts(files, MODES[0]!, GLOBALS));
  assert.ok(parts !== null && parts.unanswered > 0);
  assert.equal(parts.unansweredBy?.reason, "questions");
});
