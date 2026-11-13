// Unrestricted written types: a written collection's and an object's contents owe nothing, a copied written object
// stays unrestricted below it (#1215), and a value read from an unrestricted written list owes each consumer's check
// (#1501).

import assert from "node:assert/strict";
import test from "node:test";
import { isDeepStrictEqual } from "node:util";

import { compileSourceWithBackend } from "../../../src/compiler.js";
import type { InstructionPlan } from "../../../src/plan/model.js";
import type { SerializableRuntimeValue } from "../../../src/runtime/values/serializable-values.js";
import { analyseCore } from "../../../src/type-inference/core/answers.js";
import { CandidateOutsideSlice, CORE_BACKEND } from "../../../src/type-inference/core/backend.js";
import { propertyStep } from "../../../src/type-inference/core/program.js";
import { withoutSharing } from "../../../src/type-inference/core/sharing.js";
import { plannedContent, plannedStores, runGlobals } from "../../helpers/type-core-route.js";
import { inMode, MODES } from "../../helpers/type-core-oracles.js";
import {
  OBJECT_PROPERTY_MATRIX,
  UNRESTRICTED_COLLECTION_MATRIX,
  type UnrestrictedCase,
} from "../../helpers/type-core/type-core-written.js";
import {
  inBothOrders,
  sorted,
  checksOf,
  GLOBALS,
  prepare,
  decision,
} from "../../helpers/type-core/type-core-written-setup.js";

/**
 * The sources of `cases` where an unrestricted part's contents owe anything (a diagnostic, a check, a boundary) or the
 * place's levels differ, and how many the route planned and ran (each saying DONE, nothing checked). Each mode compiles
 * in both orders, its whole plans compared; a plan equal to the sharing's own runs nothing again.
 */
function owing(cases: readonly UnrestrictedCase[]): { wrong: string[]; full: number } {
  const wrong: string[] = [];
  let full = 0;
  for (const c of cases) {
    const { request, ids } = prepare(c.source);
    let ran: { readonly plan: InstructionPlan; readonly says: string[] } | undefined;
    for (const shared of [true, false]) {
      const run = () => {
        const answers = analyseCore(request);
        const levels = decision(answers, ids.get(c.place)!, c.path).levels;
        const result = {
          outcome: answers.outcome,
          diagnostics: answers.diagnostics.length,
          checks: answers.checks.length,
        };
        let plan: InstructionPlan | null | "outside";
        try {
          plan = compileSourceWithBackend(c.source, { globals: GLOBALS }, CORE_BACKEND).plan;
        } catch (error) {
          if (!(error instanceof CandidateOutsideSlice)) throw error;
          plan = "outside";
        }
        return { levels, ...result, plan };
      };
      const { plan, ...result } = inBothOrders(() => (shared ? run() : withoutSharing(run)));
      if (plan !== "outside" && plan !== null && !isDeepStrictEqual(plan, ran?.plan))
        ran = { plan, says: runGlobals(plan, { hostValue: 1 }).said.map(({ text }) => text) };
      const observed = {
        ...result,
        plan:
          plan === "outside"
            ? "outside"
            : plan === null
              ? "no plan"
              : { checks: checksOf(plan), says: ran!.says },
      };
      if (shared && observed.plan !== "outside") full += 1;
      const expected = {
        levels: c.levels.map(sorted),
        outcome: "valid",
        diagnostics: 0,
        checks: 0,
        plan: c.executable ? { checks: [], says: ["DONE"] } : "outside",
      };
      if (JSON.stringify(observed) !== JSON.stringify(expected))
        wrong.push(`${c.name}${shared ? "" : " (no sharing)"}: ${JSON.stringify(observed)}`);
    }
  }
  return { wrong, full };
}

test("an unrestricted written collection takes any known contents, owing nothing for its elements (merged S6 B2)", (t) => {
  const { wrong, full } = owing(UNRESTRICTED_COLLECTION_MATRIX);
  t.diagnostic(
    `${UNRESTRICTED_COLLECTION_MATRIX.length} sources (${full} planned and run), both orders, sharing on and off`,
  );
  assert.deepEqual(wrong, []);
});

test("an object's properties take any contents in every form, copy and projection, owing nothing (merged S6 B2, Sol r1)", (t) => {
  const { wrong, full } = owing(OBJECT_PROPERTY_MATRIX);
  t.diagnostic(
    `${OBJECT_PROPERTY_MATRIX.length} sources (${full} planned and run), both orders, sharing on and off`,
  );
  assert.deepEqual(wrong, []);
});

/**
 * #1215 (V30 §13: `object` is any object; ADR 0021 1.3: a copy keeps the written type): a copy of a written `object`
 * whose start has fields stays unrestricted below it at every path no store visits, as `object?`, as `object[]`'s
 * element, through a chain of copies, a record projection and an enclosing record; a scalar-typed field beside it and
 * an inferred record's field keep their restriction; so does a field a store decides before the copy, which the copy's
 * written type opens unless the record's own literal decides it (Sol's r1 B1). Per source the analysis's admission at
 * each path (`copied` where a copy of a written type decides it), its C9 boundaries, and the plan's checked stores in
 * full (`plannedStores`), each compared on its own, in both orders with the sharing on and off; the four plans are equal,
 * so their runs are one: B1's here, with `hostInit`, the others' in the candidate test against the S7 oracle.
 */
test("a copied written object stays unrestricted below it in the analysis and the plan, its neighbours restricted (#1215)", () => {
  const object = (
    ...fields: (readonly [string, SerializableRuntimeValue])[]
  ): SerializableRuntimeValue => ({
    kind: "object",
    properties: fields.map(([name, value]) => ({ name, value })),
  });
  const rows: readonly {
    readonly lines: string;
    /** `place.step…` (`[]` an element), its admission as `written`, `copied` or `decided`, and its kinds. */
    readonly levels: readonly (readonly [string, string])[];
    /**
     * Each line storing host data: its target, the kinds its C9 boundary at the host read is against and its whole
     * checked type, `null` where it owes none.
     */
    readonly stores: readonly (readonly [string, string, string | null, string | null])[];
    /** Host values, and the line whose value stops the run (`null`: it says DONE). */
    readonly runs?: readonly (readonly [Record<string, SerializableRuntimeValue>, string | null])[];
  }[] = [
    {
      lines: "let typed: object = {n: 1}\nlet out = typed\nout = hostValue",
      levels: [
        ["out", "copied object"],
        ["out.n", "copied unknown"],
        ["typed", "written object"],
        ["typed.n", "decided unknown"],
      ],
      stores: [["out = hostValue", "out", "object", "{}"]],
    },
    {
      lines: "let typed: object? = {n: 1}\nlet out = typed\nout = hostValue",
      levels: [
        ["out", "copied null,object"],
        ["out.n", "copied unknown"],
      ],
      stores: [["out = hostValue", "out", "null,object", "null|{}"]],
    },
    {
      lines: "let typed: object[] = [{n: 1}]\nlet out = typed\nout = hostValue",
      levels: [
        ["out", "copied list"],
        ["out.[]", "copied object"],
        ["out.[].n", "copied unknown"],
      ],
      stores: [["out = hostValue", "out", "list", "list<{}>"]],
    },
    {
      // (a field named as an internal step: a quoted key step)
      lines:
        "let typed: object = {element: 1}\nlet a = typed\nlet b = a\nlet out = b\nout = hostValue",
      levels: [
        ["out", "copied object"],
        ["out.element", "copied unknown"],
      ],
      stores: [["out = hostValue", "out", "object", "{}"]],
    },
    {
      lines: "let typed: object = {n: 1}\nlet rec = {o: typed}\nlet out = rec.o\nout = hostValue",
      levels: [
        ["out", "copied object"],
        ["out.n", "copied unknown"],
      ],
      stores: [["out = hostValue", "out", "object", "{}"]],
    },
    {
      lines: "let typed: object = {n: 1}\nlet rec = {o: typed}\nrec = hostValue",
      levels: [
        ["rec", "decided object"],
        ["rec.o", "copied object"],
        ["rec.o.n", "copied unknown"],
      ],
      stores: [["rec = hostValue", "rec", "object", "{o: {}}"]],
    },
    {
      lines:
        "let typed: object = {n: 1}\nlet count: integer = 2\nlet rec = {c: count, o: typed}\nrec = hostValue",
      levels: [
        ["rec.c", "copied integer"],
        ["rec.o", "copied object"],
        ["rec.o.n", "copied unknown"],
      ],
      stores: [["rec = hostValue", "rec", "object", "{c: integer, o: {}}"]],
    },
    {
      lines: "let rec = {n: 1}\nlet out = rec\nout = hostValue",
      levels: [
        ["out", "decided object"],
        ["out.n", "decided integer"],
      ],
      stores: [["out = hostValue", "out", "object", "{n: integer}"]],
    },
    {
      // a field a store decides before the written copy reaches its record (Sol's r1 B1), nested too
      lines:
        "let typed: object = {n: 1}\nlet out = hostInit\nout.n = 2\nout = typed\nout.n = hostValue",
      levels: [
        ["out", "copied object"],
        ["out.n", "copied unknown"],
      ],
      stores: [
        ["let out = hostInit", "out", "object", "{}"],
        ["out.n = hostValue", "out.n", null, null],
      ],
      runs: [
        [{ hostInit: object(["n", 1]), hostValue: "text" }, null],
        [{ hostInit: 5, hostValue: "text" }, "let out = hostInit"],
      ],
    },
    {
      lines:
        "let typed: object = {n: {m: 1}}\nlet out = hostInit\nout.n.m = 2\nout = typed\nout.n.m = hostValue",
      levels: [
        ["out.n", "copied unknown"],
        ["out.n.m", "copied unknown"],
      ],
      stores: [
        ["let out = hostInit", "out", "object", "{}"],
        ["out.n.m = hostValue", "out.n.m", null, null],
      ],
      runs: [[{ hostInit: object(["n", object(["m", 1])]), hostValue: "text" }, null]],
    },
    {
      // (its control: a copied record whose own literal decides it keeps the field a store decided first)
      lines:
        "let typed: object = {n: 1}\nlet count: integer = 2\nlet rec = {c: count, o: typed}\nlet out = hostInit\nout.c = 3\nout = rec\nout.c = hostValue",
      levels: [
        ["out", "decided object"],
        ["out.c", "decided integer"],
        ["out.o", "copied object"],
        ["out.o.n", "copied unknown"],
      ],
      stores: [
        ["let out = hostInit", "out", "object", "{c: integer, o: {}}"],
        ["out.c = hostValue", "out.c", "integer", "integer"],
      ],
      runs: [
        [{ hostInit: object(["c", 1], ["o", object()]), hostValue: 4 }, null],
        [{ hostInit: object(["c", 1], ["o", object()]), hostValue: "text" }, "out.c = hostValue"],
      ],
    },
  ];
  for (const { lines, levels, stores, runs = [] } of rows) {
    const source = `${lines}\nsay "DONE"\nexit\n`;
    const { request, ids } = prepare(source);
    // a line's span, and its stored value's (after its ` = `)
    const spans = (line: string): readonly [string, string] => {
      const start = source.indexOf(`${line}\n`);
      const value = start + line.indexOf(" = ") + 3;
      return [`${start}:${start + line.length}`, `${value}:${start + line.length}`];
    };
    const expected = {
      levels: levels.map(([path, admitted]) => `${path} ${admitted}`),
      boundaries: stores
        .flatMap(([line, target, against]) =>
          against === null ? [] : [`${target} [${against}] ${spans(line)[1]}`],
        )
        .sort(),
      checks: stores.flatMap(([line, target, , type]) =>
        type === null ? [] : [`${target} ${spans(line).join(" ")} ${type}`],
      ),
    };
    const observe = () => {
      const answers = analyseCore(request);
      return {
        levels: levels.map(([path]) => {
          const [name, ...steps] = path.split(".");
          const { admitted } = answers.place(
            ids.get(name!)!,
            steps.map((step) => (step === "[]" ? "element" : propertyStep(step))),
          );
          const by = admitted.by === "decided" && admitted.inherited ? "copied" : admitted.by;
          return `${path} ${by}${admitted.by === "undecided" ? "" : ` ${sorted(admitted.kinds).join(",")}`}`;
        }),
        boundaries: answers.checks
          .filter((found) => found.boundary)
          .map(
            (found) =>
              `${found.target} [${sorted(found.against).join(",")}] ${found.site.start}:${found.site.end}`,
          )
          .sort(),
        plan: compileSourceWithBackend(source, { globals: GLOBALS }, CORE_BACKEND).plan,
      };
    };
    const shared = inBothOrders(observe);
    const unshared = inBothOrders(() => withoutSharing(observe));
    for (const [mode, { plan, ...analysed }] of [
      ["", shared],
      [" (no sharing)", unshared],
    ] as const) {
      assert.ok(plan !== null, `${lines}${mode}`);
      assert.deepEqual(analysed.levels, expected.levels, `${lines}${mode}: admission`);
      assert.deepEqual(analysed.boundaries, expected.boundaries, `${lines}${mode}: C9`);
      assert.deepEqual(plannedStores(plan), expected.checks, `${lines}${mode}: plan`);
    }
    assert.ok(
      isDeepStrictEqual(unshared.plan, shared.plan),
      `${lines}: the plans with and without sharing`,
    );
    for (const [globals, stop] of runs) {
      const ran = runGlobals(shared.plan!, globals);
      assert.deepEqual(
        [ran.status, ran.failure, ran.said.map(({ text }) => text)],
        stop === null ? ["halted", null, ["DONE"]] : ["failed", `TSR058@${spans(stop)[1]}`, []],
        `${lines} with ${JSON.stringify(globals)}`,
      );
    }
  }
});

test("a value read from an unrestricted written list owes each receiving consumer's check, the list still unrestricted (#1501)", () => {
  const object = (
    ...fields: (readonly [string, SerializableRuntimeValue])[]
  ): SerializableRuntimeValue => ({
    kind: "object",
    properties: fields.map(([name, value]) => ({ name, value })),
  });
  const list = (...items: SerializableRuntimeValue[]): SerializableRuntimeValue => ({
    kind: "list",
    items,
  });
  // (the list held in another list: a read through that carrier answers the written domain, which says what the list may
  // hold, not what it holds; the source list keeps any element, so a value fails only where it is received)
  const setup = 'let xs: list = [hostValue, 4]\nlet carrier = [xs]\nsay "BEFORE"\n';
  const rows: readonly {
    readonly lines: string;
    /** The receiving statement, and the warning's code and text at the receiving value. */
    readonly receiving: string;
    readonly warned: readonly (readonly [string, string])[];
    /** The plan's check there, its texts by their spans: checked stores, or other content (`plannedContent`). */
    readonly stores: readonly (readonly string[])[];
    readonly content: readonly (readonly string[])[];
    /** Host values the consumer takes, and ones it does not. */
    readonly fitting: readonly SerializableRuntimeValue[];
    readonly forbidden: readonly SerializableRuntimeValue[];
  }[] = [
    {
      lines: "let result: integer = carrier[0][0]\nsay result",
      receiving: "let result: integer = carrier[0][0]",
      warned: [["TSV041", "carrier[0][0]"]],
      stores: [["result", "let result: integer = carrier[0][0]", "carrier[0][0]", "integer"]],
      content: [],
      fitting: [2],
      forbidden: [2.5, "bad", true, null],
    },
    {
      // the complete written type, its element included
      lines: "let result: integer[] = carrier[0][0]\nsay result.length",
      receiving: "let result: integer[] = carrier[0][0]",
      warned: [
        ["TSV041", "carrier[0][0]"],
        ["TSV041", "carrier[0][0]"],
      ],
      stores: [
        ["result", "let result: integer[] = carrier[0][0]", "carrier[0][0]", "list<integer>"],
      ],
      content: [],
      fitting: [list(2, 4), list()],
      forbidden: [list("bad", 4), list(2.5), 2],
    },
    {
      // a property store cannot create the property
      lines: "let target = carrier[0][0]\ntarget.n = 1",
      receiving: "target.n = 1",
      warned: [["TSV043", "target.n"]],
      stores: [],
      content: [["requireExisting", "target.n = 1", "target.n"]],
      fitting: [object(["n", 2]), object(["n", "bad"])],
      forbidden: [object(), 2],
    },
    {
      // a default that stands in for a number, a copy of the value
      lines: "let v = carrier[0][0]\nlet fixed: number[] = [1.5]\nsay fixed.get(9, default: v)",
      receiving: "say fixed.get(9, default: v)",
      warned: [["TSV041", "v"]],
      stores: [],
      content: [["fallbackCheck", "fixed.get(9, default: v)", "integer|number"]],
      fitting: [2, 2.5],
      forbidden: ["bad", true],
    },
  ];
  for (const { lines, receiving, warned, stores, content, fitting, forbidden } of rows) {
    const source = `${setup}${lines}\nsay "AFTER"\nexit\n`;
    // (a text's span, searched from the receiving statement on)
    const from = source.indexOf(receiving);
    const span = (text: string): string => {
      const start = source.indexOf(text, from);
      return `${start}:${start + text.length}`;
    };
    const planned = (entries: readonly (readonly string[])[]): string[] =>
      entries.map(([first, ...texts]) =>
        [first, ...texts.slice(0, -1).map(span), texts.at(-1)].join(" "),
      );
    const compiled = MODES.map((mode) =>
      inMode(mode, () => compileSourceWithBackend(source, { globals: GLOBALS }, CORE_BACKEND)),
    );
    for (const [index, { diagnostics, plan }] of compiled.entries()) {
      const where = `${lines} in mode ${index}`;
      // the decision: the runtime-check warning at the receiving value, nothing else
      assert.deepEqual(
        diagnostics.map(
          (d) => `${d.severity} ${d.code}@${d.span.start.offset}:${d.span.end.offset}`,
        ),
        warned.map(([code, text]) => `warning ${code}@${span(text)}`),
        where,
      );
      // the plan: the check at the receiving statement, against the whole written type
      assert.ok(plan !== null, where);
      assert.deepEqual(plannedStores(plan), planned(stores), where);
      assert.deepEqual(plannedContent(plan, source), planned(content), where);
      assert.ok(isDeepStrictEqual(plan, compiled[0]!.plan), `${where}: the plan of mode 0`);
    }
    // the runs: a fitting value reaches AFTER; another fails at the receiving statement, having said only BEFORE
    const [start, end] = [from, from + receiving.length];
    for (const value of fitting) {
      const ran = runGlobals(compiled[0]!.plan!, { hostValue: value });
      assert.deepEqual(
        [ran.status, ran.said.at(-1)?.text],
        ["halted", "AFTER"],
        `${lines} with ${JSON.stringify(value)}`,
      );
    }
    for (const value of forbidden) {
      const ran = runGlobals(compiled[0]!.plan!, { hostValue: value });
      const [, at, to] = /@(\d+):(\d+)$/.exec(ran.failure ?? "") ?? [];
      assert.deepEqual(
        [ran.status, ran.said.map(({ text }) => text), Number(at) >= start && Number(to) <= end],
        ["failed", ["BEFORE"], true],
        `${lines} with ${JSON.stringify(value)}: ${ran.failure}`,
      );
    }
  }
});
