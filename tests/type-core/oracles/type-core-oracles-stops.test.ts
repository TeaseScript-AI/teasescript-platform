// The stop oracle: the stop-set comparison, an analysis's stop trace, and a stop's runs, which claim only what they
// demonstrate (#2080, #2116).

import assert from "node:assert/strict";
import test from "node:test";

import { analyseCore, type Answers } from "../../../src/type-inference/core/answers.js";
import { withTestDemandAllowance } from "../../../src/type-inference/core/budget.js";
import { withConsumerOrder } from "../../../src/type-inference/core/consumers.js";
import { coreRequest } from "../../helpers/type-core-analysis.js";
import { inMode, MODES, stoppedRecord, stopSet } from "../../helpers/type-core-oracles.js";
import type { InstructionPlan, TypeCheckPlan } from "../../../src/plan/model.js";
import { HELD_MODES } from "../../helpers/type-core-held-host.js";
import { hostValues, stopRuns } from "../../helpers/type-core-stop-runs.js";
import { GLOBALS } from "../../helpers/type-core/type-core-oracles-setup.js";

/** The plain gate's decline (#2080 part 2): a stop before admission settled left a store's check undecided. */
const UNDECIDED = "a store whose check was left undecided at the budget";

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

/** `plan` with each store type check `edit` gives back, removed where it gives `undefined` (a planted change, #2080). */
function editedTypeChecks(
  plan: InstructionPlan,
  edit: (check: TypeCheckPlan) => TypeCheckPlan | undefined,
): InstructionPlan {
  const text = JSON.stringify(plan, (key, value: unknown) => {
    if (key !== "typeCheck") return value;
    // EVIDENCE: invariant: a plan's `typeCheck` is a `TypeCheckPlan`, a type and the place it is checked at.
    const check = value as TypeCheckPlan;
    return edit(check);
  });
  // EVIDENCE: invariant: a plan is JSON-safe data, so its text read back is the same plan with the edited checks.
  return JSON.parse(text) as InstructionPlan;
}

/** `plan` without its stores' type checks, or without its first one only (a planted lost check, #2080). */
function withoutTypeChecks(plan: InstructionPlan, firstOnly = false): InstructionPlan {
  let removed = false;
  return editedTypeChecks(plan, (check) => {
    if (firstOnly && removed) return check;
    removed = true;
    return undefined;
  });
}

/**
 * A no-plan unit at the work allowance 1 (#2080 part 2): its own stopped compile, which the plain gate declines, and the
 * same stopped analysis with its plan compiled from a sibling, `let n = 1` written as text (`let n="s"`, the same spans),
 * unstopped, then `planted`: the oracle's no-plan readings, driven by a plan the test builds.
 */
function stopNoPlan(
  source: string,
  globals: readonly string[],
  run: <T>(make: () => T) => T,
  planted?: (plan: InstructionPlan) => InstructionPlan,
  files: (text: string) => readonly { readonly path: string; readonly source: string }[] = (
    text,
  ) => [{ path: "main.tease", source: text }],
): readonly [ReturnType<typeof stopRuns>, ReturnType<typeof stopRuns>] {
  const own = stopRuns(files(source), globals, run, 1, planted, "work");
  assert.deepEqual([own.natural.plan, own.stopped.declined], [false, UNDECIDED], source);
  const sibling = files(source).map((file) => ({
    ...file,
    source: file.source.replace("let n = 1", 'let n="s"'),
  }));
  assert.notDeepEqual(sibling, files(source));
  const built = stopRuns(files(source), globals, run, 1, planted, "work", {
    files: sibling,
    globals,
  });
  assert.equal(built.natural.plan, false, source);
  return [own, built];
}

test("a stop's runs take host data made from the source's own property names: one pool per global it reads, the same each time (#2080)", () => {
  const files = [
    { path: "main.tease", source: 'let a = {box: {f: hostValue}}\nsay "${a.box.f}"\nexit\n' },
  ];
  const values = hostValues(files, GLOBALS);
  assert.deepEqual(hostValues(files, GLOBALS), values);
  // (a global the source never reads stays 1)
  assert.ok(values.every((each) => each.hostOther === 1 && each.hostInit === 1));
  const shown = new Set(values.map((each) => JSON.stringify(each.hostValue)));
  for (const value of [1, "s", null, { kind: "list", items: [] }])
    assert.ok(shown.has(JSON.stringify(value)), JSON.stringify(value));
  assert.ok(
    shown.has(
      JSON.stringify({
        kind: "object",
        properties: [
          { name: "box", value: { kind: "object", properties: [{ name: "f", value: "s" }] } },
        ],
      }),
    ),
    "an object two properties deep, by the source's names",
  );
  // (a path read below a value: an object along it, three properties deep)
  const deep = [{ path: "main.tease", source: 'say "${hostValue.a.b.c}"\nexit\n' }];
  assert.ok(
    hostValues(deep, GLOBALS).some(
      (each) =>
        JSON.stringify(each.hostValue) ===
        JSON.stringify({
          kind: "object",
          properties: [
            {
              name: "a",
              value: {
                kind: "object",
                properties: [
                  { name: "b", value: { kind: "object", properties: [{ name: "c", value: "s" }] } },
                ],
              },
            },
          ],
        }),
    ),
  );
  // (two globals read: a smaller pool each, its scalars and collections whole, the product capped)
  const two = [{ path: "main.tease", source: "let a = hostValue\nlet b = hostOther\nexit\n" }];
  const both = hostValues(two, GLOBALS);
  for (const value of [0, 2.5, { kind: "dict", entries: [] }])
    assert.ok(
      both.some((each) => JSON.stringify(each.hostOther) === JSON.stringify(value)),
      JSON.stringify(value),
    );
  assert.ok(hostValues(two, GLOBALS, 50).length <= 50);
});

test("a stop's runs find a stopped plan that runs past a runtime failure the natural plan raises, and none in a sound one (#2080)", () => {
  const files = [
    { path: "main.tease", source: 'let n: integer = 1\nn = hostValue\nsay "after"\nexit\n' },
  ];
  for (const mode of MODES) {
    const run = <T>(make: () => T): T => inMode(mode, make);
    // (an allowance that stops nothing: the stopped plan is the natural one, every run alike)
    assert.equal(
      stopRuns(files, ["hostValue"], run, 1_000_000).kind,
      "closed",
      JSON.stringify(mode),
    );
    // (the same plan without its store's type check: the natural plan fails where it runs on)
    const found = stopRuns(files, ["hostValue"], run, 1_000_000, (plan) => withoutTypeChecks(plan));
    assert.equal(found.kind, "open", JSON.stringify(mode));
    assert.equal(found.first?.natural?.failure?.code, "TSR058");
    assert.equal(found.first?.stopped.failure, null);
    assert.deepEqual(found.first?.stopped.said, ["after"]);
  }
});

test("a stop's runs of a program the natural compile rejects run nothing where the stop rejects it too (#2080)", () => {
  const files = [{ path: "main.tease", source: 'let n: integer = 1\nn = "x"\nexit\n' }];
  const found = stopRuns(files, ["hostValue"], (make) => make(), 16);
  assert.equal(found.kind, "no plan");
  assert.equal(found.runs, 0);
});

test("a stop's runs report a later failure at another site, and a difference no host value exercised as unwitnessed, never closed (#2080, Codex r1 on #2142)", () => {
  const run = <T>(make: () => T): T => make();
  // (the first store's check only removed: the stopped plan fails at the second store, saying nothing more)
  const later = stopRuns(
    [
      {
        path: "main.tease",
        source: 'let n: integer = hostValue\nlet m: integer = hostValue\nsay "after"\nexit\n',
      },
    ],
    ["hostValue"],
    run,
    1_000_000,
    (plan) => withoutTypeChecks(plan, true),
  );
  assert.equal(later.kind, "later");
  assert.notEqual(later.first?.natural?.failure?.start, later.first?.stopped.failure?.start);
  // (the store's check runs only for a duration, which the pool never offers: the plans differ, no run tells them apart)
  const unwitnessed = stopRuns(
    [
      {
        path: "main.tease",
        source:
          'let n: integer = 1\nif hostValue is duration {\n  n = hostOther\n}\nsay "after"\nexit\n',
      },
    ],
    ["hostValue", "hostOther"],
    run,
    1_000_000,
    (plan) => withoutTypeChecks(plan),
  );
  assert.equal(unwitnessed.kind, "unwitnessed");
});

test("a stop's runs leave a difference unwitnessed where a failure elsewhere hides it, and read an earlier stricter failure as no escape (#2080, Codex r2 on #2142)", () => {
  const run = <T>(make: () => T): T => make();
  // (`hidden`'s check removed, which only a duration reaches; `visible`'s check fails for many values: still undecided)
  const hidden = stopRuns(
    [
      {
        path: "main.tease",
        source:
          'if hostValue is integer {\n  let visible: string = hostOther\n}\nlet hidden: integer = 1\nif hostValue is duration {\n  hidden = hostOther\n}\nsay "after"\nexit\n',
      },
    ],
    ["hostValue", "hostOther"],
    run,
    1_000_000,
    (plan) =>
      editedTypeChecks(plan, (check) => (check.place.includes("hidden") ? undefined : check)),
  );
  assert.equal(hidden.kind, "unwitnessed");
  // (the first of two stores strengthened from number to integer: at 2.5 it fails first, where the natural plan fails at the second)
  const stricter = stopRuns(
    [
      {
        path: "main.tease",
        source: 'let a: number = hostValue\nlet b: integer = hostValue\nsay "after"\nexit\n',
      },
    ],
    ["hostValue"],
    run,
    1_000_000,
    (plan) =>
      editedTypeChecks(plan, (check) =>
        check.type.kind === "number" ? { ...check, type: { kind: "integer" } } : check,
      ),
  );
  // (no escape: stricter is not a class the oracle claims, so the differing plans stay unresolved)
  assert.equal(stricter.kind, "unwitnessed");
});

test("a stop's runs catch the design round's controls: a false branch, a nested element, a later failure with no output, and an error site no run reaches (#2080, the design round on #2142)", () => {
  const run = <T>(make: () => T): T => make();
  const unit = (source: string) => [{ path: "main.tease", source }];
  // (the false branch's store check removed: the pool's false reaches it)
  assert.equal(
    stopRuns(
      unit(
        "let flag: boolean = hostValue\nlet n: integer = 1\nif flag {} else { n = hostOther }\nexit\n",
      ),
      ["hostValue", "hostOther"],
      run,
      1_000_000,
      (plan) =>
        editedTypeChecks(plan, (check) => (check.place.includes("'n'") ? undefined : check)),
    ).kind,
    "open",
  );
  // (the inner element of `integer[][]` opened: values made from the checked type reach it)
  assert.equal(
    stopRuns(
      unit("let n: integer[][] = hostValue\nexit\n"),
      ["hostValue"],
      run,
      1_000_000,
      (plan) =>
        editedTypeChecks(plan, (check) => ({
          ...check,
          type: { kind: "list", element: { kind: "list", element: null } },
        })),
    ).kind,
    "open",
  );
  // (the first of two stores' checks removed, nothing said on either side: the stopped plan ran past the first check)
  assert.equal(
    stopRuns(
      unit("let n: integer = hostValue\nlet m: integer = hostValue\nexit\n"),
      ["hostValue"],
      run,
      1_000_000,
      (plan) => withoutTypeChecks(plan, true),
    ).kind,
    "later",
  );
  // (no natural plan; the stop's plan checked at the erring store: the false run fails there, the true run never reaches
  // it, so no run passes it, which the oracle claimed open before the design round. #2080 part 1 declines a settled
  // stop's no-plan store that a rejection lost, and the plain gate a stop before admission settled, #2080 part 2: no stop
  // of these units publishes, so the stopped plan is a sibling's, `n` written as text, with the unit's own spans)
  const planted = 'let flag: boolean = hostValue\nlet n = 1\nif flag {} else { n = "bad" }\nexit\n';
  const checkedAtBad = (plan: InstructionPlan): InstructionPlan => ({
    ...plan,
    instructions: plan.instructions.map((instruction) =>
      JSON.stringify(instruction).includes('"bad"')
        ? { ...instruction, typeCheck: { type: { kind: "integer" }, place: "'n'" } }
        : instruction,
    ),
  });
  assert.deepEqual(
    stopNoPlan(planted, ["hostValue"], run, checkedAtBad).map((found) => found.kind),
    ["declined", "unwitnessed"],
  );
  // (no natural plan; the erring store under a guard no pool value takes: untested, never open)
  assert.deepEqual(
    stopNoPlan('let n = 1\nif hostValue is duration { n = "bad" }\nexit\n', ["hostValue"], run).map(
      (found) => found.kind,
    ),
    ["declined", "unwitnessed"],
  );
});

test("a stop's runs read #2116's final witness closed on main at demand 64, and open with its store checks dropped, in every held mode (#2080 part 1, PR #2116's final, comment 6736629257)", () => {
  // (`all:new-cases-2::graph/396`: the lossy stop path kept six runtime checks here on main and none on #2116's head,
  // where `hostValue = "text"` ran past the store main checks. These tests compile main alone, so they cannot compile
  // that head: the plan with its store checks dropped stands in for it, the same failure in the same place)
  const files = [
    {
      path: "main.tease",
      source:
        'let typed:number=1.5\nlet num:integer=1\nlet text:string="x"\nlet root={f:typed,g:num}\nlet foreign={f:hostValue,g:text}\nlet a=root\nlet b=foreign\nlet c=root\nif hostValue is integer {a=b}\nb=b\nb=a\na=a\nlet out=c\nexit\n',
    },
  ];
  for (const mode of HELD_MODES) {
    const run = <T>(make: () => T): T => mode.run(make);
    assert.equal(stopRuns(files, ["hostValue"], run, 64).kind, "closed", mode.name);
    assert.equal(
      stopRuns(files, ["hostValue"], run, 64, (plan) => withoutTypeChecks(plan)).kind,
      "open",
      mode.name,
    );
  }
});

const unit = (source: string) => [{ path: "main.tease", source }];
const loosened = (type: TypeCheckPlan["type"]): TypeCheckPlan["type"] =>
  type.kind === "list" && type.element?.kind === "list"
    ? { ...type, element: { kind: "list", element: null } }
    : type.kind === "union"
      ? { ...type, members: type.members.map(loosened) }
      : type;
const props = Array.from({ length: 10 }, (_, at) => `p${at}: seed`).join(", ");
const cases: {
  readonly name: string;
  readonly files: readonly { readonly path: string; readonly source: string }[];
  readonly globals: readonly string[];
  readonly demand: number;
  readonly planted?: (plan: InstructionPlan) => InstructionPlan;
}[] = [
  // (a retained index check fails where the dropped store check is never reached)
  {
    name: "index",
    files: unit("let n: integer = [1, 1, hostOther, 1, 1].get(hostValue, default: 1)\nexit\n"),
    globals: ["hostValue", "hostOther"],
    demand: 1_000_000,
    planted: (plan) => withoutTypeChecks(plan),
  },
  // (a union's nested element opened, which no pool value of the union reaches)
  {
    name: "union",
    files: unit("let n: integer[][]? = hostValue\nexit\n"),
    globals: ["hostValue"],
    demand: 1_000_000,
    planted: (plan) =>
      editedTypeChecks(plan, (check) => ({ ...check, type: loosened(check.type) })),
  },
  // (a part check dropped beside a sibling one)
  {
    name: "part",
    files: unit(
      "let seed: integer = 1\nlet copy = hostValue\nif hostOther is duration {\n copy.a = seed\n copy.xs = [{n: seed}]\n}\ncopy = hostOther\nexit\n",
    ),
    globals: ["hostValue", "hostOther"],
    demand: 1_000_000,
    planted: (plan) => ({
      ...plan,
      instructions: plan.instructions.map((instruction) =>
        "partChecks" in instruction && Array.isArray(instruction.partChecks)
          ? {
              ...instruction,
              partChecks: instruction.partChecks.filter(
                (part: { readonly path: readonly unknown[] }) =>
                  !JSON.stringify(part.path).includes("xs"),
              ),
            }
          : instruction,
      ),
    }),
  },
  // (the tenth property of an object widened, past the pool's cap)
  {
    name: "cap",
    files: unit(`let seed: integer = 1\nlet n = {${props}}\nn = hostValue\nexit\n`),
    globals: ["hostValue"],
    demand: 1_000_000,
    planted: (plan) =>
      editedTypeChecks(plan, (check) =>
        check.type.kind === "object"
          ? {
              ...check,
              type: {
                ...check.type,
                properties: check.type.properties.map((property) =>
                  property.name === "p9" ? { ...property, type: { kind: "number" } } : property,
                ),
              },
            }
          : check,
      ),
  },
  // (a stricter check in a loop: the stopped plan fails in the second round, before the natural failure)
  {
    name: "loop",
    files: unit(
      "let current = hostValue\nrepeat 2 {\n let a: number = current\n let b: integer = current\n current = hostOther\n}\nexit\n",
    ),
    globals: ["hostValue", "hostOther"],
    demand: 1_000_000,
    planted: (plan) =>
      editedTypeChecks(plan, (check) =>
        check.type.kind === "number" ? { ...check, type: { kind: "integer" } } : check,
      ),
  },
];

const corpus = (
  source: string,
  mode: (typeof HELD_MODES)[number],
  demand: number,
  planted?: (plan: InstructionPlan) => InstructionPlan,
) =>
  stopRuns(
    unit(source),
    ["hostValue", "hostOther", "hostInit"],
    (make) => mode.run(make),
    demand,
    planted,
  );

const operation = (value: string, declared = "integer") =>
  `let t:${declared}=${declared === "integer" ? "7" : "null"}\nlet root={n:t,nest:{n:t,keep:1},spare:t}\nlet a=root\nlet b={p:a}\nb.p.nest.n=${value}\nlet out=[b.p,root].get(0, default: root)\nrepeat out.nest.n {}\nexit\n`;

const looping =
  "let t:integer?=null\nlet root={n:t,nest:{n:t,keep:1},spare:t}\nlet other={n:2.5,nest:{n:2.5,keep:1},spare:1}\nlet a=root\nif other != null { a=other }\nlet b=a\nrepeat b.n {}\nexit\n";

test("a stop's runs claim only what they demonstrate: Codex r3's wrong-check, part, cap, ancestor, file and loop cases stay unwitnessed (#2080, Codex r3 on #2142)", () => {
  for (const mode of HELD_MODES)
    for (const { name, files, globals, demand, planted } of cases)
      assert.equal(
        stopRuns(files, globals, (make) => mode.run(make), demand, planted).kind,
        "unwitnessed",
        `${name} (${mode.name})`,
      );
  // (no natural plan: #2080 part 1 declines a settled stop's no-plan store that a rejection lost, and the plain gate a
  // stop before admission settled, #2080 part 2, so these units' stopped plans are their siblings', `stopNoPlan`)
  for (const mode of HELD_MODES) {
    const run = <T>(make: () => T): T => mode.run(make);
    // (the erring store behind a check no pool value passes, inside a block the runs enter)
    const ancestor = stopNoPlan(
      'let n = 1\nif hostValue is boolean {\n  let gate: duration = hostOther\n  n = "bad"\n}\nexit\n',
      ["hostValue", "hostOther"],
      run,
    );
    assert.deepEqual(
      ancestor.map((found) => found.kind),
      ["declined", "unwitnessed"],
      `ancestor (${mode.name})`,
    );
    // (the erring store in another file, at offsets of a store of the main file)
    const file = stopNoPlan(
      'let n = 1\nif hostValue is duration { n = "bad" }\nexit\n',
      ["hostValue"],
      run,
      undefined,
      (text) => [
        {
          path: "main.tease",
          source: `${" ".repeat("let n = 1\nif hostValue is duration { ".length)}let x = 1\nexit\n`,
        },
        { path: "other.tease", source: text },
      ],
    );
    assert.deepEqual(
      file.map((found) => found.kind),
      ["declined", "unwitnessed"],
      `file (${mode.name})`,
    );
    // (a genuine escape: the stopped plan stores a text the natural compile rejects, under a guard the pool's boolean
    // takes)
    const escape = stopNoPlan(
      'let n = 1\nif hostValue is boolean { n = "bad" }\nexit\n',
      ["hostValue"],
      run,
    );
    assert.deepEqual(
      escape.map((found) => found.kind),
      ["declined", "open"],
      `escape (${mode.name})`,
    );
  }
});

test("a stop's runs claim only what they demonstrate: a store's absent property is read at the store, and a genuine escape stays open (#2080, Codex r3 on #2142)", () => {
  // (compiled no-plan stops that still publish, settled, from the census of #2080 part 2: a store moved to a check against
  // `unknown` that every run fails, unwitnessed, and open with its checks dropped; two errors, each read at its own site;
  // C5c's absent property read at the store, `s8b-r3-astra-cases.mjs/case/storenull`; and the typed read #2183 names,
  // open as compiled)
  for (const mode of HELD_MODES) {
    const moved = corpus(operation('"bad"'), mode, 64);
    assert.deepEqual(
      [
        moved.natural.plan,
        moved.stopped.plan,
        moved.kind,
        moved.sites.map(({ code, site, checks }) => `${code} ${site} ${checks}`),
      ],
      [false, true, "unwitnessed", ["TSV041 0:91:96 unknown"]],
      mode.name,
    );
    assert.equal(
      corpus(operation('"bad"'), mode, 64, (plan) => withoutTypeChecks(plan)).kind,
      "open",
      mode.name,
    );
  }
  const two = corpus(
    'let typed:null=null\nlet num:integer=1\nlet text:string="x"\nlet root={f:typed,g:num}\nlet foreign={f:hostValue,g:text}\nlet a=root\nlet b=foreign\nlet c=root\na.f=hostValue\na={f:typed,g:num}\na=b\na=b\nlet out=c\nexit\n',
    HELD_MODES[0]!,
    64,
  );
  assert.deepEqual(
    [two.kind, two.sites.map(({ code, site }) => `${code} ${site}`)],
    ["unwitnessed", ["TSV041 0:186:187", "TSV041 0:190:191"]],
  );
  for (const mode of HELD_MODES) {
    const absent = stopRuns(
      unit("let blank: object? = null\nlet mirror = blank\nmirror.field = hostValue\nexit\n"),
      ["hostValue", "hostOther"],
      (make) => mode.run(make),
      16,
    );
    assert.deepEqual(
      [
        absent.natural.plan,
        absent.stopped.plan,
        absent.kind,
        absent.sites.map(({ code, site }) => `${code} ${site}`),
      ],
      [false, true, "unwitnessed", ["TSV043 0:45:57"]],
      mode.name,
    );
  }
  for (const mode of [HELD_MODES[1]!, HELD_MODES[3]!])
    assert.equal(corpus(operation("hostValue", "integer?"), mode, 64).kind, "open", mode.name);
  // (the two campaign items Codex r3 took for genuine escapes, C5c's, the two stores lacking properties of one object
  // (Codex r1 on #2185) and `all:new-cases-3::graph/899`: no stop of theirs publishes now, #2080 part 1 at their settled
  // stops and the plain gate before admission settled, #2080 part 2)
  for (const [source, globals, mode, demand, stop] of [
    [
      "let typed: list = [1]\nlet root = {h: {f: typed}}\nroot.q = root\nlet a = root.q\nlet seen = a.h.f\nexit\n",
      ["hostValue", "hostInit"],
      HELD_MODES[3]!,
      1,
      "work",
    ],
    [
      "let leaf: integer? = null\nlet root = {cell: leaf}\nlet lower = {left: root}\nlet upper = {right: lower}\nlower.spare = hostOther\nlet result = upper.right.left.cell\nsay result\nexit\n",
      ["hostValue", "hostOther", "hostInit"],
      HELD_MODES[0]!,
      1,
      "work",
    ],
    ["let root={x:1}\nroot.q=2\nroot.z=3\nexit\n", ["hostValue"], HELD_MODES[0]!, 1, "work"],
    [
      'let typed:object={x:1}\nlet num:integer=1\nlet text:string="x"\nlet root={f:typed,g:num}\nlet foreign={f:hostValue,g:text}\nlet a=root\nlet b=foreign\nlet c=root\na.q=b\nc=c\nc=b\nb=b\nlet out=c\nexit\n',
      ["hostValue", "hostOther", "hostInit"],
      HELD_MODES[2]!,
      64,
      "demand",
    ],
  ] as const) {
    const found = stopRuns(
      unit(source),
      globals,
      (make) => mode.run(make),
      demand,
      undefined,
      stop,
    );
    assert.deepEqual([found.kind, found.stopped.declined], ["declined", UNDECIDED], source);
  }
  // (two stores lacking properties of one object share its site, each its own error, Codex r1 on #2185: with the first
  // store's `requireExisting` dropped from the sibling's plan, a run passes it and fails at the second, so the first's
  // escape is open)
  for (const mode of HELD_MODES) {
    let dropped = false;
    const source = "let root={x:hostValue}\nroot.q=2\nroot.z=3\nexit\n";
    // (the sibling stores into the host value's properties, the same spans)
    const found = stopRuns(
      unit(source),
      ["hostValue"],
      (make) => mode.run(make),
      1,
      (plan) => ({
        ...plan,
        instructions: plan.instructions.map((instruction) => {
          if (dropped || instruction.kind !== "assign" || instruction.requireExisting !== true)
            return instruction;
          dropped = true;
          const { requireExisting: _, ...kept } = instruction;
          return kept;
        }),
      }),
      "work",
      { files: unit(source.replace("{x:hostValue}", "hostValue    ")), globals: ["hostValue"] },
    );
    assert.ok(dropped, mode.name);
    assert.deepEqual(
      [found.kind, found.sites.map(({ code, site }) => `${code} ${site}`)],
      ["open", ["TSV043 0:23:29", "TSV043 0:32:38"]],
      mode.name,
    );
  }
  // (one of the nine `later` campaign items, where the stopped run passed the store the natural plan rejects and failed
  // at the loop's own start: its decision stops in the restarted pass, which stops the analysis before admission
  // settled, and the plain gate declines it, #2080 part 2; the natural plan with its checks dropped passes the store and
  // fails at the loop's start, which takes no round)
  const later = stopRuns(
    unit(looping),
    ["hostValue", "hostOther", "hostInit"],
    (make) => HELD_MODES[2]!.run(make),
    64,
  );
  assert.deepEqual([later.kind, later.stopped.declined], ["declined", UNDECIDED]);
  assert.equal(
    stopRuns(
      unit(looping),
      ["hostValue", "hostOther", "hostInit"],
      (make) => HELD_MODES[2]!.run(make),
      1_000_000,
      (plan) => withoutTypeChecks(plan),
    ).kind,
    "later",
  );
});
