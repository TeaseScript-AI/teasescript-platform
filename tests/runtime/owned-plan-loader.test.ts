import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  CheckpointError,
  type CheckpointErrorInfo,
  compileProject,
  compileSource,
  createFreshRuntimeSession,
  deserializeCheckpoint,
  deserializeRuntimeSession,
  restoreRuntimeSession,
  loadInstructionPlan,
  restoreCheckpoint,
  serializeCheckpoint,
  validateInstructionPlan,
  type InstructionPlan,
  type InstructionPlanLoad,
  type ProjectSourceFile,
} from "../../src/index.js";
import {
  isValidatedImmutableInstructionPlan,
  markValidatedImmutableInstructionPlan,
} from "../../src/plan/validated-immutable.js";
import { createCapturedArray } from "../../src/external-data-capture.js";
import { validateCapturedInstructionPlan } from "../../src/plan/validation.js";
import { classifyCapturedRuntimeSnapshot } from "../../src/runtime/snapshot/snapshot-validation.js";
import { compileValidPlan } from "../helpers/compile-valid-plan.js";
import {
  ARRAY_ITERATOR_PROTOTYPE,
  type PrototypeChange,
  withPrototypeChange,
} from "../helpers/prototype-changes.js";
import { assertRuntimeResumeEquivalent } from "../helpers/runtime-equivalence.js";

/*
 * The owned plan loader (docs/RUNTIME.md "Low-level runtime route") must decide every JSON text as the external route,
 * `validateInstructionPlan(JSON.parse(text))`, does, with the same complete diagnostics, and run what it accepts as that
 * route and compiler output run. The fixtures together emit every instruction kind the validator knows.
 */

/** A project that emits the instruction kinds the repository's fixtures do not. */
const MIXED: readonly ProjectSourceFile[] = [
  {
    path: "main.tease",
    source: [
      "player.copyFrom(playerProfile)",
      "global visits = 0",
      "label again",
      'call "rooms/*.tease"',
      "goto later",
      'say "skipped"',
      "label later",
      "function twice(value: integer = visits + 1): integer {",
      "    return value * 2",
      "}",
      "let xs = [1, 2]",
      "xs.add(twice())",
      "let y = twice(twice(1))",
      'showPermanentButton "Stop" {',
      '    say "stopped"',
      "}",
      "if visits > 5 {",
      '    say "many"',
      "} else {",
      '    say "few"',
      "}",
      'playAudio "a.mp3"',
      "stopAudio",
      "showCamera",
      "hideCamera",
      "let photo = takePhoto()",
      'let file = fileFromBase64("aGk=", default: null)',
      "if visits < 2 {",
      "    goto again",
      "}",
      "exit",
    ].join("\n"),
  },
  { path: "rooms/a.tease", source: 'say "a"\nvisits += 1\nend\n' },
];

const FIXTURE_FILES = [
  "tests/fixtures/timers/authored-timers.tease",
  "tests/fixtures/packages/lock-kept/main.tease",
  "tests/fixtures/packages/passwords/main.tease",
  "tests/fixtures/packages/debug-failure/main.tease",
  "tests/fixtures/packages/updates/main.tease",
  "tests/fixtures/packages/photo-colour/main.tease",
];

/** Every kind `validateInstruction` accepts (src/plan/validation/instructions.ts). */
const INSTRUCTION_KINDS = [
  "declareSpeaker",
  "declareGlobal",
  "setDefaultSpeaker",
  "copyPlayerProfile",
  "enterScope",
  "leaveScope",
  "exit",
  "end",
  "goto",
  "transfer",
  "declareBinding",
  "prepareReference",
  "validateAssignmentTarget",
  "assign",
  "validateCallReceiver",
  "evaluate",
  "jumpIfFalse",
  "jump",
  "loopStart",
  "loopControl",
  "storeTemporary",
  "prepareSaySpeaker",
  "prepareSayContextualSpeaker",
  "prepareSayText",
  "prepareInteractionSpeaker",
  "clearTemporary",
  "clearTemporaries",
  "callFunction",
  "bindSuppliedParameter",
  "beginFunctionDefaults",
  "enterFunctionBody",
  "prepareParameterDefault",
  "bindDefaultParameter",
  "returnValue",
  "returnVoid",
  "say",
  "wait",
  "startTimer",
  "showImage",
  "showCamera",
  "hideCamera",
  "showPermanentButton",
  "storageWrite",
  "playMedia",
  "stopAudio",
  "interaction",
  "capture",
  "fileStore",
  "lock",
];

function mixedPlan(): InstructionPlan {
  const compiled = compileProject(MIXED);
  assert.deepEqual(
    compiled.diagnostics.map((diagnostic) => `${diagnostic.severity} ${diagnostic.code}`),
    ["warning TSV065"],
  );
  return compiled.plan!;
}

function fixturePlans(): ReadonlyMap<string, InstructionPlan> {
  const plans = new Map<string, InstructionPlan>([["mixed", mixedPlan()]]);
  for (const file of FIXTURE_FILES) {
    const compiled = compileSource(readFileSync(file, "utf8"));
    assert.notEqual(compiled.plan, null, file);
    plans.set(file, compiled.plan!);
  }
  return plans;
}

const PLANS = new Map(fixturePlans());
for (const [name, source] of [
  ["references", "let xs = [1, 2]\nxs[0] += 1\nxs[1] += 2\nexit"],
  [
    "rounds",
    [
      "function pick(value: integer = 2): integer {",
      "    return value + [1, 2, 3, 4, 5, 6].random",
      "}",
      "repeat 3 {",
      '    let answer = askChoice "left", "right"',
      '    say "${answer}: ${pick()}"',
      "    wait 1 s",
      "}",
      "exit",
    ].join("\n"),
  ],
] as const)
  PLANS.set(name, compileValidPlan(source));

type Decision =
  | { readonly kind: "valid"; readonly json: string }
  | { readonly kind: "invalid"; readonly errors: unknown }
  | { readonly kind: "unreadable" };

/** What the external route decides: `validateInstructionPlan` of what `JSON.parse` reads. */
function externalDecision(text: unknown): Decision {
  if (typeof text !== "string") return { kind: "unreadable" };
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { kind: "unreadable" };
  }
  const validation = validateInstructionPlan(parsed);
  return validation.valid
    ? { kind: "valid", json: JSON.stringify(parsed) }
    : { kind: "invalid", errors: validation.errors };
}

function ownedDecision(load: InstructionPlanLoad): Decision {
  switch (load.kind) {
    case "valid":
      return { kind: "valid", json: JSON.stringify(load.plan) };
    case "invalid":
      assert.equal(load.validation.valid, false);
      return { kind: "invalid", errors: load.validation.errors };
    case "unreadable":
      return { kind: "unreadable" };
  }
}

/** Loads `text` and asserts the external route's decision and diagnostics; returns the decision's kind. */
function assertSameDecision(text: unknown, name: string): Decision["kind"] {
  const load = loadInstructionPlan(text);
  const expected = externalDecision(text);
  assert.deepEqual(ownedDecision(load), expected, name);
  if (load.kind === "valid") {
    assert.ok(isValidatedImmutableInstructionPlan(load.plan), `${name}: marked`);
    assert.ok(Object.isFrozen(load.plan.instructions), `${name}: frozen`);
  }
  return expected.kind;
}

type Mutation = readonly [name: string, mutate: (plan: Record<string, unknown>) => void];

const ODD_VALUES: ReadonlyArray<readonly [string, unknown]> = [
  ["null", null],
  ["string", "x"],
  ["negative", -1],
  ["large", 9_999_999],
  ["object", { kind: "bad" }],
];

/**
 * Mutations of a parsed plan, by class: the root, unless `root` is false, and the first instruction of each kind not in
 * `covered`, which then holds it.
 */
function planMutations(
  plan: InstructionPlan,
  covered = new Set<string>(),
  root = true,
): Mutation[] {
  const mutations: Mutation[] = [];
  // EVIDENCE: fixture: a compiled plan's JSON is an object.
  const fields = root
    ? Object.keys(JSON.parse(JSON.stringify(plan)) as Record<string, unknown>)
    : [];
  for (const field of fields) {
    mutations.push([`root ${field} missing`, (p) => delete p[field]]);
    for (const [label, value] of ODD_VALUES)
      mutations.push([`root ${field} ${label}`, (p) => (p[field] = value)]);
  }
  if (root) {
    mutations.push(["root unknown field", (p) => (p.trusted = true)]);
    mutations.push(["older revision", (p) => (p.version = Number(p.version) - 1)]);
  }
  const instructionsOf = (p: Record<string, unknown>) =>
    // EVIDENCE: fixture: mutations apply to a copy of a compiled plan, whose instructions are an array of objects.
    p.instructions as Record<string, unknown>[];
  mutations.push(["instructions truncated", (p) => instructionsOf(p).pop()]);
  if (root) mutations.push(["instructions emptied", (p) => (p.instructions = [])]);
  plan.instructions.forEach((instruction, index) => {
    if (covered.has(instruction.kind)) return;
    covered.add(instruction.kind);
    const at = (p: Record<string, unknown>) => instructionsOf(p)[index]!;
    const kind = instruction.kind;
    mutations.push([`${kind} unknown kind`, (p) => (at(p).kind = "bad")]);
    mutations.push([`${kind} unknown field`, (p) => (at(p).extra = 1)]);
    for (const field of Object.keys(instruction)) {
      if (field === "kind") continue;
      mutations.push([`${kind}.${field} missing`, (p) => delete at(p)[field]]);
      for (const [label, value] of ODD_VALUES)
        mutations.push([`${kind}.${field} ${label}`, (p) => (at(p)[field] = value)]);
    }
  });
  return mutations;
}

/** Mutations of the JSON text that a parsed value cannot carry, or that `JSON.stringify` would erase. */
function textMutations(text: string): ReadonlyArray<readonly [string, string]> {
  const firstNumber = /"(so|temporaryCount|milliseconds|value)":(\d+)/;
  return [
    ["empty", ""],
    ["not JSON", "{plan}"],
    ...[0.1, 0.5, 0.9].map(
      (cut) => [`cut at ${cut}`, text.slice(0, Math.floor(text.length * cut))] as const,
    ),
    ["trailing garbage", `${text} x`],
    ["overflow temporaryCount", text.replace(/"temporaryCount":\d+/, '"temporaryCount":1e400')],
    ["overflow nested", text.replace(firstNumber, '"$1":-1e400')],
    ["overflow in unknown field", text.replace("{", '{"extra":{"value":1e400},"version":-1,')],
    [
      "overflow after an error",
      text.replace("{", '{"format":"bad",').replace(firstNumber, '"$1":1e400'),
    ],
    ["signed zero span", text.replace(/"so":\d+/, '"so":-0')],
    ["large span", text.replace(/"eo":\d+/, `"eo":${2 ** 53}`)],
    ["huge span", text.replace(/"eo":\d+/, '"eo":1e300')],
    ["own __proto__ at the root", text.replace("{", '{"__proto__":{"trusted":true},')],
    ["own __proto__ nested", text.replace('"span":{', '"span":{"__proto__":null,')],
    ["integer key", text.replace("{", '{"0":1,')],
    ["duplicate key, valid last", text.replace("{", '{"version":-1,')],
    ["duplicate key, invalid last", text.replace(/}$/, ',"temporaryCount":-1}')],
    ["unpaired surrogate", text.replace('"main.tease"', '"\\ud800.tease"')],
  ];
}

test("the owned loader decides every mutated plan as the external route does, with its complete diagnostics", () => {
  const kinds = new Set<string>();
  const decisions = new Map<string, number>();
  const count = (kind: Decision["kind"]) => decisions.set(kind, (decisions.get(kind) ?? 0) + 1);
  // The root's cases once, and each kind's at its first fixture: their decisions do not depend on the rest of the plan.
  const covered = new Set<string>();
  for (const [name, plan] of PLANS) {
    for (const instruction of plan.instructions) kinds.add(instruction.kind);
    const text = JSON.stringify(plan);
    count(assertSameDecision(text, `${name} unchanged`));
    for (const [mutation, mutate] of planMutations(plan, covered, name === "mixed")) {
      // EVIDENCE: fixture: `text` is a compiled plan's JSON, an object.
      const mutated = JSON.parse(text) as Record<string, unknown>;
      mutate(mutated);
      count(assertSameDecision(JSON.stringify(mutated), `${name}: ${mutation}`));
    }
    for (const [mutation, mutated] of textMutations(text))
      count(assertSameDecision(mutated, `${name}: ${mutation}`));
  }
  assert.deepEqual(
    [...kinds].sort(),
    [...INSTRUCTION_KINDS].sort(),
    "the fixtures emit every kind",
  );
  for (const value of [null, 5, true, ["{}"], { toString: () => "{}" }])
    assert.equal(assertSameDecision(value, `non-string ${String(value)}`), "unreadable");
  for (const kind of ["valid", "invalid", "unreadable"] as const)
    assert.ok((decisions.get(kind) ?? 0) > 0, `some cases are ${kind}`);
});

test("the owned loader keeps the external route's decision when Array.prototype methods are replaced", () => {
  const text = JSON.stringify(PLANS.get("mixed"));
  const native = Object.getOwnPropertyDescriptor(Array.prototype, "forEach")!;
  const forEach = Array.prototype.forEach;
  // Skips the plan's files, so that a plain parsed plan's files read as missing (Codex HEAD 0 review r1).
  Object.defineProperty(Array.prototype, "forEach", {
    ...native,
    value(this: unknown[], callback: (value: unknown, index: number, array: unknown[]) => void) {
      const first: unknown = this[0];
      if (typeof first === "object" && first !== null && Object.hasOwn(first, "sourceSpan")) return;
      forEach.call(this, callback);
    },
  });
  try {
    // Control: the replacement does change what plain parsed arrays validate as.
    assert.equal(validateCapturedInstructionPlan(JSON.parse(text)).valid, false);
    assert.equal(assertSameDecision(text, "replaced forEach"), "valid");
  } finally {
    Object.defineProperty(Array.prototype, "forEach", native);
  }
});

test("the owned loader reports reference-order errors as the external route does", () => {
  const plan = PLANS.get("references")!;
  const producers = plan.instructions.flatMap((instruction, pc) =>
    instruction.kind === "prepareReference" ? [pc] : [],
  );
  assert.ok(producers.length >= 2);
  const first = plan.instructions[producers[0]!]!;
  assert.equal(first.kind, "prepareReference");
  const id = first.kind === "prepareReference" ? first.destinationTemporary : -1;
  const consumer = plan.instructions.findIndex(
    (instruction, pc) =>
      pc > producers[0]! &&
      JSON.stringify(instruction).includes(`"kind":"preparedReference","temporaryId":${id}`),
  );
  assert.ok(consumer > producers[0]!);
  const cases: Mutation[] = [
    [
      "duplicate producer",
      (p) => {
        // EVIDENCE: fixture: a copy of a compiled plan, whose instructions are an array of objects.
        const instructions = p.instructions as Record<string, unknown>[];
        instructions[producers[1]!]!.destinationTemporary = id;
      },
    ],
    [
      "use before its producer",
      (p) => {
        // EVIDENCE: fixture: a copy of a compiled plan, whose instructions are an array of objects.
        const instructions = p.instructions as Record<string, unknown>[];
        [instructions[producers[0]!], instructions[consumer]] = [
          instructions[consumer]!,
          instructions[producers[0]!]!,
        ];
      },
    ],
  ];
  for (const [name, mutate] of cases) {
    // EVIDENCE: fixture: a compiled plan's JSON is an object.
    const mutated = JSON.parse(JSON.stringify(plan)) as Record<string, unknown>;
    mutate(mutated);
    assert.equal(assertSameDecision(JSON.stringify(mutated), name), "invalid");
  }
});

test("a loaded plan plays through input, time, random draws and restores as the compiled plan and the external route do", () => {
  const plan = PLANS.get("rounds")!;
  const text = JSON.stringify(plan);
  const load = loadInstructionPlan(text);
  assert.equal(load.kind, "valid");
  if (load.kind !== "valid") return;
  const fresh = { seed: 112, baseDelayMs: 0, delayPerWordMs: 0, delayPerCharacterMs: 0 };
  // EVIDENCE: fixture: `text` is a compiled plan's JSON; the session captures and validates it.
  const external = JSON.parse(text) as InstructionPlan;
  let sessions = [plan, load.plan, external].map((p) => createFreshRuntimeSession(p, fresh));
  const same = (values: readonly unknown[], label: string) => {
    for (const value of values.slice(1))
      assert.equal(JSON.stringify(value), JSON.stringify(values[0]), label);
  };
  let [choices, observations] = [0, 0];
  for (let step = 0; sessions[0]!.view().status !== "halted"; step += 1) {
    assert.ok(step < 400, "the script ends");
    same(
      sessions.map((session) => [session.view(), session.exportSnapshot()]),
      `state ${step}`,
    );
    const view = sessions[0]!.view();
    const action = view.foregroundAction;
    let results: unknown[];
    if (view.status !== "waiting")
      results = sessions.map((session) => session.executeInstruction());
    else if (action?.kind === "interaction") {
      const request = {
        actionId: action.actionId,
        actionKind: "interaction",
        interactionKind: "choice",
        payload: { kind: "selectedOption", optionIndex: choices % 2 },
      } as const;
      results = sessions.map((session) => session.completeAction(request));
      choices += 1;
    } else {
      results = sessions.map((session) => session.observeTime(view.currentSessionTimeMs + 1_000));
      observations += 1;
    }
    same(results, `result ${step}`);
    // Every boundary continues from a restored checkpoint, by text for the first two and as data for the third.
    const saved = sessions.map((session) => serializeCheckpoint(session.exportCheckpoint()));
    same(saved, `checkpoint ${step}`);
    sessions = [
      deserializeRuntimeSession(saved[0]!),
      deserializeRuntimeSession(saved[1]!),
      restoreRuntimeSession(JSON.parse(saved[2]!)),
    ];
  }
  assert.deepEqual([choices, observations], [3, 3]);
});

test("a loaded plan runs exactly as the compiled plan and the external route's plan do", () => {
  for (const [name, plan] of PLANS) {
    const text = JSON.stringify(plan);
    const load = loadInstructionPlan(text);
    assert.equal(load.kind, "valid", name);
    if (load.kind !== "valid") continue;
    const loaded = load.plan;
    assert.equal(JSON.stringify(loaded), text, `${name}: same plan`);
    const fresh = { seed: 11, wallClockMs: Date.UTC(2026, 10, 5, 12) };
    // EVIDENCE: fixture: `text` is a compiled plan's JSON; the session captures and validates it.
    const external = JSON.parse(text) as InstructionPlan;
    const sessions = [plan, loaded, external].map((p) => createFreshRuntimeSession(p, fresh));
    // Runtime entry points reuse the loaded plan; a caller's parsed object is still captured.
    assert.equal(sessions[1]!.plan, loaded, `${name}: no recapture`);
    assert.notEqual(sessions[2]!.plan, external, `${name}: caller data captured`);
    const results = sessions.map((session) => session.run({ instructionBudget: 2_000 }));
    const state = (index: number) =>
      JSON.stringify([results[index], sessions[index]!.view(), sessions[index]!.exportSnapshot()]);
    assert.equal(state(1), state(0), `${name}: loaded runs as compiled`);
    assert.deepEqual(
      [results[1], sessions[1]!.view(), sessions[1]!.exportSnapshot()],
      [results[2], sessions[2]!.view(), sessions[2]!.exportSnapshot()],
      `${name}: loaded runs as the external route`,
    );
    // The first save writes the same bytes, and the restored sessions continue alike.
    const saved = sessions.map((session) => serializeCheckpoint(session.exportCheckpoint()));
    assert.equal(saved[1], saved[0], `${name}: first-save bytes`);
    assert.equal(saved[2], saved[0], `${name}: external first-save bytes`);
    const tails = saved.map((json) =>
      deserializeRuntimeSession(json).run({ instructionBudget: 2_000 }),
    );
    assert.equal(JSON.stringify(tails[1]), JSON.stringify(tails[0]), `${name}: restored tails`);
  }
});

test("a loaded plan keeps resume equivalence at every boundary", () => {
  // The camera, photo and file lines wait for the Player, which the helper does not simulate.
  const main = MIXED[0]!.source;
  const resumable = [
    {
      path: "main.tease",
      source: main.slice(0, main.indexOf("showCamera")) + main.slice(main.indexOf("if visits < 2")),
    },
    MIXED[1]!,
  ];
  assertRuntimeResumeEquivalent(resumable, {
    warnings: ["TSV065"],
    instructionGuard: 4_000,
    mediaDurationMs: 1_000,
    transformPlan: (plan) => {
      const load = loadInstructionPlan(JSON.stringify(plan));
      assert.equal(load.kind, "valid");
      return load.kind === "valid" ? load.plan : plan;
    },
  });
});

/** What `restoreCheckpoint` of the parsed text gives: its checkpoint's bytes or its error, or `null` for no JSON. */
type CheckpointOutcome = string | CheckpointErrorInfo | null;

function externalCheckpoint(text: string): CheckpointOutcome {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  try {
    return serializeCheckpoint(restoreCheckpoint(parsed));
  } catch (error) {
    if (!(error instanceof CheckpointError)) throw error;
    return error.info;
  }
}

function ownedCheckpoint(text: string): CheckpointOutcome {
  try {
    return serializeCheckpoint(deserializeCheckpoint(text));
  } catch (error) {
    if (!(error instanceof CheckpointError)) throw error;
    return error.info.code === "TSK003" ? null : error.info;
  }
}

/** A checkpoint of the mixed project after its first stop, so that its snapshot holds frames, calls and buttons. */
function mixedCheckpointText(): string {
  const session = createFreshRuntimeSession(PLANS.get("mixed")!, { seed: 3 });
  session.run({ instructionBudget: 2_000 });
  return serializeCheckpoint(session.exportCheckpoint());
}

test("checkpoint text is decided as the external route decides its parsed data", () => {
  const text = mixedCheckpointText();
  const cases: Array<readonly [string, string]> = [["unchanged", text]];
  // EVIDENCE: fixture: `text` is a checkpoint the engine wrote.
  const checkpoint = JSON.parse(text) as {
    plan: Record<string, unknown>;
    snapshot: Record<string, unknown>;
  };
  // One case of each plan mutation class, not every kind again.
  const classes = new Set<string>();
  for (const [name, mutate] of planMutations(PLANS.get("mixed")!)) {
    const kind = name.replace(/^\S+ /, "");
    if (classes.has(kind)) continue;
    classes.add(kind);
    const mutated = structuredClone(checkpoint);
    mutate(mutated.plan);
    cases.push([`plan ${name}`, JSON.stringify(mutated)]);
  }
  const snapshotAt = text.indexOf('"snapshot":');
  const [head, snapshot] = [text.slice(0, snapshotAt), text.slice(snapshotAt)];
  for (const field of Object.keys(checkpoint.snapshot)) {
    for (const [label, value] of ODD_VALUES) {
      const mutated = structuredClone(checkpoint);
      mutated.snapshot[field] = value;
      cases.push([`snapshot ${field} ${label}`, JSON.stringify(mutated)]);
    }
  }
  const numeric = new Set([...snapshot.matchAll(/"(\w+)":-?\d/g)].map((match) => match[1]!));
  for (const field of numeric)
    cases.push([
      `snapshot ${field} overflow`,
      head + snapshot.replace(new RegExp(`"${field}":-?\\d+(\\.\\d+)?`), `"${field}":1e400`),
    ]);
  cases.push(["plan overflow", text.replace(/"temporaryCount":\d+/, '"temporaryCount":1e400')]);
  cases.push(["envelope overflow", text.replace(/"version":\d+/, '"version":1e400')]);
  cases.push(["cut", text.slice(0, text.length >> 1)]);
  for (const [name, mutated] of cases)
    assert.deepEqual(ownedCheckpoint(mutated), externalCheckpoint(mutated), name);
  assert.equal(typeof ownedCheckpoint(text), "string");
  assert.ok(numeric.has("version") && numeric.has("currentSessionTimeMs"));
});

test("a non-finite number in checkpoint text comes before the plan's and the snapshot's other errors", () => {
  const OVERFLOW = "OVERFLOW_PLACEHOLDER";
  // EVIDENCE: fixture: a checkpoint the engine wrote, with its plan and snapshot.
  const checkpoint = JSON.parse(mixedCheckpointText()) as {
    plan: Record<string, unknown>;
    snapshot: Record<string, unknown>;
  };
  const text = (change: (copy: typeof checkpoint) => void) => {
    const copy = structuredClone(checkpoint);
    change(copy);
    return JSON.stringify(copy).replace(`"${OVERFLOW}"`, "1e400");
  };
  const nonFinite = (path: string) => ({
    code: "TSK002",
    message: "Checkpoint contains a non-finite number.",
    path,
  });
  const cases = [
    ["plan format", text((c) => (c.plan.format = OVERFLOW)), nonFinite("$.plan.format")],
    ["plan revision", text((c) => (c.plan.version = OVERFLOW)), nonFinite("$.plan.version")],
    ["snapshot format", text((c) => (c.snapshot.format = OVERFLOW)), nonFinite("$.snapshot")],
    ["snapshot revision", text((c) => (c.snapshot.version = OVERFLOW)), nonFinite("$.snapshot")],
    [
      "plan of another format with an overflow",
      text((c) => {
        c.plan.format = "other";
        c.plan.temporaryCount = OVERFLOW;
      }),
      nonFinite("$.plan.temporaryCount"),
    ],
    [
      "snapshot of another revision with an overflow",
      text((c) => {
        c.snapshot.version = 99;
        c.snapshot.nextInstruction = OVERFLOW;
      }),
      nonFinite("$.snapshot"),
    ],
    [
      "plan of another format, snapshot with an overflow",
      text((c) => {
        c.plan.format = "other";
        c.snapshot.nextInstruction = OVERFLOW;
      }),
      { code: "TSK001", message: "Unsupported instruction-plan format.", path: "$.plan.format" },
    ],
  ] as const;
  for (const [name, mutated, expected] of cases) {
    assert.ok(mutated.includes("1e400"), name);
    assert.deepEqual(ownedCheckpoint(mutated), expected, name);
    assert.deepEqual(externalCheckpoint(mutated), expected, name);
  }
});

test("checkpoint text keeps the external route's decision when Array.prototype methods are replaced", () => {
  const text = mixedCheckpointText().replace(
    '"warnedSpeakerIds":[]',
    '"warnedSpeakerIds":[987654]',
  );
  assert.ok(text.includes("987654"));
  const native = Object.getOwnPropertyDescriptor(Array.prototype, "some")!;
  Object.defineProperty(Array.prototype, "some", { ...native, value: () => false });
  try {
    // Control: the replacement lets a plain parsed snapshot's malformed list pass.
    // EVIDENCE: fixture: `text` is a checkpoint the engine wrote, with its plan and snapshot.
    const plain = JSON.parse(text) as { snapshot: unknown };
    assert.equal(
      classifyCapturedRuntimeSnapshot(plain.snapshot, PLANS.get("mixed")!).validation.valid,
      true,
    );
    const owned = ownedCheckpoint(text);
    assert.deepEqual(owned, externalCheckpoint(text));
    assert.equal(typeof owned === "object" && owned !== null ? owned.code : owned, "TSK002");
  } finally {
    Object.defineProperty(Array.prototype, "some", native);
  }
});

test("loaded plan and checkpoint text give a wholly frozen plan or none when Array.prototype is changed", () => {
  // A small plan: the larger fixtures' validation itself fails under these changes, which is not defended.
  const plan = compileValidPlan('let xs = [1, 2]\nxs.add(3)\nsay "${xs.length}"\nwait 1 s\nexit');
  const planText = JSON.stringify(plan);
  const session = createFreshRuntimeSession(plan, { seed: 3 });
  session.run({ instructionBudget: 2_000 });
  const checkpointText = serializeCheckpoint(session.exportCheckpoint());
  const capturedArrayPrototype: unknown = Object.getPrototypeOf(createCapturedArray(0));
  /** Its containers that are not frozen, and its arrays not on capture's prototype. */
  const shape = (root: unknown) => {
    let unfrozen = 0;
    let ambientArrays = 0;
    const pending = [root];
    while (pending.length > 0) {
      const value = pending.pop();
      if (typeof value !== "object" || value === null) continue;
      if (!Object.isFrozen(value)) unfrozen += 1;
      if (Array.isArray(value) && Object.getPrototypeOf(value) !== capturedArrayPrototype) {
        ambientArrays += 1;
      }
      pending.push(...Object.values(value));
    }
    return { unfrozen, ambientArrays };
  };
  // Run while changed; `outcome` describes the results once the native properties are back. Validating a plan's
  // content under changed intrinsics is not defended: a route may then reject, but never register a part-frozen plan.
  const rejected = <T>(route: () => T): T | "rejected" => {
    try {
      return route();
    } catch {
      return "rejected";
    }
  };
  const run = () => {
    // A plan frozen at its root only must not be registered as immutable.
    const partial: InstructionPlan = Object.freeze(JSON.parse(planText));
    markValidatedImmutableInstructionPlan(partial);
    return {
      load: rejected(() => loadInstructionPlan(planText)),
      checkpoint: rejected(() => deserializeCheckpoint(checkpointText)),
      partial,
    };
  };
  const outcome = (result: ReturnType<typeof run>) => {
    const { load, checkpoint } = result;
    return {
      load:
        load === "rejected" || load.kind !== "valid"
          ? "rejected"
          : {
              json: JSON.stringify(load.plan) === planText,
              registered: isValidatedImmutableInstructionPlan(load.plan),
              ...shape(load.plan),
            },
      checkpoint:
        checkpoint === "rejected"
          ? "rejected"
          : {
              json: serializeCheckpoint(checkpoint) === checkpointText,
              registered: isValidatedImmutableInstructionPlan(checkpoint.plan),
              plan: shape(checkpoint.plan),
              snapshotAmbientArrays: shape(checkpoint.snapshot).ambientArrays,
            },
      partialRegistered: isValidatedImmutableInstructionPlan(result.partial),
    };
  };
  const native = outcome(run());
  // Natively the whole plan is frozen, on capture's prototype and registered; a partly frozen one is not.
  const frozenPlan = { unfrozen: 0, ambientArrays: 0 };
  assert.deepEqual(native.load, { json: true, registered: true, ...frozenPlan });
  const nativeCheckpoint = native.checkpoint;
  assert.ok(typeof nativeCheckpoint !== "string", "the checkpoint loads natively");
  assert.deepEqual(nativeCheckpoint, {
    json: true,
    registered: true,
    plan: frozenPlan,
    snapshotAmbientArrays: nativeCheckpoint.snapshotAmbientArrays,
  });
  assert.equal(native.partialRegistered, false);
  const changes: ReadonlyArray<readonly [string, PrototypeChange, () => boolean]> = [
    [
      "push not adding",
      [
        [
          Array.prototype,
          "push",
          function (this: unknown[]) {
            return this.length;
          },
        ],
      ],
      () => [0].push(1) === 1,
    ],
    [
      "iterator ending at once",
      [[ARRAY_ITERATOR_PROTOTYPE, "next", () => ({ done: true, value: undefined })]],
      // oxlint-disable-next-line unicorn/no-useless-spread -- EVIDENCE: fixture: spreading `[1]` runs the array iterator this case replaces.
      () => [...[1]].length === 0,
    ],
  ];
  for (const [name, change, bites] of changes) {
    const { bit, result } = withPrototypeChange(change, bites, run);
    assert.ok(bit, `${name} bites`);
    const changed = outcome(result);
    if (changed.load !== "rejected") assert.deepEqual(changed.load, native.load, name);
    if (changed.checkpoint !== "rejected")
      assert.deepEqual(changed.checkpoint, native.checkpoint, name);
    assert.equal(changed.partialRegistered, false, name);
  }
});
