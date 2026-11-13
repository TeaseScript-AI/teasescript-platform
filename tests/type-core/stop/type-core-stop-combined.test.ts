// A combined stop (a program stop under a demand allowance) against the demand-only run: what its rule owes and takes.

import assert from "node:assert/strict";
import test from "node:test";
import { isDeepStrictEqual } from "node:util";
import { type SerializableRuntimeValue } from "../../../src/runtime/values/serializable-values.js";
import { analyseCore, type Answers } from "../../../src/type-inference/core/answers.js";
import { withTestAllowance } from "../../../src/type-inference/core/budget.js";
import { Consumers } from "../../../src/type-inference/core/consumers.js";
import { propertyStep } from "../../../src/type-inference/core/program.js";
import { STOPPED } from "../../../src/type-inference/core/items.js";
import { coreRequest, type SourceFile } from "../../helpers/type-core-analysis.js";
import {
  combinedAnalyses,
  combinedMarkProblems,
  combinedStop,
  combinedStopRule,
  withReadsChanged,
  heldDemands,
  heldFamily,
  heldProblems,
  heldRun,
  heldStops,
  heldUnstopped,
  HELD_MODES,
  runProblems,
  phaseEnds,
  testedAllowances,
  testedStops,
  searchedStops,
  type CombinedStop,
  type HeldCase,
  widerThan,
} from "../../helpers/type-core-held-host.js";

/** A held case `let r = <receiver>.get(4, default: hostOther)`, its runs `hostValue` 2 and `hostOther` each of `values`. */
function storedGet(
  name: string,
  setup: readonly string[],
  receiver: string,
  values: readonly [SerializableRuntimeValue, boolean][],
): HeldCase {
  return {
    name,
    source: [
      ...setup,
      'say "BEFORE"',
      `let r = ${receiver}.get(4, default: hostOther)`,
      'say "AFTER"',
      "exit",
      "",
    ].join("\n"),
    slice: true,
    values: values.map(([value, fits]) => ({
      globals: { hostValue: 2, hostOther: value },
      says: fits ? ["BEFORE", "AFTER"] : null,
    })),
  };
}

/** A held case from #1487's kit: `lines`, then `use` between `BEFORE` and `AFTER`, its runs `hostValue` each of these. */
function keptCase(
  name: string,
  lines: readonly string[],
  use: string,
  says: (value: SerializableRuntimeValue) => readonly string[] | null,
  slice = true,
): HeldCase {
  return {
    name,
    source: [...lines, 'say "BEFORE"', use, 'say "AFTER"', "exit", ""].join("\n"),
    slice,
    values: [2, 0, 2.5, -1, "bad", true, null].map((value) => ({
      globals: { hostValue: value, hostOther: 3 },
      says: says(value),
    })),
  };
}

/** `repeat <count> {say "ok"}`'s lines for a count, or `null` where the count is no whole number of zero or more. */
const repeated = (count: SerializableRuntimeValue): readonly string[] | null =>
  typeof count === "number" && Number.isInteger(count) && count >= 0
    ? ["BEFORE", ...Array<string>(count).fill("ok"), "AFTER"]
    : null;

/**
 * Every eighth settled stop of each phase and its last, under a demand allowance that stops a decision (the `which`th
 * largest, or `demand`), in a mode: the case's problems there (`heldProblems` under the combined stop's rule) and the
 * clauses the rule accepted.
 */
function combinedStops(
  c: HeldCase,
  mode: (typeof HELD_MODES)[number],
  each: (where: string, problems: readonly string[], clauses: readonly string[]) => void,
  which = 0,
  demand = heldDemands(c, mode)[which],
): void {
  assert.ok(demand !== undefined, `${c.name}, ${mode.name}: no decision stops`);
  const { run: unstopped } = heldUnstopped(c, mode, demand);
  const { stoppedAt } = combinedAnalyses([{ path: "main.tease", source: c.source }], mode, demand);
  for (const { allowance, phase } of searchedStops(heldStops(c, mode, 8, demand))) {
    const stopped = stoppedAt(allowance);
    each(
      `${c.name}, ${mode.name}, demand ${demand}, ${phase} @${allowance}`,
      heldProblems(c, mode, allowance, unstopped, demand),
      [...combinedStopRule(c, mode, unstopped, stopped).checks.values()],
    );
  }
}

/**
 * #1560, #1561 (S8's mark-ownership rule at a combined stop): under a demand allowance that stops a
 * decision, a read the demand stop leaves `unknown` owes a conservative check, but after a settled program stop the
 * finishing walk answers that read itself, by structure or a domain, and owes what the natural analysis owes there: no
 * check at `1` in `x otherwise 1` where the left is a literal's projection, the natural family's at a `get`'s default,
 * none on a written `list` receiver, none at an interpolation whose operand is a number. The issues' four witnesses
 * at every eighth settled stop in four modes: nothing changed that the demand-only run's marks or the rule's first clause
 * do not stand for, which some stop takes.
 */
test("a combined stop owes what the natural analysis owes where its finishing walk answers a read (#1560, #1561)", () => {
  const held = heldFamily(false);
  const cases = [
    held.find((c) => c.name === "literalProperty-1-fallback-plain")!,
    held.find((c) => c.name === "getRead-1-fallback-plain")!,
    keptCase(
      "written list receiver",
      ["let xs: list = [hostValue, 4]"],
      'repeat (xs[0] otherwise 2) {say "ok"}',
      (value) => repeated(value ?? 2),
    ),
    keptCase(
      "interpolated get",
      ["let items = [1]"],
      'repeat 2 {say "x"}\nsay "${items.get(4, default: items.get(4, default: hostValue)) * 2}"',
      () => null,
      false,
    ),
  ];
  let first = 0;
  for (const c of cases)
    for (const mode of HELD_MODES)
      combinedStops(c, mode, (where, problems, clauses) => {
        assert.deepEqual(problems, [], where);
        first += clauses.filter((clause) => clause === "a").length;
      });
  assert.ok(first > 0);
});

/**
 * #1560: the finishing read's host frontier reaches through a copy whose decision stopped, as the
 * demand-only run's read does, so the host data `root` holds keeps its boundary (`copy-type root against object` at
 * `hostValue`) through two copies, the first stopped whole. In four modes at every eighth settled stop under each demand
 * allowance that stops a decision.
 */
test("a combined stop's finishing read reaches through a copy whose decision stopped (#1560)", () => {
  const c = heldFamily(false).find((each) => each.name === "copies-2-interpolation-plain")!;
  for (const mode of HELD_MODES)
    for (const which of heldDemands(c, mode).keys())
      combinedStops(c, mode, (where, problems) => assert.deepEqual(problems, [], where), which);
});

/**
 * Other clauses at a combined stop, including (w): marks at a check's target and site whose
 * checks together let through exactly the kinds the reference's check does are that check in other words, whatever the
 * finishing read answered from (a written `list?` receiver's null check, an `integer?` element's count by a null check,
 * an `object`'s property read; two places copying each other, answered without a written type; a set's empty check,
 * its domain non-emptiness whatever family it names); (a) from the finishing walk's own reads (a fallback's left in
 * requirement mode) and at a member's presence check by its receiver's read at its unlisted property (a ring's), every
 * open read of the check's unit answered; and a boundary against
 * `unknown`, which has no plan content, dropped where the undecided store mark stands at the site of the store holding it
 * (a dictionary's value read through its `values`, forward, also parenthesized or in a parenthesized literal). Each case at every eighth settled stop under the largest
 * demand allowance that stops a decision (the copying places under each), in the modes where the clause arises, nothing
 * left over and the clause taken.
 */
test("a combined stop owes the reference's check in other words, or a boundary's undecided store mark (#1561)", () => {
  const cases = [
    {
      clause: "w",
      modes: [HELD_MODES[0]!, HELD_MODES[3]!],
      c: keptCase(
        "nullable list",
        ["let xs: list? = [hostValue, 4]"],
        'repeat xs[0] {say "ok"}',
        repeated,
      ),
    },
    {
      clause: "w",
      modes: [HELD_MODES[0]!, HELD_MODES[3]!],
      c: keptCase(
        "nullable integer elements",
        ["let xs: integer?[] = [hostValue, 4]"],
        'repeat xs[0] {say "ok"}',
        repeated,
      ),
    },
    {
      clause: "w",
      modes: [HELD_MODES[0]!, HELD_MODES[3]!],
      c: keptCase(
        "written object",
        ["let xs: object = {f: hostValue}"],
        'repeat xs.f {say "ok"}',
        repeated,
      ),
    },
    {
      clause: "w",
      modes: [HELD_MODES[0]!, HELD_MODES[1]!],
      c: heldFamily(false).find((c) => c.name === "twoWay-1-arithmetic-laterStore")!,
      each: true,
    },
    // ((w) on an empty check: the set's non-emptiness, whatever family the demand-only check named, `list` for a set; its
    // member's kind check the coarse (a) reading's counted class, the selection's element read left open in its unit)
    {
      clause: "w",
      modes: [HELD_MODES[0]!],
      c: keptCase(
        "written set",
        ["let xs: set = set[hostValue, 4]"],
        'repeat xs.first {say "ok"}',
        repeated,
        false,
      ),
      coarse: "element",
    },
    // ((a) from the finishing walk's own read: a fallback's left in requirement mode, which the stores' syntax decides
    // where the open written element alone would not, forward under demand 11)
    {
      clause: "a",
      modes: [HELD_MODES[0]!],
      c: heldFamily(false).find((c) => c.name === "writtenList-2-fallback-plain")!,
      each: true,
    },
    // ((a) at a member's presence check by every read its consumer makes: the receiver at the unlisted step `#`, which
    // the stop left `unknown` and the finishing walk answers from the ring's literals, reversed under demand 45: two
    // units below its decision's 47 (43 since #1221 charges the event searches by comparison, 4 more since #1073 PR 2's
    // consumers look up a descendant demand's narrowing), the stop at 46 past that read)
    {
      clause: "a",
      modes: [HELD_MODES[1]!],
      c: heldFamily(false).find((c) => c.name === "ring-1-written-plain")!,
      demand: 45,
    },
    ...[
      "function build {return dict {a: hostValue, b: 4}}",
      // (a parenthesized value and a parenthesized literal, which the lowering does not materialize: Codex r2's B3)
      "function build {return dict {a: (hostValue), b: 4}}",
      "function build {return (dict {a: hostValue, b: 4})}",
    ].map((line) => ({
      clause: "z",
      modes: [HELD_MODES[0]!],
      c: keptCase(
        `dictionary values of a result: ${line}`,
        [line],
        'repeat build().values[0] {say "ok"}',
        repeated,
        false,
      ),
    })),
  ];
  for (const { clause, modes, c, each = false, coarse, demand } of cases)
    for (const mode of modes) {
      let taken = 0;
      let counted = 0;
      // (under the largest demand allowance that stops a decision; the copying places under each)
      for (const which of each ? heldDemands(c, mode).keys() : [0])
        combinedStops(
          c,
          mode,
          (where, problems, clauses) => {
            const { entries, others } = coarseClass(problems);
            assert.deepEqual(others, [], where);
            // (a case's counted entries only where it names them, each read left open at the step it names)
            assert.ok(coarse !== undefined || entries.length === 0, where);
            assert.ok(
              entries.every((open) => open.every((key) => key.endsWith(`|${coarse}`))),
              where,
            );
            counted += entries.length;
            taken += clauses.filter((each) => each === clause).length;
          },
          which,
          demand,
        );
      assert.ok(taken > 0, `${c.name}, ${mode.name}: no stop takes ${clause}`);
      assert.ok(coarse === undefined || counted > 0, `${c.name}, ${mode.name}: none counted`);
    }
});

/**
 * A stop's problems split into the coarse (a) reading's counted class
 * (docs/specifications/type-inference-accepted-record/oracles.md#r4-299) and the others: each counted check's open
 * reads' keys (its record beside it).
 */
function coarseClass(problems: readonly string[]): {
  readonly entries: readonly (readonly string[])[];
  readonly others: readonly string[];
} {
  const entries = problems
    .filter((problem) => problem.startsWith("exception coarse(a) rejection check "))
    .map((problem) => problem.slice(problem.lastIndexOf(" open ") + 6).split(" "));
  const others = problems.filter(
    (problem) => !problem.startsWith("exception coarse(a) rejection "),
  );
  return { entries, others };
}

/**
 * #1604: at a combined stop the finishing read answers no kind that neither a finished contract nor a store gives, and a
 * receiver keeps the structure its key's literal stores give through a copy of an inferred place, so the stop owes the
 * demand-only run's checks, at most one for one in other words with their domain (`combinedMarkProblems`): two places
 * copying each other (the issue's witness 1, whose retained decision admitted a `null` no store gives) and a member
 * below a stopped decision, read through a wrapper of a copied object (witness 2's receiver, by a repeat count). The
 * issue's witness 2 itself keeps the demand-only run's checks; what remains there is the interpolation's operand check
 * on the operation's result, owed beyond the reference's (not this mechanism). Every eighth settled stop under each
 * demand allowance that stops a decision, four modes; the held oracle finds nothing.
 */
test("a combined stop owes the demand-only run's checks through a copied place and a wrapped receiver (#1604)", () => {
  const held = heldFamily(false);
  for (const name of [
    "twoWay-1-arithmetic-plain",
    "wrappers-1-repeat-plain",
    "wrappers-1-laterOperation-plain",
  ]) {
    const c = held.find((each) => each.name === name)!;
    for (const mode of HELD_MODES) {
      const demands = heldDemands(c, mode);
      for (const which of demands.keys()) {
        const { natural, reference, stoppedAt } = combinedAnalyses(
          [{ path: "main.tease", source: c.source }],
          mode,
          demands[which]!,
        );
        combinedStops(
          c,
          mode,
          (where, problems) => {
            assert.deepEqual(problems, [], where);
            const allowance = Number(where.slice(where.lastIndexOf("@") + 1));
            const marks = combinedMarkProblems(reference, natural, stoppedAt(allowance));
            assert.deepEqual(
              name === "wrappers-1-laterOperation-plain"
                ? marks.filter(
                    (mark) => !mark.startsWith('beyond {"kind":"operand","target":"w1.q.f * 2"'),
                  )
                : marks,
              [],
              where,
            );
          },
          which,
        );
      }
    }
  }
});

/**
 * #1604's copy of an inferred place by syntax reads its source's stores below the source's root too, one step down a
 * link (`root.f = {h: 2}` replacing `{g: 1}` in the copied `root`), so a copy's read there keeps the natural analysis's
 * check that `w1.q.f` has `.g`, which the replacement lacks (`widerThan`: no place lets through more, words apart). At
 * every settled stop of the program alone, four modes: the loss shows in a band of stops a sample (`testedStops`) misses,
 * and the whole list takes about 3 s.
 */
test("a copy of an inferred place reads its source's stores below the source's root (#1604)", () => {
  const source = [
    "let root = {f: {g: 1}}",
    "root.f = {h: 2}",
    "let w1 = {q: root, spare: {k: 1}}",
    'say "BEFORE"',
    'repeat w1.q.f.g {say "ok"}',
    'say "AFTER"',
    "exit",
    "",
  ].join("\n");
  const c: HeldCase = {
    name: "wrapper of a place stored below its root",
    source,
    slice: true,
    values: [],
  };
  const request = coreRequest([{ path: "main.tease", source }], ["hostValue", "hostOther"])!;
  for (const mode of HELD_MODES) {
    const natural = mode.run(() => analyseCore(request));
    for (const { allowance } of heldStops(c, mode))
      assert.deepEqual(
        widerThan(
          natural.checks,
          mode.run(() => withTestAllowance(allowance, () => analyseCore(request))),
        ),
        [],
        `${mode.name} @${allowance}`,
      );
  }
});

/**
 * #1604's retained `null` follows the contract at a binding's root only: below it a decision admitting `null` keeps it,
 * since a read there may find no such member (`w1.q = {h: 2}` replaces the object holding `g`), which the conservative
 * null's check stands for. No place lets through more than the natural run at `w1.q.g` (`widerThan`), at the sampled
 * settled stops of the program alone (`testedStops`), four modes. The receiver `w1.q` itself is #1654's (a presence check `main` drops there).
 */
test("a retained member below its root keeps admission's null (#1604)", () => {
  const source = [
    "let root = {g: 1}",
    "let w1 = {q: root, spare: {k: 1}}",
    "w1.q = {h: 2}",
    'say "BEFORE"',
    'repeat w1.q.g {say "ok"}',
    'say "AFTER"',
    "exit",
    "",
  ].join("\n");
  const c: HeldCase = { name: "a member replaced below the root", source, slice: true, values: [] };
  const request = coreRequest([{ path: "main.tease", source }], ["hostValue", "hostOther"])!;
  for (const mode of HELD_MODES) {
    const natural = mode.run(() => analyseCore(request));
    for (const { allowance } of testedStops(heldStops(c, mode)))
      assert.deepEqual(
        widerThan(
          natural.checks,
          mode.run(() => withTestAllowance(allowance, () => analyseCore(request))),
        ).filter((place) => !place.includes('\\"w1.q\\",')),
        [],
        `${mode.name} @${allowance}`,
      );
  }
});

/**
 * #1604's syntax through copies of inferred places answers each key alike whatever order its reads ask it (Codex r1's N1
 * and N2, r3's B4 on #1653): a key a cycle of copies reaches is untold from wherever it is asked (two places copying each
 * other, each wrapped; joined cycles through a projected copy), and a level cut past the copy bound from a deeper caller
 * is kept only where its chain started (a chain of eight copies of a literal, wrapped once). Every binding's own key and
 * its `q`, `f` and `q.f` paths asked in their order and reversed, on fresh walks of the analysis's settled pass, four
 * modes: the same decisions.
 */
test("the stores' syntax through copies answers alike in either order of reads (#1604)", () => {
  const sources = [
    ["let a = {f: 1}", "let b = a", "a = b", "let w = {q: a}", "let v = {q: b}"],
    [
      "let a0 = {f: 1}",
      ...Array.from({ length: 8 }, (_, i) => `let a${i + 1} = a${i}`),
      "let w = {q: a8}",
    ],
    [
      "let a = {f: 1}",
      "let b = {q: a}",
      "let c = b.q",
      "let d = {q: c}",
      "d = b",
      "b = d",
      "a = c",
      "let w = {q: d.q}",
    ],
  ].map((lines) => [...lines, 'say "${w.q.f}"', "exit", ""].join("\n"));
  for (const source of sources)
    for (const mode of HELD_MODES) {
      let captured: Consumers | undefined;
      const check = Consumers.prototype.check;
      Consumers.prototype.check = function (this: Consumers) {
        captured = this;
        return check.call(this);
      };
      try {
        mode.run(() =>
          analyseCore(coreRequest([{ path: "main.tease", source }], ["hostValue", "hostOther"])!),
        );
      } finally {
        Consumers.prototype.check = check;
      }
      const pass = captured!.pass;
      const asked = pass.program.places.flatMap((place) =>
        place.kind.kind === "binding" && place.kind.declared === "let"
          ? [[], ["q"], ["f"], ["q", "f"]].map((path) => ({
              root: place.id,
              path: path.map(propertyStep),
            }))
          : [],
      );
      const decisions = (order: typeof asked) => {
        const walk = new Consumers(pass);
        walk.finishing = true;
        walk.settled = true;
        const found = new Map<string, string>();
        for (const { root, path } of order) {
          const decided = walk.cheapDecided(root, path);
          found.set(
            `${root}:${path.join(".")}`,
            JSON.stringify(
              decided === null
                ? null
                : {
                    kinds: decided.kinds,
                    spelling: decided.spelling,
                    decider: decided.decider.site,
                    inherited: decided.inherited,
                  },
            ),
          );
        }
        return [...found].sort(([a], [b]) => a.localeCompare(b));
      };
      assert.deepEqual(
        decisions([...asked].reverse()),
        decisions(asked),
        `${mode.name}: ${source}`,
      );
    }
});

/**
 * the coarse (a) reading's counted class, never a pass. Where a read of the check's reference unit that the
 * demand stop left `unknown` is not answered at its key by the stopped analysis's run of that unit, (a) takes nothing
 * and the check is counted with that read's key:
 * - a member's kind check beside its own selection's element read (the clauses' written set);
 * - an operand's check beside the next operand's read in one operation (`say a and xs.first`, Codex r4's B2, forward
 *   with the sharing under demand 3);
 * - a member's presence check whose own value the finishing walk leaves to the member's contract, its quiet path
 *   skipping the receiver (`writtenObjectBelow-1-say-plain`, forward without the sharing under demand 32);
 * - a `get`'s receiver check beside its default's read of the receiver's element, with the literal index's checks of
 *   that unit (a written union's list, forward with the sharing under demand 3).
 * The finer reading, by the consumer invocation that emitted the check, has no entry to hook: the consumers are module
 * functions no test can replace, and a call stack names no call. Every settled stop of each.
 */
test("a combined stop counts the coarse (a) reading's rejections with the read each leaves open", () => {
  const below = heldFamily(false).find((c) => c.name === "writtenObjectBelow-1-say-plain")!;
  const members = [
    {
      source:
        "let a: boolean = hostValue\nlet xs: list = [hostOther, 4]\nsay a and xs.first\nexit\n",
      demand: 3,
      mode: HELD_MODES[0]!,
      target: "a",
      open: "xs.first",
    },
    { source: below.source, demand: 32, mode: HELD_MODES[2]!, target: "root", open: "root.f0" },
    // (a `get`'s receiver beside its default's read of the receiver's element)
    {
      source: storedGet("written union", ["let xs: (integer|string)[] = [4]"], "xs", []).source,
      demand: 3,
      mode: HELD_MODES[0]!,
      target: "xs",
      open: "xs",
      where: "xs.get",
      steps: "element",
    },
  ];
  for (const { source, demand, mode, target, open, where = open, steps = "" } of members) {
    const at = source.indexOf(where);
    assert.ok(
      controlStops(
        mainFile(source),
        (rule) =>
          [...rule.coarse.checks.keys()].find((check) => JSON.parse(check).target === target),
        (reference, natural, stopped, check) => {
          const rule = combinedStop(reference, natural, stopped);
          assert.equal(rule.checks.get(check), undefined, open);
          assert.deepEqual(
            rule.coarse.checks.get(check),
            [`0:${at}:${at + open.length}|${steps}`],
            open,
          );
        },
        [demand],
        mode,
        1,
      ) > 0,
      open,
    );
  }
});

/** `answers` with `fields` in place of its own, its questions its own (a stopped analysis changed for an oracle's control). */
function shadowed(answers: Answers, fields: Partial<Answers>): Answers {
  return Object.assign(
    Object.create(answers),
    {
      graph: answers.graph,
      at: answers.at.bind(answers),
      place: answers.place.bind(answers),
      project: answers.project.bind(answers),
    },
    fields,
  );
}

/** A mark of `answers` changed by `by` (or left out), its published obligation with it, its diagnostic too. */
function withMark(
  answers: Answers,
  obligation: string,
  by:
    | ((mark: (typeof answers.budget.deferred)[number]) => (typeof answers.budget.deferred)[number])
    | null,
): Answers {
  const is = (check: Answers["checks"][number]): boolean => JSON.stringify(check) === obligation;
  const mark = answers.budget.deferred.find((each) => is(each.obligation));
  assert.ok(mark !== undefined, obligation);
  const changed = by === null ? null : by(mark);
  return shadowed(answers, {
    checks: answers.checks.flatMap((check) =>
      !is(check) ? [check] : changed === null ? [] : [changed.obligation],
    ),
    budget: {
      ...answers.budget,
      deferred: answers.budget.deferred.flatMap((each) =>
        each !== mark ? [each] : changed === null ? [] : [changed],
      ),
    },
  });
}

/**
 * Each settled stop of a program's files under each demand allowance that stops a decision of its main file (or under
 * `demands`), in `mode` (forward with the sharing), at every `step`th (eighth) allowance of each settled phase: where `select` names a reference
 * check there, `each` judges it. The number of stops judged.
 */
function controlStops(
  files: readonly SourceFile[],
  select: (rule: CombinedStop, reference: Answers, stopped: Answers) => string | undefined,
  each: (reference: Answers, natural: Answers, stopped: Answers, check: string) => void,
  demands?: readonly number[],
  mode = HELD_MODES[0]!,
  step = 8,
): number {
  let count = 0;
  for (const demand of demands ?? heldDemands({ source: files[0]!.source }, mode)) {
    const { natural, reference, stoppedAt } = combinedAnalyses(files, mode, demand);
    for (const [phase, [low, high]] of phaseEnds(reference.budget.total, (allowance) => {
      const { settled, stoppedIn } = stoppedAt(allowance).budget;
      return settled ? stoppedIn : null;
    }))
      for (const allowance of testedAllowances(phase, low, high, step)) {
        const stopped = stoppedAt(allowance);
        const check = select(combinedStop(reference, natural, stopped), reference, stopped);
        if (check === undefined) continue;
        count += 1;
        each(reference, natural, stopped, check);
      }
  }
  return count;
}

/** The reference check the rule takes by `clause` that `pick` names, or none. */
const takes =
  (clause: "a" | "w" | "z", pick: (check: Answers["checks"][number]) => boolean) =>
  (rule: CombinedStop): string | undefined =>
    [...rule.checks].find(([check, found]) => found === clause && pick(JSON.parse(check)))?.[0];

/** A program of one file. */
const mainFile = (source: string): SourceFile[] => [{ path: "main.tease", source }];

/**
 * The inventory at a combined stop: each predicate's controls on real stops, changed (Codex r1's and r2's on
 * #1597), each dimension with what it must reject and what it must accept.
 * - (a)'s reference read: a recovered contract tagged `budget` (`list|null`, never `unknown`) is no read the demand stop
 *   left `unknown`, so the receiver's mark left out is rejected; the issues' witnesses (the first test) are accepted.
 * - (a)'s finishing read: the receiver's mark left out with its read answered `STOPPED` is rejected.
 * - (a)'s reads, its unit's: an element selection's empty check and an index's integer check, their marks left out
 *   where only the receiver is answered, are rejected (Codex r3's B1).
 * - (w)'s domain: the null check against `integer` replaced by a copy check against `unknown` is rejected, and so is
 *   #1580's comparison form's boolean check with every obligation at its place removed; a redundant mark against
 *   `unknown` beside the restrictive one is accepted, the intersection unchanged.
 * - Site identity: the same mark moved to another file at the same offsets is rejected; in its own file it is taken.
 * - (z)'s holding store: the store mark moved to the whole source is rejected, and so are the holding store's obligation
 *   settled against a type and the copies' boundary with plan content left out; a parenthesized value and a
 *   parenthesized literal (the third test) are accepted.
 * And the runtime predicate: a written list's default obligation deliberately omitted from a real stopped compile lets
 * `bad` through, which it reports (forward with the sharing).
 */
test("a combined stop's rule takes nothing the natural analysis owes, nothing wider, and no boundary with plan content", () => {
  const mode = HELD_MODES[0]!;
  // (#1580's comparison form under each demand allowance that stops a decision: whatever the stopped analysis owes at the
  // comparison's place left out, its boolean check is no clause's)
  const elements = storedGet("compared element", [], "[hostValue == 2]", [
    [true, true],
    ["bad", false],
  ]);
  const samePlace = (x: Answers["checks"][number], u: Answers["checks"][number]): boolean =>
    isDeepStrictEqual(x.site, u.site) && x.target === u.target && x.boundary === u.boundary;
  assert.ok(
    controlStops(
      mainFile(elements.source),
      (_, reference, stopped) => {
        const owed = [...stopped.checks, ...stopped.budget.deferred.map((mark) => mark.obligation)];
        const check = reference.checks.find(
          (u) => isDeepStrictEqual(u.against, ["boolean"]) && owed.some((x) => samePlace(x, u)),
        );
        return check === undefined ? undefined : JSON.stringify(check);
      },
      (reference, natural, stopped, check) => {
        const u: Answers["checks"][number] = JSON.parse(check);
        const left = shadowed(stopped, {
          checks: stopped.checks.filter((x) => !samePlace(x, u)),
          budget: {
            ...stopped.budget,
            deferred: stopped.budget.deferred.filter((mark) => !samePlace(mark.obligation, u)),
          },
        });
        assert.equal(combinedStop(reference, natural, left).checks.get(check), undefined);
      },
      heldDemands(elements, mode),
    ) > 0,
  );
  const nullable =
    'let xs: list? = [hostValue, 4]\nsay "BEFORE"\nrepeat xs[0] {say "ok"}\nsay "AFTER"\nexit\n';
  const receiver = nullable.indexOf("xs[0]");
  const nullCheck = (check: Answers["checks"][number]): boolean =>
    check.kind === "null-check" && check.target === "xs";
  // (a)'s finishing read: the receiver's mark left out, its finishing read answered `STOPPED` (`unknown`, `budget`)
  assert.ok(
    controlStops(
      mainFile(nullable),
      takes("w", nullCheck),
      (reference, natural, stopped, check) => {
        const mark = stopped.budget.deferred.find((each) => nullCheck(each.obligation))!;
        const left = withMark(stopped, JSON.stringify(mark.obligation), null);
        const unanswered = withReadsChanged(
          stopped,
          left,
          { file: 0, start: receiver, end: receiver + 2 },
          [],
          (reads) => reads.map((read) => (read.finishing ? { ...read, items: STOPPED } : read)),
        );
        assert.equal(combinedStop(reference, natural, unanswered).checks.get(check), undefined);
      },
    ) > 0,
  );
  // (a)'s reference read: a recovered contract tagged `budget`, the receiver's mark left out (Codex r2's B1, at demand 5,
  // where the reference warns of the receiver's `null` alone)
  const known =
    'let pad = {q: {q: {q: {q: hostOther}}}}\nlet xs: list? = [hostValue, 4]\nrepeat xs[0] {say "ok"}\nsay pad.q.q.q.q\nexit\n';
  const knownAt = known.indexOf("xs[0]");
  assert.ok(
    controlStops(
      mainFile(known),
      (_, reference, stopped) => {
        const owner = reference.diagnostics.find(
          (d) =>
            "obligation" in d &&
            nullCheck(d.obligation) &&
            d.site.start === knownAt &&
            isDeepStrictEqual(d.kinds, ["null"]),
        );
        const text =
          owner !== undefined && "obligation" in owner ? JSON.stringify(owner.obligation) : "";
        return stopped.budget.deferred.some((mark) => JSON.stringify(mark.obligation) === text)
          ? text
          : undefined;
      },
      (reference, natural, stopped, check) =>
        assert.equal(
          combinedStop(reference, natural, withMark(stopped, check, null)).checks.get(check),
          undefined,
        ),
      // (where the receiver's read recovers its contract, `list|null` tagged `budget`: Codex r2's witness)
      [5],
    ) > 0,
  );
  // (w)'s domain: the null check against `integer` replaced by a copy check against `unknown` (Codex r1's B2); a
  // redundant mark against `unknown` beside it, the intersection unchanged
  const elementsOf =
    'let xs: integer?[] = [hostValue, 4]\nsay "BEFORE"\nrepeat xs[0] {say "ok"}\nsay "AFTER"\nexit\n';
  const count = (check: Answers["checks"][number]): boolean =>
    check.target === "xs.element" && check.kind === "integer-check";
  const elementMark = (stopped: Answers) =>
    stopped.budget.deferred.find(
      (each) => each.obligation.target === "xs.element" && each.obligation.kind === "null-check",
    )!;
  const unknownCopy = (mark: typeof elementMark extends (a: Answers) => infer M ? M : never) => ({
    ...mark,
    obligation: {
      ...mark.obligation,
      kind: "copy-type" as const,
      against: ["unknown" as const],
      on: "validate the stored value of xs.element against unknown",
    },
  });
  assert.ok(
    controlStops(mainFile(elementsOf), takes("w", count), (reference, natural, stopped, check) => {
      const mark = elementMark(stopped);
      const wider = withMark(stopped, JSON.stringify(mark.obligation), unknownCopy);
      assert.notEqual(combinedStop(reference, natural, wider).checks.get(check), "w");
      const beside = shadowed(stopped, {
        checks: [...stopped.checks, unknownCopy(mark).obligation],
        budget: { ...stopped.budget, deferred: [...stopped.budget.deferred, unknownCopy(mark)] },
      });
      assert.equal(combinedStop(reference, natural, beside).checks.get(check), "w");
    }) > 0,
  );
  // (a)'s reads, its unit's: an element selection's empty check and an index's integer check, each mark left out where
  // the receiver is answered but the read that decides the check, the element or the index, is still `unknown` in the
  // finishing walk (Codex r3's B1, at demands 3 and 2)
  for (const [source, demand, kind, target] of [
    ['let xs: list = [hostValue, 4]\nrepeat xs.first {say "ok"}\nexit\n', 3, "empty-check", "xs"],
    ["let xs: list = [hostValue, 4]\nlet i = 0\nsay xs[i]\nexit\n", 2, "integer-check", "i"],
  ] as const)
    assert.ok(
      controlStops(
        mainFile(source),
        (_, reference, stopped) => {
          const owed = reference.checks.find(
            (check) => check.kind === kind && check.target === target,
          );
          const text = owed === undefined ? "" : JSON.stringify(owed);
          return stopped.budget.deferred.some((mark) => JSON.stringify(mark.obligation) === text)
            ? text
            : undefined;
        },
        (reference, natural, stopped, check) =>
          assert.equal(
            combinedStop(reference, natural, withMark(stopped, check, null)).checks.get(check),
            undefined,
            source,
          ),
        [demand],
      ) > 0,
      source,
    );
  // site identity: the mark moved to another file at the same offsets (Codex r2's B2); taken in its own file
  const twoFiles = [
    ...mainFile(elementsOf),
    { path: "other.tease", source: elementsOf.replaceAll("xs", "ys") },
  ];
  const inMain = (check: Answers["checks"][number]): boolean =>
    count(check) && check.site.file === 0;
  assert.ok(
    controlStops(twoFiles, takes("w", inMain), (reference, natural, stopped, check) => {
      const mark = elementMark(stopped);
      const moved = withMark(stopped, JSON.stringify(mark.obligation), (each) => ({
        ...each,
        site: { ...each.site, file: 1 },
        obligation: { ...each.obligation, site: { ...each.obligation.site, file: 1 } },
      }));
      assert.equal(combinedStop(reference, natural, moved).checks.get(check), undefined);
    }) > 0,
  );
  // (z)'s holding store: the store mark moved from the holding store's site to the whole source (Codex r1's B3)
  const values =
    'function build {return dict {a: hostValue, b: 4}}\nsay "BEFORE"\nrepeat build().values[0] {say "ok"}\nsay "AFTER"\nexit\n';
  const holding = values.indexOf("dict {");
  assert.ok(
    controlStops(
      mainFile(values),
      takes("z", (check) => check.boundary),
      (reference, natural, stopped, check) => {
        const owns = (d: Answers["diagnostics"][number]): boolean =>
          "rule" in d && d.rule.rule === "store" && d.site.start === holding;
        assert.ok(stopped.diagnostics.some(owns) || stopped.budget.deferred.some(owns));
        const whole = { file: 0, start: 0, end: values.length };
        const move = <D extends Answers["diagnostics"][number]>(d: D): D =>
          !owns(d) || !("obligation" in d)
            ? d
            : { ...d, site: whole, obligation: { ...d.obligation, site: whole } };
        const moved = shadowed(stopped, {
          diagnostics: stopped.diagnostics.map(move),
          budget: { ...stopped.budget, deferred: stopped.budget.deferred.map(move) },
        });
        assert.notEqual(combinedStop(reference, natural, moved).checks.get(check), "z");
        // ((z)'s owner state: the holding store's obligation settled, against a type in place of `unknown`)
        const settle = <D extends Answers["diagnostics"][number]>(d: D): D =>
          !owns(d) || !("obligation" in d)
            ? d
            : { ...d, obligation: { ...d.obligation, against: ["integer" as const] } };
        const settled = shadowed(stopped, {
          diagnostics: stopped.diagnostics.map(settle),
          budget: { ...stopped.budget, deferred: stopped.budget.deferred.map(settle) },
        });
        assert.notEqual(combinedStop(reference, natural, settled).checks.get(check), "z");
      },
    ) > 0,
  );
  // (the runtime predicate on a real stopped plan: a written list's `get` default, its check's mark left out of the
  // compile, lets `bad` through to `AFTER`, which the predicate reports; with its check the plan rejects it; the check a
  // receiving completion gives the stopped store, #1526 phase C step 5, is left out too: it rejects `bad` as well. The
  // default is said, not stored: a store into an inferred place is left undecided before admission settled, where the
  // plain gate declines, #2080 part 2)
  const written: HeldCase = {
    name: "written list",
    source:
      'let xs: integer[] = [4]\nsay "BEFORE"\nsay xs.get(4, default: hostOther)\nsay "AFTER"\nexit\n',
    slice: true,
    values: [
      { globals: { hostValue: 2, hostOther: 2 }, says: ["BEFORE", "2", "AFTER"] },
      { globals: { hostValue: 2, hostOther: "bad" }, says: null },
    ],
  };
  const writtenDemand = heldDemands(written, mode)[0]!;
  const bad = 'forbidden {"hostValue":2,"hostOther":"bad"} said ["BEFORE","bad","AFTER"]';
  const defaultAt = written.source.indexOf("hostOther");
  let removed = 0;
  // (#2080 part 1: at its held stops, after admission settled, the completion is capped and keeps no result, and the
  // stopped marks decline; before the first, the analysis stops unsettled, where nothing is left undecided and the
  // stopped plan publishes)
  const first = heldStops(written, mode, 8, writtenDemand)[0]!.allowance;
  for (let allowance = 1; allowance < first; allowance += 104) {
    const stopped = heldRun(written, mode, allowance, writtenDemand);
    if (stopped.result.plan === null || runProblems(written, stopped).length > 0) continue;
    const owner = [...stopped.answers.diagnostics, ...stopped.answers.budget.deferred].find(
      (d) => "obligation" in d && !d.obligation.boundary && d.site.start === defaultAt,
    );
    if (owner === undefined) continue;
    const omitted = stopped.without(
      {
        diagnostic: (d) =>
          d.code === owner.code &&
          d.site.start === owner.site.start &&
          d.site.end === owner.site.end,
        check: () => false,
        completion: true,
      },
      `default ${owner.code}`,
    );
    assert.ok(runProblems(written, omitted).includes(bad), `@${allowance}`);
    removed += 1;
  }
  assert.ok(removed > 0);
  // (the copies' boundary left out of a stopped analysis that owes it: no clause takes it)
  const copies = heldFamily(false).find((c) => c.name === "copies-2-interpolation-plain")!;
  const boundary = (check: Answers["checks"][number]): boolean =>
    check.boundary && check.target === "root" && isDeepStrictEqual(check.against, ["object"]);
  let tried = 0;
  for (const copiesDemand of heldDemands(copies, mode)) {
    const { natural, reference, stoppedAt } = combinedAnalyses(
      mainFile(copies.source),
      mode,
      copiesDemand,
    );
    if (!reference.checks.some(boundary)) continue;
    for (const { allowance } of heldStops(copies, mode, 8, copiesDemand)) {
      const stopped = stoppedAt(allowance);
      const owed = stopped.checks.find(boundary);
      if (owed === undefined || !stopped.budget.decisions.some((d) => d.stopped)) continue;
      tried += 1;
      const without = shadowed(stopped, {
        checks: stopped.checks.filter((check) => !boundary(check)),
      });
      assert.equal(
        combinedStop(reference, natural, without).checks.has(JSON.stringify(owed)),
        false,
        `demand ${copiesDemand} @${allowance}`,
      );
    }
  }
  assert.ok(tried > 0);
});
