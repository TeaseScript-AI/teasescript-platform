import assert from "node:assert/strict";
import test from "node:test";
import type { InstructionPlan } from "../../../src/plan/model.js";
import { validateInstructionPlan } from "../../../src/plan/validation.js";
import { run } from "../../../src/runtime/engine.js";
import { completeAction } from "../../../src/runtime/operations/complete-action.js";
import {
  createCheckpoint,
  deserializeCheckpoint,
  serializeCheckpoint,
} from "../../../src/runtime/snapshot/checkpoint.js";
import type { RuntimeSnapshot } from "../../../src/runtime/snapshot/state.js";
import type { SerializableRuntimeValue } from "../../../src/runtime/values/serializable-values.js";
import { createImmediatePacingRuntimeSnapshot } from "../../helpers/immediate-pacing-runtime.js";
import { assertRuntimeResumeEquivalent } from "../../helpers/runtime-equivalence.js";
import {
  decision,
  contentOf,
  candidatePlan,
  legacyPlan,
  type Ran,
  summary,
  runWith,
  halted,
  failed,
  at,
  object,
  ran,
  planNodes,
  STORED,
} from "../../helpers/type-core/type-core-discharge-runtime-setup.js";

/*
 * The discharge map's new rows (the port plan's S3, step S7) through the candidate route, each in the three layers of
 * the runtime-check evidence rule (docs/TESTING.md): the core's obligation at its site; the plan content that carries
 * its check at the intended site, with its target and type; and runs through the public route, a fitting value reaching
 * the next effect and a violating one stopping at the check, with its TSR code there, before that effect. Every layer
 * in both orders of the core. Each row's legacy plan carries none of the content and runs as before (D7).
 */

/** The span of the line of `source` that starts with `text`, without its line break. */
function line(source: string, text: string): string {
  const start = source.startsWith(text) ? 0 : source.indexOf(`\n${text}`) + 1;
  return `${start}:${source.indexOf("\n", start)}`;
}

test("a store of a property its object may lack requires it, in three layers, in both orders (C5c, S3)", () => {
  // an unknown receiver, and an object some source lacks the property in
  const unknown = 'let x = hostValue\nx.n = 2\nsay "AFTER"\nexit\n';
  const some =
    'let room = [{count: 1}, {name: "hall"}][hostValue]\nroom.count = 2\nsay "AFTER"\nexit\n';
  for (const [source, receiver, store, target, fits, misses] of [
    [unknown, "x", "x.n = 2", "x.n", object({ n: 1 }), object({ m: 1 })],
    [some, "room", "room.count = 2", "room.count", 0, 1],
  ] as const) {
    // the whole access the store writes through
    const access = at(source, target);
    const known = decision(source);
    assert.ok(known.diagnostics.includes(`warning-runtime-check member-read @${access}`), source);
    assert.ok(known.checks.includes(`null-check ${receiver} [non-null] @${access}`), source);
    const plan = candidatePlan(source);
    assert.ok(contentOf(plan).includes(`requireExisting assign@${line(source, store)}`), source);
    assert.deepEqual(
      ran(runWith(plan, fits)),
      halted(["AFTER"]),
      `${source} with a fitting object`,
    );
    assert.deepEqual(
      ran(runWith(plan, misses)),
      failed(`TSR017@${at(source, target)}`),
      `${source} with an object that lacks the property`,
    );
    // the legacy plan adds the property, as it did
    assert.deepEqual(ran(runWith(legacyPlan(source), misses)), halted(["AFTER"]), source);
  }
  // a store every source has the property for needs no check; one no source has it for is the error at the literal
  assert.deepEqual(contentOf(candidatePlan("let room = {count: 1}\nroom.count = 2\nexit\n")), []);
  assert.deepEqual(decision('let room = {count: 1}\nroom.name = "x"\nexit\n').diagnostics, [
    "compile-error member-read @11:21",
  ]);
});

test("a copy that brings another type into a cycle of whole copies is checked where it meets the place, before what follows, in three layers, in both orders (A2, Codex r2 B2 on #1293)", () => {
  // `c` relays `b` and then `a` inside the cycle `c = b`, `c = a`, `b = c`, `a = b`: its own second store brings the
  // text `a.inner.inner.n` holds where `c.inner.inner.n` holds a whole number, read or not
  const source =
    'let good = {n: 1}\nlet bad = {n: "x"}\nlet a = {inner: {inner: bad}}\nlet b = {inner: {inner: good}}\n' +
    'let c = b\nc = a\nsay "AFTER"\nb = c\na = b\nexit\n';
  // (the copied `a` of `c = a`)
  const start = source.indexOf("c = a") + "c = ".length;
  const copy = `${start}:${start + 1}`;
  const known = decision(source);
  assert.ok(known.diagnostics.includes(`warning-runtime-check written-target @${copy}`));
  assert.ok(known.checks.includes(`copy-type c.inner.inner.n [integer] @${copy}`));
  // the copy stops the run with its check's error before the message that follows it
  assert.deepEqual(ran(runWith(candidatePlan(source), 0)), failed(`TSR058@${copy}`));
});

test("each read of a property one conditional replacement lacks is checked where it reads, in three layers, in both orders (C5c, #1167)", () => {
  const source =
    "let flag: boolean = hostValue\nlet room = {n: 1}\nroom = {n: 1}\nroom = {n: 1}\n" +
    'if flag { room = {other: 0} }\nsay room.n\nsay room.n\nsay "DONE"\nexit\n';
  const reads = [at(source, "room.n"), at(source, "room.n", 1)];
  const known = decision(source);
  for (const read of reads) {
    assert.ok(known.diagnostics.includes(`warning-runtime-check member-read @${read}`), read);
    assert.ok(known.checks.includes(`null-check room [non-null] @${read}`), read);
  }
  // the read's own check is the runtime's, on both plans: no S7 content
  const plan = candidatePlan(source);
  assert.deepEqual(contentOf(plan), []);
  for (const each of [plan, legacyPlan(source)]) {
    assert.deepEqual(ran(runWith(each, false)), halted(["1", "1", "DONE"]));
    assert.deepEqual(ran(runWith(each, true)), failed(`TSR017@${reads[0]}`));
  }
});

test("a list get rejects an index that is no whole number, in three layers, in both orders (C2, S3)", () => {
  const source = 'let xs = [1, 2]\nlet v = xs.get(hostValue, default: 0)\nsay "AFTER"\nexit\n';
  const index = at(source, "hostValue");
  const known = decision(source);
  assert.ok(known.diagnostics.includes(`warning-runtime-check integer-use @${index}`));
  assert.ok(known.checks.includes(`integer-check hostValue [integer] @${index}`));
  const plan = candidatePlan(source);
  assert.deepEqual(contentOf(plan), [
    `indexCheck call@${at(source, "xs.get(hostValue, default: 0)")}`,
  ]);
  assert.deepEqual(ran(runWith(plan, 1)), halted(["AFTER"]));
  // a whole number the list does not have still selects the default
  assert.deepEqual(ran(runWith(plan, 7)), halted(["AFTER"]));
  for (const bad of [1.5, "1", null])
    assert.deepEqual(ran(runWith(plan, bad)), failed(`TSR024@${index}`), JSON.stringify(bad));
  // the legacy plan selects the default for every index that is no position, as it did
  assert.deepEqual(ran(runWith(legacyPlan(source), 1.5)), halted(["AFTER"]));
});

test("a checked list get without its index fails the plan's and the checkpoint's validation, and a run of it reports the call's own error (Astra B3)", () => {
  const source = "let xs = [1]\nlet v = xs.get(hostValue, default: 0)\nsay v\nexit\n";
  const index = at(source, "hostValue");
  assert.ok(decision(source).checks.includes(`integer-check hostValue [integer] @${index}`));
  const plan = candidatePlan(source);
  assert.deepEqual(contentOf(plan), [
    `indexCheck call@${at(source, "xs.get(hostValue, default: 0)")}`,
  ]);
  assert.deepEqual(ran(runWith(plan, 0)), halted(["1"]));
  assert.deepEqual(ran(runWith(plan, 0.5)), failed(`TSR024@${index}`));
  // a plan from outside whose checked call lost its index: the plan's validation and the checkpoint's reject it
  const indexless = structuredClone(plan);
  const call = planNodes(indexless).find(
    (node) => node.kind === "call" && node.indexCheck === true,
  );
  assert.ok(call !== undefined);
  call.arguments = [];
  assert.ok(
    JSON.stringify(validateInstructionPlan(indexless).errors).includes(
      "Only a 'get' call with its index checks its index.",
    ),
  );
  const start = createImmediatePacingRuntimeSnapshot(plan, { globals: { hostValue: 0 } });
  assert.throws(
    () => deserializeCheckpoint(serializeCheckpoint(createCheckpoint(indexless, start))),
    (error) => error instanceof Error && !(error instanceof TypeError),
  );
  // a run given it validates it first: the same structured error, never a native one
  assert.throws(
    () => run(indexless, start),
    (error) =>
      error instanceof Error &&
      !(error instanceof TypeError) &&
      error.message.includes("Only a 'get' call with its index checks its index."),
  );
});

test("an otherwise's selected fallback is checked against the value's family, in three layers, in both orders (C10, S3)", () => {
  // the expression form, and the form whose fallback runs as instructions (a file store)
  const direct =
    'let amount = [1, null][1]\nlet result = amount otherwise hostValue\nsay "AFTER"\nexit\n';
  const lowered =
    'let amount = [1, null][1]\nlet result = amount otherwise fromJson(hostValue, default: null)\nsay "AFTER"\nexit\n';
  for (const [source, fallback, node, fits, bad, value] of [
    [direct, "hostValue", "binary", 3, "text", at(direct, "amount otherwise hostValue")],
    [
      lowered,
      "fromJson(hostValue, default: null)",
      "storeTemporary",
      "5",
      '"x"',
      at(lowered, "fromJson(hostValue, default: null)"),
    ],
  ] as const) {
    const site = at(source, fallback);
    const known = decision(source);
    assert.ok(known.diagnostics.includes(`warning-runtime-check written-target @${site}`), source);
    assert.ok(known.checks.includes(`copy-type ${fallback} [integer, number] @${site}`), source);
    const plan = candidatePlan(source);
    assert.ok(
      contentOf(plan).includes(
        `fallbackCheck ${node}@${node === "binary" ? value : site} integer|number`,
      ),
      `${source}: ${JSON.stringify(contentOf(plan))}`,
    );
    assert.deepEqual(ran(runWith(plan, fits)), halted(["AFTER"]), source);
    assert.deepEqual(ran(runWith(plan, bad)), failed(`TSR058@${site}`), source);
    // the legacy plan stores any fallback, as it did
    assert.deepEqual(ran(runWith(legacyPlan(source), bad)), halted(["AFTER"]), source);
  }
  // the instruction form across every boundary, a checkpoint round trip at each (the fallback's instructions)
  for (const [json, ending] of [
    ["5", "halted"],
    ['\\"x\\"', "failed"],
  ] as const) {
    const source = `let amount = [1, null][1]\nlet result = amount otherwise fromJson("${json}", default: null)\nsay "AFTER"\nexit\n`;
    assertRuntimeResumeEquivalent(source, { ending, transformPlan: () => candidatePlan(source) });
  }
});

/**
 * A run of `plan` with `hostValue` and the stored file, the Player answering each lock that it could not open, a
 * checkpoint round trip on both sides of each answer.
 */
function notOpened(plan: InstructionPlan, hostValue: SerializableRuntimeValue): Ran {
  const restored = (snapshot: RuntimeSnapshot): RuntimeSnapshot =>
    deserializeCheckpoint(serializeCheckpoint(createCheckpoint(plan, snapshot))).snapshot;
  let result = run(
    plan,
    createImmediatePacingRuntimeSnapshot(plan, { globals: { hostValue }, storedFiles: [STORED] }),
  );
  const events = [...result.events];
  for (let guard = 0; result.snapshot.status === "waiting"; guard += 1) {
    assert.ok(guard < 5, "the script keeps waiting");
    const snapshot = restored(result.snapshot);
    const action = snapshot.foregroundAction!;
    assert.equal(action.kind, "lock");
    const completed = completeAction(
      plan,
      snapshot,
      { actionId: action.actionId, actionKind: "lock", payload: { kind: "notOpened" } },
      { capturedMedia: { holds: () => true } },
    );
    assert.equal(completed.outcome.kind, "completed", JSON.stringify(completed.outcome));
    events.push(...completed.events);
    result = run(plan, restored(completed.snapshot));
    events.push(...result.events);
  }
  return summary(events, result.snapshot.status);
}

test("the default of fileFromBase64, decryptText and decryptFile is checked where it is selected, in three layers, in both orders (C10, S3)", () => {
  for (const call of [
    'fileFromBase64("!"',
    'decryptText("!", password: "pw"',
    `decryptFile("${STORED}", password: "pw"`,
  ]) {
    const source = `let value = ${call}, default: hostValue)\nsay "AFTER"\nexit\n`;
    const site = at(source, "hostValue");
    const known = decision(source);
    assert.ok(known.diagnostics.includes(`warning-runtime-check written-target @${site}`), source);
    assert.ok(known.checks.includes(`copy-type hostValue [string] @${site}`), source);
    const plan = candidatePlan(source);
    assert.ok(contentOf(plan).includes(`fallbackCheck storeTemporary@${site} string`), source);
    // `decryptFile` opens a stored file: the Player cannot, so the default is selected
    const play = call.startsWith("decryptFile")
      ? notOpened
      : (of: InstructionPlan, value: SerializableRuntimeValue) => ran(runWith(of, value));
    assert.deepEqual(play(plan, "abc"), halted(["AFTER"]), source);
    assert.deepEqual(play(plan, null), halted(["AFTER"]), source);
    assert.deepEqual(play(plan, 3), failed(`TSR058@${site}`), source);
    // the legacy plan takes any default, as it did
    assert.deepEqual(play(legacyPlan(source), 3), halted(["AFTER"]), source);
  }
});

test("a get's and a conversion's selected default is checked against the result's family, in three layers, in both orders (C10, S3)", () => {
  // (the conversion's text is loaded, so its run gives the default: known text that cannot convert is an error, #1105)
  for (const [source, fits, bad] of [
    ['let v = [1].get(5, default: hostValue)\nsay "AFTER"\nexit\n', 5, "text"],
    [
      'let n = toInteger(load("t", default: "x"), default: hostValue)\nsay "AFTER"\nexit\n',
      5,
      "text",
    ],
  ] as const) {
    const site = at(source, "hostValue");
    const known = decision(source);
    assert.ok(known.diagnostics.includes(`warning-runtime-check written-target @${site}`), source);
    assert.ok(known.checks.includes(`copy-type hostValue [integer, number] @${site}`), source);
    const plan = candidatePlan(source);
    const call = source.slice(8, source.indexOf("\n"));
    assert.ok(
      contentOf(plan).includes(`fallbackCheck call@${at(source, call)} integer|number`),
      source,
    );
    assert.deepEqual(ran(runWith(plan, fits)), halted(["AFTER"]), source);
    assert.deepEqual(ran(runWith(plan, bad)), failed(`TSR058@${site}`), source);
  }
});

test("a default named by its key path is checked where it is selected, also with no store around it, in three layers, in both orders (C10, #1538)", () => {
  // C10 names a default as every obligation names its value: an element read `xs.element`, a written dict's
  // entry `d.entry`, a `get`'s result by its receiver's element, never by its text; a nested default owes its own check,
  // and a default no literal holds that stands in for a collection is checked against that value's whole contract (ADR
  // 0021 7.2), whether the call's value is stored, stored into a written place (whose own check stays), or read at once
  const dict = (a: SerializableRuntimeValue): SerializableRuntimeValue => ({
    kind: "dict",
    entries: [{ key: "a", value: a }],
  });
  const list = (item: SerializableRuntimeValue): SerializableRuntimeValue => ({
    kind: "list",
    items: [item],
  });
  // whole numbers by the domain's provenance as the core answers it at a place (Codex r3, r4 on #1539): a written list,
  // its copy, a copy of a copy, a written element below an inferred carrier and a `get`'s value keep their written type;
  // a list no written type reaches, a literal's or an unwritten place's, is checked in C10's family, numbers too
  const wholeNumbers = (
    [
      ["", "[[1]].get(8, default: xs[0])", "list<integer|number>", 2.5, "bad"],
      [
        "let ints: integer[] = [1]\n",
        "[ints].get(8, default: xs[0])",
        "list<integer|number>",
        2.5,
        "bad",
      ],
      ["let rows = [[1]]\n", "rows.get(8, default: xs[0])", "list<integer|number>", 2.5, "bad"],
      [
        "let ints: integer[][] = [[1]]\nlet copy = ints\n",
        "copy.get(8, default: xs[0])",
        "list<integer>",
        2,
        2.5,
      ],
      [
        "let ints: integer[][] = [[1]]\nlet a = ints\nlet copy = a\n",
        "copy.get(8, default: xs[0])",
        "list<integer>",
        2,
        2.5,
      ],
      [
        "let ints: integer[] = [1]\nlet rows = [ints]\n",
        "rows.get(8, default: xs[0])",
        "list<integer>",
        2,
        2.5,
      ],
      [
        "let ints: integer[][] = [[1]]\n",
        "ints.get(8, default: null) otherwise xs[0]",
        "list<integer>",
        2,
        2.5,
      ],
      // through composition (Codex r5 on #1539): parentheses, and `otherwise` chains whose other operands bring no
      // collection, a written one, or an unwritten one
      ...(
        [
          ["(ints.get(8, default: null))", true],
          ["((ints.get(8, default: null)))", true],
          ["(ints.get(8, default: null) otherwise null)", true],
          ["(ints.get(8, default: null) otherwise copy.get(8, default: null))", true],
          ["(ints.get(8, default: null) otherwise rows.get(8, default: null))", true],
          ["((ints.get(8, default: null) otherwise null) otherwise null)", true],
          [
            "((ints.get(8, default: null) otherwise null) otherwise copy.get(8, default: null))",
            true,
          ],
          [
            "((ints.get(8, default: null) otherwise null) otherwise rows.get(8, default: null))",
            true,
          ],
        ] as const
      ).map(
        ([left, written]) =>
          [
            "let ints: integer[][] = [[1]]\nlet copy = ints\nlet rows = [[1]]\n",
            `${left} otherwise xs[0]`,
            written ? "list<integer>" : "list<integer|number>",
            written ? 2 : 2.5,
            written ? 2.5 : "bad",
          ] as const,
      ),
      // (operands of written types that differ, a chain as a `get`'s receiver: checked as the core admits the join where
      // it lands, `number` here, as the receiving check is, Codex r6)
      [
        "let ints: integer[][][] = [[[1]]]\nlet nums: number[][][] = [[[1]]]\n",
        "((nums.get(0, default: [[0]])) otherwise (ints.get(0, default: [[0]]))).get(8, default: xs[0])",
        "list<number>",
        2.5,
        "bad",
      ],
    ] as const
  ).map(([setup, call, type, fits, bad]) => ({ setup, call, type, fits, bad }));
  const rows: {
    readonly source: string;
    /** The default whose check fails, the name C10 gives it and the kinds it publishes there. */
    readonly fallback: string;
    readonly target: string;
    readonly against: string;
    /** The call that selects the outer default, and the check planned there. */
    readonly call: string;
    readonly type: string;
    readonly fits: SerializableRuntimeValue;
    readonly said: readonly string[];
    readonly bad: SerializableRuntimeValue;
  }[] = [
    {
      source:
        'let xs: list = [hostValue, 4]\nlet fixed: number[] = [1.5]\nsay "BEFORE"\nsay fixed.get(9, default: xs[0])\nsay "AFTER"\nexit\n',
      fallback: "xs[0]",
      target: "xs.element",
      against: "integer, number",
      call: "fixed.get(9, default: xs[0])",
      type: "integer|number",
      fits: 2.5,
      said: ["BEFORE", "2.5", "AFTER"],
      bad: "text",
    },
    {
      source:
        'let xs = hostValue\nlet counts: integer[] = [1]\nsay "BEFORE"\nrepeat counts.get(9, default: xs[0]) {\n  say "ok"\n}\nsay "AFTER"\nexit\n',
      fallback: "xs[0]",
      target: "xs.element",
      against: "integer, number",
      call: "counts.get(9, default: xs[0])",
      type: "integer|number",
      fits: list(2),
      said: ["BEFORE", "ok", "ok", "AFTER"],
      bad: list("text"),
    },
    {
      source:
        'let fixed: number[] = [1.5]\nlet d: dict = hostValue\nsay "BEFORE"\nsay fixed.get(9, default: d["a"])\nsay "AFTER"\nexit\n',
      fallback: 'd["a"]',
      target: "d.entry",
      against: "integer, number",
      call: 'fixed.get(9, default: d["a"])',
      type: "integer|number",
      fits: dict(2),
      said: ["BEFORE", "2", "AFTER"],
      bad: dict("text"),
    },
    {
      source:
        'let fixed: number[] = [1.5]\nlet xs: list = [hostValue]\nsay "BEFORE"\nsay fixed.get(9, default: xs.get(0, default: null))\nsay "AFTER"\nexit\n',
      fallback: "xs.get(0, default: null)",
      target: "xs.element",
      against: "integer, number",
      call: "fixed.get(9, default: xs.get(0, default: null))",
      type: "integer|number",
      fits: 2,
      said: ["BEFORE", "2", "AFTER"],
      bad: "text",
    },
    {
      source:
        'let xs = hostValue\nlet fixed: number[] = [1.5]\nsay "BEFORE"\nsay fixed.get(9, default: fixed.get(8, default: xs[0]))\nsay "AFTER"\nexit\n',
      fallback: "xs[0]",
      target: "xs.element",
      against: "integer, number",
      call: "fixed.get(9, default: fixed.get(8, default: xs[0]))",
      type: "integer|number",
      fits: list(2),
      said: ["BEFORE", "2", "AFTER"],
      bad: list("text"),
    },
    // a collection-valued default inside a literal one (named by the literal's text), and one whose receiver no place
    // holds (the core's answer for it)
    {
      source:
        'let xs: list = [hostValue]\nlet deep: number[][][] = [[[1.25]]]\nsay "BEFORE"\nlet r = deep.get(8, default: [xs[0]])\nsay r[0][0]\nsay "AFTER"\nexit\n',
      fallback: "[xs[0]]",
      target: "[xs[0]].element",
      against: "list",
      call: "deep.get(8, default: [xs[0]])",
      type: "list<list<number>|null>",
      fits: list(2.5),
      said: ["BEFORE", "2.5", "AFTER"],
      bad: list("bad"),
    },
    {
      source:
        'let xs: list = [hostValue]\nsay "BEFORE"\nlet r = [[1.25]].get(8, default: xs[0])\nsay r[0]\nsay "AFTER"\nexit\n',
      fallback: "xs[0]",
      target: "xs.element",
      against: "list",
      call: "[[1.25]].get(8, default: xs[0])",
      type: "list<number>",
      fits: list(2.5),
      said: ["BEFORE", "2.5", "AFTER"],
      bad: list("bad"),
    },
    ...wholeNumbers.map(({ setup, call, type, fits, bad }) => ({
      source: `let xs: list = [hostValue]\n${setup}say "BEFORE"\nlet r = ${call}\nsay r[0]\nsay "AFTER"\nexit\n`,
      fallback: "xs[0]",
      target: "xs.element",
      against: "list",
      call,
      type,
      fits: list(fits),
      said: ["BEFORE", String(fits), "AFTER"],
      bad: list(bad),
    })),
    // a collection-valued default, stored, stored into a written place, and read at once (Astra r1's B1 on #1539)
    ...(["list", "dict"] as const).flatMap((form) =>
      (
        [
          ["let r = ", "\nsay r[0]"],
          ["let r: number[] = ", "\nsay r[0]"],
          ["say ", "[0]"],
        ] as const
      ).map(([before, after]) => {
        const fallback = form === "list" ? "xs[0]" : 'd["a"]';
        const call = `fixed.get(8, default: ${fallback})`;
        return {
          source: `${form === "list" ? "let xs: list = [hostValue]" : "let d: dict = hostValue"}\nlet fixed: number[][] = [[1.25]]\nsay "BEFORE"\n${before}${call}${after}\nsay "AFTER"\nexit\n`,
          fallback,
          target: form === "list" ? "xs.element" : "d.entry",
          against: "list",
          call,
          type: "list<number>",
          fits: form === "list" ? list(2.5) : dict(list(2.5)),
          said: ["BEFORE", "2.5", "AFTER"],
          bad: form === "list" ? list("bad") : dict(list("bad")),
        };
      }),
    ),
  ];
  for (const { source, fallback, target, against, call, type, fits, said, bad } of rows) {
    const site = at(source, fallback);
    const known = decision(source);
    assert.ok(known.diagnostics.includes(`warning-runtime-check written-target @${site}`), source);
    assert.ok(known.checks.includes(`copy-type ${target} [${against}] @${site}`), source);
    const plan = candidatePlan(source);
    assert.ok(
      contentOf(plan).includes(
        `fallbackCheck ${call.endsWith(" otherwise xs[0]") ? "binary" : "call"}@${at(source, call)} ${type}`,
      ),
      `${source}: ${JSON.stringify(contentOf(plan))}`,
    );
    assert.deepEqual(ran(runWith(plan, fits)), halted(said), source);
    assert.deepEqual(ran(runWith(plan, bad)), failed(`TSR058@${site}`, ["BEFORE"]), source);
  }
  // the same default written out runs exactly where the host value the check takes does: C10's own where no written type
  // reaches the list, the receiving place's check where one does
  for (const { setup, call, fits } of wholeNumbers) {
    const out = call.replace("xs[0]", "[2.5]");
    const written = `${setup}say "BEFORE"\nlet r = ${out}\nsay r[0]\nsay "AFTER"\nexit\n`;
    assert.deepEqual(
      ran(runWith(candidatePlan(written), null)),
      fits === 2.5
        ? halted(["BEFORE", "2.5", "AFTER"])
        : failed(`TSR058@${at(written, out)}`, ["BEFORE"]),
      written,
    );
  }
});
