// A copy keeps its source's written type: past a later copy back, at an inherited field's own store, through cycles of
// copies, at every field a literal's elements land, and through a join (#1709).

import assert from "node:assert/strict";
import test from "node:test";

import { compileSourceWithBackend } from "../../../src/compiler.js";
import type { InstructionPlan } from "../../../src/plan/model.js";
import { analyseCore, coreResult, type Answers } from "../../../src/type-inference/core/answers.js";
import { CORE_BACKEND } from "../../../src/type-inference/core/backend.js";
import { coreRecord } from "../../../src/type-inference/core/result.js";
import { Admission } from "../../../src/type-inference/core/admission.js";
import { inheritedAt } from "../../../src/type-inference/core/inherited/inherited.js";
import { withoutSharing } from "../../../src/type-inference/core/sharing.js";
import { coreRequest } from "../../helpers/type-core-analysis.js";
import { narrowingPass } from "../../helpers/type-core/type-core-narrowing.js";
import { runGlobals } from "../../helpers/type-core-route.js";
import { inMode, MODES, publication } from "../../helpers/type-core-oracles.js";
import {
  inBothOrders,
  sorted,
  checksOf,
  GLOBALS,
  prepare,
  decision,
} from "../../helpers/type-core/type-core-written-setup.js";

test("a copy keeps its source's written type past a later copy back, and agrees with its source on a cycle of copies (Sol r2)", () => {
  const levelsOf = (source: string, places: readonly string[], path = ["element"]) => {
    const { request, ids } = prepare(source);
    const run = () => {
      const answers = analyseCore(request);
      return {
        outcome: answers.outcome,
        exhausted: answers.budget.exhausted,
        levels: places.map((place) => decision(answers, ids.get(place)!, path).levels),
      };
    };
    const shared = inBothOrders(run);
    assert.deepEqual(
      inBothOrders(() => withoutSharing(run)),
      shared,
    );
    return shared;
  };
  // a copy back into the source after its own written copy closes no cycle its decision waits on
  const back = levelsOf(
    "let typed: null[] = [null]\nlet a = null\nlet b = a\na = typed\na = b\nlet out = b\nout = [hostValue]\nexit\n",
    ["b", "out"],
  );
  // (`a`'s own `null` start before its written copy makes it optional, and its copies with it: Astra's F2)
  assert.deepEqual(back.levels, [
    [["list", "null"], ["null"]],
    [["list", "null"], ["null"]],
  ]);
  const swap = levelsOf(
    "let typed: integer?[] = [1]\nlet a = typed\nlet b = [2]\nlet tmp = a\na = b\nb = tmp\ntmp = [null]\nexit\n",
    ["tmp"],
  );
  assert.deepEqual(swap, {
    outcome: "valid",
    exhausted: null,
    levels: [[["list"], ["integer", "null"]]],
  });
  // a cycle of copies before the source's written copy: the copy admits what its source does
  const cycle = levelsOf(
    "let typed: null[] = [null]\nlet a = null\nlet b = a\na = b\na = typed\nlet out = b\nout = [hostValue]\nexit\n",
    ["b", "out"],
  );
  assert.deepEqual(cycle.levels[1]![1], cycle.levels[0]![1]);
  // a place copied into itself at another path is no cycle: `a.q.p` copies `a.p` (Sol's round 3 B2), in either order
  const inside = levelsOf(
    "let typed: null = null\nlet a = {p: typed, q: null}\na.q = a\nlet out = a.q.p\nout = hostValue\nexit\n",
    ["out"],
    [],
  );
  assert.deepEqual(inside, {
    outcome: "warning-runtime-check",
    exhausted: null,
    levels: [[["null"]]],
  });
  // a cycle of whole copies brings every member the written type's paths (Sol's round 4 B1)
  const round = levelsOf(
    "let typed: null[] = [null]\nlet a0 = typed\nlet a1 = a0\nlet a2 = a1\na0 = a2\nlet out = a2\nout = hostValue\nexit\n",
    ["a1", "a2", "out"],
  );
  assert.deepEqual(round.levels, [
    [["list"], ["null"]],
    [["list"], ["null"]],
    [["list"], ["null"]],
  ]);
  // a place nesting itself without end stops at the deepest path a written type reaches, within the allowance
  const nesting = levelsOf(
    "let typed: integer[] = [1]\nlet a = null\na = a[0]\na = [[typed]]\nlet out = a\nexit\n",
    ["out"],
    [],
  );
  assert.equal(nesting.exhausted, null);
});

/**
 * The owner's reviewer's F1 on #1049: a field a copy inherits a written type at is decided where the copy's
 * own store reaches it, whatever no read asks, in every layer: a misfitting value stored into it is an error at that
 * value; host data stored into it owes its check there, against the inherited type, which the candidate plan holds at
 * the store and which stops a forbidden value before anything is said. For a copy, a copy of a copy and a second copy
 * of the root, in both orders, with the sharing on and off. A `fromJson` call is outside the candidate route: its
 * decision is the host value's.
 */
test("a copy's inherited written field is decided at the copy's own store in every layer", () => {
  const span = (source: string, text: string, from = 0): string => {
    const start = source.indexOf(text, from);
    assert.ok(start >= 0, `${JSON.stringify(text)} in ${JSON.stringify(source)}`);
    return `${start}:${start + text.length}`;
  };
  for (const copies of [
    "let a = root",
    "let first = root\nlet a = first",
    "let other = root\nlet a = root",
  ]) {
    const prefix = `let typed: integer = 1\nlet root = {f: typed, g: typed}\n${copies}\n`;
    const wrong = `${prefix}a.f = "x"\nexit\n`;
    const host = `${prefix}a.f = hostValue\nsay "stored"\nexit\n`;
    const parsed = `${prefix}a.f = fromJson(hostValue)\nexit\n`;
    const store = prefix.length;
    for (const shared of [true, false]) {
      const decided = (source: string) =>
        inBothOrders(() => {
          const run = (): Answers =>
            analyseCore(coreRequest([{ path: "main.tease", source }], GLOBALS)!);
          const answers = shared ? run() : withoutSharing(run);
          return {
            outcome: answers.outcome,
            diagnostics: answers.diagnostics.map(
              (found) => `${found.class} ${found.kind} ${found.site.start}:${found.site.end}`,
            ),
            boundaries: answers.checks
              .filter((check) => check.boundary)
              .map(
                (check) =>
                  `${check.target} [${sorted(check.against).join(",")}] ${check.site.start}:${check.site.end}`,
              ),
          };
        });
      const mode = `${JSON.stringify(copies)}${shared ? "" : " (no sharing)"}`;
      assert.deepEqual(
        decided(wrong),
        {
          outcome: "compile-error",
          diagnostics: [`compile-error written-target ${span(wrong, '"x"', store)}`],
          boundaries: [],
        },
        mode,
      );
      const at = span(host, "hostValue", store);
      assert.deepEqual(
        decided(host),
        {
          outcome: "warning-runtime-check",
          diagnostics: [`warning-runtime-check written-target ${at}`],
          boundaries: [`a.f [integer] ${at}`],
        },
        mode,
      );
      const call = span(parsed, "fromJson(hostValue)", store);
      assert.deepEqual(
        decided(parsed),
        {
          outcome: "warning-runtime-check",
          diagnostics: [`warning-runtime-check written-target ${call}`],
          boundaries: [`a.f [integer] ${call}`],
        },
        mode,
      );
      const compile = (): InstructionPlan | null =>
        compileSourceWithBackend(host, { globals: GLOBALS }, CORE_BACKEND).plan;
      const plan = shared ? compile() : withoutSharing(compile);
      assert.ok(plan !== null, mode);
      assert.deepEqual(checksOf(plan), [`${span(host, "a.f = hostValue", store)} integer`], mode);
      const fits = runGlobals(plan, { hostValue: 5 });
      assert.deepEqual(
        [fits.status, fits.failure, fits.said.map(({ text }) => text)],
        ["halted", null, ["stored"]],
        mode,
      );
      const misfits = runGlobals(plan, { hostValue: "x" });
      assert.deepEqual(
        [misfits.status, misfits.failure, misfits.said],
        ["failed", `TSR058@${at}`, []],
        mode,
      );
    }
  }
});

/**
 * Sol's reviews r1 and r2 on #1059: a place copying itself whole twice decides as before; a record
 * whose host or misfitting field another copy's written type lands in the copy owes its check or its error at the copy's
 * store, also where the record reaches the copy through a cycle of copies, the check in the plan stopping a forbidden
 * value (all three layers); and a store rejected at a field stays rejected through a cycle of copies that adds a step.
 * Both orders, the sharing on and off.
 */
test("copies of different sources, repeated self copies, cycles and a rejection through a path cycle keep their answers", () => {
  const at = (source: string, text: string): string => {
    const start = source.lastIndexOf(text);
    return `${start}:${start + text.length}`;
  };
  const decided = (source: string, shared: boolean) =>
    inBothOrders(() => {
      const run = (): Answers =>
        analyseCore(coreRequest([{ path: "main.tease", source }], GLOBALS)!);
      const answers = shared ? run() : withoutSharing(run);
      return {
        outcome: answers.outcome,
        diagnostics: answers.diagnostics.map(
          (found) => `${found.class} ${found.kind} ${found.site.start}:${found.site.end}`,
        ),
        checks: answers.checks
          .map(
            (check) =>
              `${check.target} [${sorted(check.against).join(",")}] ${check.site.start}:${check.site.end}${check.boundary ? " boundary" : ""}`,
          )
          .sort(),
      };
    });
  const typed = "let typed:integer=1\n";
  const self = `${typed}let a={f:typed}\na=a\na=a\nexit\n`;
  const host = `${typed}let root={f:typed}\nlet other={f:hostValue,g:typed}\nlet a=root\na=other\nsay "stored"\nexit\n`;
  const text = `${typed}let root={f:typed}\nlet other={f:"s",g:typed}\nlet a=root\na=other\nexit\n`;
  const cycle = `${typed}let root={f:typed}\nlet bad={f:"s"}\nlet a=root\nlet b={p:a}\na=b.p\na=bad\nexit\n`;
  // (review r2 B1: the record's host field reaches the copy through a cycle of copies)
  const round = `${typed}let root={f:typed,g:typed}\nlet other={f:hostValue,g:typed}\nlet a=other\na=a\nlet c=root\nc=a\nsay "stored"\nexit\n`;
  for (const shared of [true, false]) {
    const mode = shared ? "" : " (no sharing)";
    assert.deepEqual(
      decided(self, shared),
      { outcome: "valid", diagnostics: [], checks: [] },
      `self${mode}`,
    );
    const copy = at(host, "other");
    assert.deepEqual(
      decided(host, shared),
      {
        outcome: "warning-runtime-check",
        diagnostics: [`warning-runtime-check written-target ${copy}`],
        checks: [`a.f [integer] ${copy}`, `other [object] ${at(host, "hostValue")} boundary`],
      },
      `host${mode}`,
    );
    assert.deepEqual(
      decided(text, shared),
      {
        outcome: "compile-error",
        diagnostics: [`compile-error written-target ${at(text, "other")}`],
        checks: [],
      },
      `text${mode}`,
    );
    assert.deepEqual(
      decided(cycle, shared),
      {
        outcome: "compile-error",
        diagnostics: [`compile-error written-target ${at(cycle, "bad")}`],
        checks: [],
      },
      `cycle${mode}`,
    );
    // (the copy's read in `c=a`)
    const read = round.indexOf("c=a") + 2;
    assert.deepEqual(
      decided(round, shared),
      {
        outcome: "warning-runtime-check",
        diagnostics: [`warning-runtime-check written-target ${read}:${read + 1}`],
        checks: [
          `c.f [integer] ${read}:${read + 1}`,
          `other [object] ${at(round, "hostValue")} boundary`,
        ],
      },
      `round${mode}`,
    );
    const compile = (): InstructionPlan | null =>
      compileSourceWithBackend(round, { globals: GLOBALS }, CORE_BACKEND).plan;
    const plan = shared ? compile() : withoutSharing(compile);
    assert.ok(plan !== null, `round plan${mode}`);
    // (the record's own host data checked where it is declared, the copy's field at its store from the cycle)
    assert.deepEqual(
      checksOf(plan),
      [`${at(round, "let other={f:hostValue,g:typed}")} object`, `${at(round, "c=a")} object`],
      `round plan${mode}`,
    );
    const fits = runGlobals(plan, { hostValue: 5 });
    assert.deepEqual(
      [fits.status, fits.failure, fits.said.map(({ text: said }) => said)],
      ["halted", null, ["stored"]],
    );
    const misfits = runGlobals(plan, { hostValue: "bad" });
    assert.deepEqual(
      [misfits.status, misfits.failure, misfits.said],
      ["failed", `TSR058@${read}:${read + 1}`, []],
    );
  }
});

test("a cycle of copies inherits the same written types whichever of its places admission asks first (#1931; ADR 0021 1)", () => {
  const orders = (places: readonly string[]): string[][] =>
    places.length <= 1
      ? [[...places]]
      : places.flatMap((first, at) =>
          orders(places.filter((_, other) => other !== at)).map((rest) => [first, ...rest]),
        );
  // (A4's inherited type of each place, asked in `order` on a fresh admission: `none` where it copies no written type)
  const inheritedIn = (source: string, order: readonly string[]): Record<string, string> => {
    const { request, ids } = prepare(source);
    const pass = narrowingPass(request);
    const admission = new Admission(
      pass,
      { run: (work) => pass.solver.run(work) },
      new Map(),
      new Set(),
    );
    const got: Record<string, string> = {};
    for (const place of order) {
      const term = inheritedAt(admission, ids.get(place)!, []);
      got[place] = term === null ? "none" : JSON.stringify(term);
    }
    return got;
  };
  const NUMBER = JSON.stringify({ kind: "atom", name: "number" });
  const everyOrder = (source: string, places: readonly string[]) => {
    const first = inheritedIn(source, places);
    for (const order of orders(places))
      assert.deepEqual(inheritedIn(source, order), first, `${order.join(" > ")}\n${source}`);
    return first;
  };
  // (u copies v and x, v copies u, x copies v: one cycle, each copy in it cut; v keeps its own later written copy, and
  // x copies none of it whichever place is asked first, u too: #1931)
  const ring = (stores: string) =>
    `let w: number = 1\nlet u = hostValue\nlet v = hostValue\nlet x = hostValue\n${stores}\nsay u\nsay v\nsay x\nexit\n`;
  for (const stores of ["x = v\nv = u\nu = v\nu = x\nv = w", "x = v\nu = v\nu = x\nv = u\nv = w"])
    assert.deepEqual(everyOrder(ring(stores), ["u", "v", "x"]), {
      u: "none",
      v: NUMBER,
      x: "none",
    });
  // the analysis decides so in each mode (only v by its copy of a written type), and publishes one record, diagnostics
  // and plan in all four (`publication`)
  const witness = ring("x = v\nv = u\nu = v\nu = x\nv = w");
  const { request, ids } = prepare(witness);
  const published = new Set<string | null>();
  for (const mode of MODES) {
    assert.deepEqual(
      inMode(mode, () => {
        const answers = analyseCore(request);
        return ["u", "v", "x"].map((place) => {
          const { admitted } = answers.place(ids.get(place)!, []);
          return `${place} ${admitted.by === "decided" && admitted.inherited ? "copied" : admitted.by}`;
        });
      }),
      ["u decided", "v copied", "x decided"],
      JSON.stringify(mode),
    );
    published.add(publication([{ path: "main.tease", source: witness }], mode, GLOBALS));
  }
  assert.equal(published.size, 1);
  assert.notEqual([...published][0], null);
  // controls: a copy back after the first value decides waits on nothing; a cycle fed late cuts only its copies
  const W = "let w: number = 1\n";
  assert.deepEqual(
    everyOrder(`${W}let a = w\nlet b = a\na = b\nsay a\nsay b\nexit\n`, ["a", "b"]),
    { a: NUMBER, b: NUMBER },
  );
  assert.deepEqual(
    everyOrder(`${W}let a = hostValue\nlet b = a\na = b\nb = w\nsay a\nsay b\nexit\n`, ["a", "b"]),
    { a: "none", b: NUMBER },
  );
});

test("a literal's elements are compared at every field copies land, decided or not, after a rejection too (Astra's review B1)", () => {
  // (each source's complete record, one in both orders and with the sharing on and off: `main`'s)
  const record = (source: string): ReturnType<typeof coreRecord> => {
    const run = (): ReturnType<typeof coreRecord> =>
      coreRecord(coreResult(analyseCore(coreRequest([{ path: "main.tease", source }], GLOBALS)!)), [
        "main.tease",
      ]);
    const shared = inBothOrders(run);
    assert.deepEqual(
      inBothOrders(() => withoutSharing(run)),
      shared,
    );
    return shared;
  };
  // (the error at an element's last occurrence of its text)
  const errors = (source: string, ...texts: string[]) => ({
    outcome: texts.length === 0 ? "valid" : "compile-error",
    diagnostics: texts.map((text) => {
      const offset = source.lastIndexOf(text);
      return {
        class: "compile-error",
        kind: "written-target",
        site: { file: "main.tease", offset, end: offset + text.length },
      };
    }),
    runtimeChecks: [],
  });
  const typed = 'let t:string="ok"\nlet root={spare:t}\n';
  const cases: readonly (readonly [string, string, ...string[]])[] = [
    // a field the copy lands, met by a plain element after it and before it
    ["landed first", `${typed}let other={spare:1}\nlet a=[root,other]\n`, "other"],
    ["plain first", `${typed}let other={spare:1}\nlet a=[other,root]\n`, "root"],
    // under rejection: a third element, and the root's own store rejected
    [
      "a third element",
      `${typed}let other={spare:1}\nlet more={spare:2}\nlet a=[other,root,more]\n`,
      "root",
    ],
    [
      "a rejected store",
      `${typed}root.spare=5\nlet other={spare:1}\nlet a=[root,other]\n`,
      "5",
      "other",
    ],
    // under a guard: the literal, and a store at the root's field
    [
      "a guarded literal",
      `${typed}let other={spare:1}\nlet a=[root]\nif hostValue == 1 { a=[root,other] }\n`,
      "other",
    ],
    [
      "a guarded store",
      `${typed}if hostValue == 1 { root.spare = "x" }\nlet other={spare:1}\nlet a=[other,root]\n`,
      "root",
    ],
    // through a copy, with and without its own store
    ["a copy", `${typed}let b=root\nlet other={spare:1}\nlet a=[other,b]\n`, "b"],
    [
      "a copy's store",
      'let t:string="ok"\nlet root={spare:t,extra:1}\nlet b=root\nb.extra=2\nlet other={spare:1}\nlet a=[b,other]\n',
      "other",
    ],
    // a union the plain element's kind fits: the list's elements fit the union, in either order (#2289 B1)
    [
      "a union",
      'let t:integer|string="ok"\nlet root={spare:t}\nlet other={spare:1}\nlet a=[other,root]\n',
    ],
    // two plain elements where another store's copy lands
    [
      "two plain elements",
      `${typed}let o1={spare:1}\nlet o2={spare:"x"}\nlet a=[root]\na=[o2,o1]\n`,
      "o1",
    ],
  ];
  for (const [name, body, ...texts] of cases) {
    const source = `${body}exit\n`;
    assert.deepEqual(record(source), errors(source, ...texts), name);
  }
});

/**
 * #1709 (ADR 0021 1.3, `joinedDomain`): a list join's written operand keeps its written element type, so a written
 * `integer?[]` joined with a list of text mixes `integer | null` and `string` (TSV044), whichever operand comes first,
 * in the four modes: `null` among a type's kinds decides by those kinds, only a type of `null` alone decides nothing.
 * The controls join it with what its type holds, and give nothing.
 */
test("a join of a written nullable list with a list of another type errs, in either order (#1709)", () => {
  const joins: readonly (readonly [string, readonly string[]])[] = [
    ['a + ["x"]', ["TSV044"]],
    ['["x"] + a', ["TSV044"]],
    ["a + [2]", []],
    ["[2, null] + a", []],
    ["a + [null]", []],
  ];
  for (const [join, expected] of joins)
    for (const mode of MODES) {
      const source = `let a: integer?[] = [1]\nlet b = ${join}\nsay b.length\nexit\n`;
      const request = coreRequest([{ path: "main.tease", source }]);
      assert.ok(request !== null, source);
      const errors = inMode(mode, () => analyseCore(request))
        .diagnostics.filter((diagnostic) => diagnostic.class === "compile-error")
        .map((diagnostic) => diagnostic.code);
      assert.deepEqual(errors, expected, `${join}, ${JSON.stringify(mode)}`);
    }
});
