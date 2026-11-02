import assert from "node:assert/strict";
import test from "node:test";

import { analyseCore, type Answers } from "../src/type-inference/core/answers.js";
import {
  BudgetExhausted,
  DemandExhausted,
  READ_DEPTH_LIMIT,
  withTestAllowance,
} from "../src/type-inference/core/budget.js";
import { withConsumerOrder } from "../src/type-inference/core/consumers.js";
import type { Item } from "../src/type-inference/core/items.js";
import { withoutSharing } from "../src/type-inference/core/sharing.js";
import {
  inline,
  Solver,
  withNativeInline,
  withSolverSeam,
  type SolvedMember,
  type Work,
} from "../src/type-inference/core/solver.js";
import { coreRequest } from "./helpers/type-core-analysis.js";
import { itemScope } from "./helpers/type-core-items.js";
import { inMode, MODES, publication, stopSet, type Mode } from "./helpers/type-core-oracles.js";

/*
 * #1572: an operation's contract at a path is read inline (`inline`): on its frame's explicit stack, with the frame's
 * identity, never a demand or a component member, nothing charged and no allowance checked as it is pushed or popped.
 * A stop inside such a read is the stop of the same walk by `yield*` (`withNativeInline`, the walk before #1572), and a
 * self-store's cycle keeps the members and the work it had: the rejected design, a demand per operation and path, made
 * each operation of a joined self-store a member, which cost reruns quadratic in the join's terms against the
 * canonical order and a consumer read its allowance.
 */

const many = (n: number, term: (i: number) => string, separator: string): string =>
  Array.from({ length: n }, (_, i) => term(i)).join(separator);

const request = (source: string) => {
  const made = coreRequest([{ path: "main.tease", source }]);
  assert.ok(made !== null, source);
  return made;
};

/** An operation's contract at a path, as the rejected design asked it (`cop|<value>|<path>`). */
const OPERATION_AT_PATH = /^cop\|\d+\|./;

/** `analyse` in `mode` with every component solved heard (`onComponent`): its result and the members' keys. */
function withMembers(mode: Mode, analyse: () => Answers): { answers: Answers; keys: string[] } {
  const keys: string[] = [];
  const onComponent = (members: readonly SolvedMember[]): void => {
    for (const member of members) keys.push(member.key);
  };
  const seamed = (): Answers =>
    withSolverSeam({ reverseWorklist: mode.reversed, onComponent }, analyse);
  const ordered = (): Answers =>
    mode.reversed ? withConsumerOrder((list) => [...list].reverse(), seamed) : seamed();
  const answers = mode.unshared ? withoutSharing(ordered) : ordered();
  return { answers, keys };
}

/**
 * A join of 16 terms and an `otherwise` chain of 16 lists, each read below its elements, in the four modes: at twelve
 * work allowances below its natural total (the settled walk's stop, inside the chain's read at some) the publication, and
 * at eight demand allowances (the read's own stop) the stop set, each equal to the walk's by `yield*`.
 */
test("a stop inside an operation read inline is the stop of its walk by yield* in the four modes (#1572)", () => {
  const read = (terms: string): string =>
    `let o = [{q: 1}]\nlet xs = ${terms}o\nsay "\${xs[0].q}"\nexit\n`;
  const sources = [
    read(many(15, (i) => (i % 2 === 0 ? "o + " : `[{p${i}: 1}] + `), "")),
    read(many(15, (i) => `hostValue.l${i} otherwise `, "")),
  ];
  for (const source of sources) {
    const files = [{ path: "main.tease", source }];
    for (const mode of MODES) {
      const where = `${source.split("\n")[1]!.slice(0, 40)}… ${JSON.stringify(mode)}`;
      const natural = inMode(mode, () => analyseCore(request(source))).budget.total;
      let stopped = 0;
      for (let step = 1; step <= 12; step += 1) {
        const allowance = Math.ceil((natural * step) / 13);
        const published = () =>
          withTestAllowance(allowance, () => publication(files, mode, ["hostValue"]));
        assert.equal(published(), withNativeInline(published), `${where} at ${allowance}`);
        const answers = withTestAllowance(allowance, () =>
          inMode(mode, () => analyseCore(request(source))),
        );
        if (answers.budget.exhausted === "work") stopped += 1;
      }
      assert.equal(stopped, 12, `${where}: every allowance below the natural total stops`);
      for (const allowance of [8, 16, 32, 64, 128, 256, 512, 1024]) {
        const stops = () => stopSet(files, mode, ["hostValue"], allowance);
        assert.deepEqual(stops(), withNativeInline(stops), `${where} at demand ${allowance}`);
      }
    }
  }
});

/**
 * `1310-r9-join-cases`' self-stores of a join of their own list with a misfit: in the four modes each analysis publishes
 * the one error the misfit owes (TSV044) and no stop, and no operation's contract at a path is a component's member.
 */
test("a self-store joining its own list keeps its components and its one error in the four modes (#1572)", () => {
  for (const [type, start, misfit] of [
    ["integer[]", "[1]", '["bad"]'],
    ["integer?[]", "[1]", '["bad"]'],
    ["integer[][]", "[[1]]", '[["bad"]]'],
    ["integer?[][]", "[[1]]", '[["bad"]]'],
  ] as const) {
    const source = `let d: ${type} = ${start}\nd = (d + ${misfit}) + []\nsay d.length\nexit\n`;
    for (const mode of MODES) {
      const { answers, keys } = withMembers(mode, () => analyseCore(request(source)));
      const where = `${type} ${JSON.stringify(mode)}`;
      assert.equal(answers.outcome, "compile-error", where);
      assert.deepEqual(
        answers.diagnostics.map((diagnostic) => diagnostic.code),
        ["TSV044"],
        where,
      );
      assert.equal(answers.budget.exhausted, null, where);
      assert.deepEqual(
        keys.filter((key) => OPERATION_AT_PATH.test(key)),
        [],
        where,
      );
    }
  }
});

/**
 * A self-store of a join of k lists (`d = d + [0] + [1] + …`) at k = 16, 32 and 64 in the four modes: valid, no
 * operation's contract at a path a component's member, and its work, the solver's reruns and its rounds growing at most
 * 2.15 per doubling (the rejected design: reruns ×3.3 and ×3.6 in the reversed order with the sharing off).
 */
test("a self-store of a join of k lists grows with k in the four modes (#1572)", () => {
  const source = (k: number): string =>
    `let d: integer[] = [1]\nd = d + ${many(k, (i) => `[${i}]`, " + ")}\nsay d.length\nexit\n`;
  for (const mode of MODES) {
    const sizes = [16, 32, 64].map((k) => {
      const { answers, keys } = withMembers(mode, () => analyseCore(request(source(k))));
      const where = `k = ${k} ${JSON.stringify(mode)}`;
      assert.equal(answers.outcome, "valid", where);
      assert.deepEqual(
        keys.filter((key) => OPERATION_AT_PATH.test(key)),
        [],
        where,
      );
      const counts = answers.budget.counts;
      return [answers.budget.total, counts.get("sccReruns") ?? 0, counts.get("sccRounds") ?? 0];
    });
    for (let at = 1; at < sizes.length; at += 1)
      sizes[at]!.forEach((value, measure) =>
        assert.ok(
          value <= 2.15 * sizes[at - 1]![measure]!,
          `${JSON.stringify(mode)}: ${["work", "reruns", "rounds"][measure]} ${sizes[at - 1]![measure]} → ${value}`,
        ),
      );
  }
});

/**
 * Codex r1 on #1584: a stop between two steps abandons a run whose inline child is suspended, its `finally` blocks never
 * run. A parent 1,010 read levels deep on the native stack reads a child 5 levels deep inline, which yields a demand;
 * the run stops there (the work allowance in `run`, the demand allowance in `demand`). The read chain it leaves is the
 * whole run's, 1,015 levels, as `yield*` leaves it, so a computation after the stop admits `READ_DEPTH_LIMIT` − 1,015
 * reads (`enterRead`), the child read inline as read by `yield*` (`withNativeInline`).
 */
test("a stop that abandons a suspended inline child leaves the run's whole read chain (#1572)", () => {
  for (const stop of ["work", "demand"] as const)
    for (const native of [false, true]) {
      const scope = itemScope(stop === "work" ? 1 : Number.MAX_SAFE_INTEGER);
      const solver = new Solver(scope);
      function* child(): Work<readonly Item[]> {
        for (let level = 0; level < 5; level += 1) solver.enterRead();
        try {
          yield {
            key: "f",
            kind: "value",
            file: 0,
            offset: 0,
            *make() {
              return [];
            },
          };
          return [];
        } finally {
          for (let level = 0; level < 5; level += 1) solver.leaveRead();
        }
      }
      function* parent(levels: number): Work<readonly Item[]> {
        solver.enterRead();
        try {
          return levels > 1 ? yield* parent(levels - 1) : yield* inline(child());
        } finally {
          solver.leaveRead();
        }
      }
      const run = (): void => {
        if (stop === "work") solver.run(parent(1_010));
        else solver.demand(parent(1_010), 1);
      };
      assert.throws(
        () => (native ? withNativeInline(run) : run()),
        stop === "work" ? BudgetExhausted : DemandExhausted,
      );
      scope.work.stop("work");
      const admitted = solver.run(
        (function* (): Work<number> {
          let reads = 0;
          try {
            while (reads < 64 && solver.enterRead()) reads += 1;
            return reads;
          } finally {
            for (let level = 0; level < reads; level += 1) solver.leaveRead();
          }
        })(),
      );
      assert.equal(
        admitted,
        READ_DEPTH_LIMIT - 1_015,
        `${stop} stop, ${native ? "native" : "inline"}`,
      );
    }
});
