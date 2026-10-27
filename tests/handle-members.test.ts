import assert from "node:assert/strict";
import test from "node:test";

import { argumentShapeProblem } from "../src/argument-rules.js";
import {
  HANDLE_KINDS,
  HANDLE_MEMBERS,
  handleMemberMessage,
  handleMethod,
  handleProperty,
  type HandleContract,
  type HandleKind,
  type HandleProperty,
  type HandleValueType,
} from "../src/handle-members.js";
import { compileSource, createRuntimeSession, type RuntimeSnapshot } from "../src/index.js";
import { describeShownValue, shownChoice } from "../src/runtime/values/value-types.js";
import { compileValidPlan } from "./helpers/compile-valid-plan.js";
import { createImmediatePacingRuntimeSnapshot } from "./helpers/immediate-pacing-runtime.js";

// Each kind of handle has one contract (`HANDLE_MEMBERS`), which the compiler and the runtime both read: every member
// works alike in both, and a problem with a member has the kind's code and one text, also where only the runtime sees it.

/** A script start that gives a handle of each kind in `h`. */
const HANDLES: Readonly<Record<HandleKind, string>> = {
  timer: 'let h = timer async 10 s "Clock"',
  media: 'let h = playAudio async "a.mp3"',
  camera: "let h = showCamera",
  messageHandle: 'let h = say("Hi", instant)',
  permanentButton: 'let h = showPermanentButton "B" { }',
};

/** A function of unknown result type, so the compiler does not know what a member of its result is. */
const PICK = "function pick(value) {\n    return value\n}\n";

/** A value of each type, and values a domain may take, of which a test uses the first it accepts. */
const SAMPLES: Readonly<Record<HandleValueType, readonly (string | number)[]>> = {
  duration: [],
  string: ["visible", "mystery", "window", "stage", "Hello"],
  number: [0.5, 1],
};

/** The source of a value of a type, or of the first sample that a property's domain takes. */
function valueOf(type: HandleValueType, property: HandleProperty): string {
  if (type === "duration") return "3 s";
  const domain = property.assign?.domain;
  const sample = SAMPLES[type].find((value) => domain?.accepts(value) ?? true)!;
  return typeof sample === "string" ? JSON.stringify(sample) : String(sample);
}

function typeName(type: HandleValueType, nullable: boolean): string {
  return `${type}${nullable ? "?" : ""}`;
}

/** The code, message, and source text of each diagnostic of `source`. */
function diagnostics(source: string): (readonly [string, string, string])[] {
  return compileSource(`${source}\nexit`).diagnostics.map(({ code, message, span }) => [
    code,
    message,
    source.slice(span.start.offset, span.end.offset),
  ]);
}

/** The state after running `source`, which compiles without diagnostics, while the Player loads any media it plays. */
function finalState(source: string): RuntimeSnapshot {
  const plan = compileValidPlan(`${source}\nexit`);
  const session = createRuntimeSession(plan, createImmediatePacingRuntimeSnapshot(plan));
  for (let step = 0; step < 10; step += 1) {
    session.run();
    const view = session.view();
    const unloaded = view.backgroundActions.find(
      (action) => action.kind === "media" && !action.media.loaded,
    );
    if (view.status !== "waiting" || unloaded?.kind !== "media") break;
    session.reportMediaLoad(unloaded.media.mediaId, { kind: "loaded", durationMs: 10_000 });
  }
  return session.exportSnapshot();
}

function failure(source: string): readonly [string, string] | null {
  const fault = finalState(source).failure;
  return fault === null ? null : [fault.code, fault.message];
}

function contract(kind: HandleKind): HandleContract {
  return HANDLE_MEMBERS[kind];
}

test("every property of a handle reads a value of its type and takes one where it can be assigned", () => {
  for (const kind of HANDLE_KINDS)
    for (const [name, property] of Object.entries(contract(kind).properties)) {
      const read = typeName(property.type, property.nullable === true);
      // The compiler gives a read its type, and the runtime a value of that type where the compiler cannot know it.
      const reads = `${PICK}${HANDLES[kind]}\nlet known: ${read} = h.${name}\nlet seen: ${read} = pick(h).${name}`;
      assert.equal(finalState(reads).status, "halted", `${kind}.${name}`);
      if (property.assign === undefined) continue;
      const value = valueOf(property.assign.type, property);
      for (const receiver of ["h", "pick(h)"]) {
        const assigns = `${PICK}${HANDLES[kind]}\n${receiver}.${name} = ${value}`;
        assert.equal(finalState(assigns).status, "halted", `${kind}: ${receiver}.${name}`);
      }
    }
});

test("every method of a handle takes no arguments and gives null", () => {
  for (const kind of HANDLE_KINDS)
    for (const [name, method] of Object.entries(contract(kind).methods)) {
      const calls = `${PICK}${HANDLES[kind]}\nlet known = h.${name}()\nlet seen: null = pick(h).${name}()`;
      assert.equal(finalState(calls).status, "halted", `${kind}.${name}`);
      const problem = argumentShapeProblem(name, method.shape, 1, [])!;
      assert.deepEqual(
        diagnostics(`${HANDLES[kind]}\nh.${name}(1)`),
        [[contract(kind).code, problem.message, name]],
        `${kind}.${name}(1)`,
      );
    }
});

test("a member that a handle does not have or cannot assign fails with one text when compiled and when run", () => {
  for (const kind of HANDLE_KINDS) {
    const { code, properties } = contract(kind);
    const read = handleMemberMessage(kind, "missing", "read");
    assert.deepEqual(diagnostics(`${HANDLES[kind]}\nsay h.missing`), [[code, read, "missing"]]);
    assert.deepEqual(failure(`${PICK}${HANDLES[kind]}\nsay pick(h).missing`), ["TSR017", read]);
    // Where the compiler does not know the receiver, a method that no value has is an error of its own, so the runtime
    // is asked for a method of another kind of handle, and for a list's, also where the receiver is checked before an
    // argument that waits.
    const other = HANDLE_KINDS.flatMap((handle) => Object.keys(contract(handle).methods)).find(
      (name) => handleMethod(kind, name) === undefined,
    )!;
    for (const [name, args] of [
      ["missing", "()"],
      [other, "()"],
      ["contains", "(1)"],
    ] as const) {
      const call = handleMemberMessage(kind, name, "call");
      assert.deepEqual(diagnostics(`${HANDLES[kind]}\nh.${name}${args}`), [[code, call, name]]);
      if (name !== "missing")
        assert.deepEqual(failure(`${PICK}${HANDLES[kind]}\npick(h).${name}${args}`), [
          "TSR016",
          call,
        ]);
    }
    assert.deepEqual(failure(`${PICK}${HANDLES[kind]}\npick(h).contains(say("x", 1 s))`), [
      "TSR016",
      handleMemberMessage(kind, "contains", "call"),
    ]);
    // A property that cannot be assigned, and one that it does not have.
    const fixed = Object.entries(properties).flatMap(([name, property]) =>
      property.assign === undefined ? [[name, valueOf(property.type, property)]] : [],
    );
    for (const [name, value] of [...fixed, ["missing", "1"]]) {
      const assign = handleMemberMessage(kind, name!, "assign");
      assert.deepEqual(diagnostics(`${HANDLES[kind]}\nh.${name} = ${value}`), [
        [code, assign, name],
      ]);
      // A kind without any property to assign fails before it is asked for one.
      if (fixed.length < Object.keys(properties).length)
        assert.deepEqual(failure(`${PICK}${HANDLES[kind]}\npick(h).${name} = ${value}`), [
          code,
          assign,
        ]);
    }
  }
});

test("a value outside a property's domain fails with the domain's text when compiled and when run", () => {
  let domains = 0;
  for (const kind of HANDLE_KINDS)
    for (const name of Object.keys(contract(kind).properties)) {
      const domain = handleProperty(kind, name)!.assign?.domain;
      if (domain === undefined) continue;
      domains += 1;
      const value = domain.known === "text" ? "big" : 2;
      assert.equal(domain.accepts(value), false);
      const message = domain.message(
        domain.shows === "choice" ? shownChoice(value) : describeShownValue(value),
      );
      const written = JSON.stringify(value);
      assert.deepEqual(diagnostics(`${HANDLES[kind]}\nh.${name} = ${written}`), [
        [contract(kind).code, message, written],
      ]);
      assert.deepEqual(failure(`${PICK}${HANDLES[kind]}\nh.${name} = pick(${written})`), [
        contract(kind).code,
        message,
      ]);
    }
  assert.ok(domains > 0);
});

test("every handle with a method of one name takes the same arguments", () => {
  // Timers and media share pause(), resume(), and stop(), and messages and permanent buttons remove(), so a receiver
  // whose type the compiler does not know is checked against any of them.
  for (const kind of HANDLE_KINDS)
    for (const name of Object.keys(contract(kind).methods))
      for (const other of HANDLE_KINDS) {
        const method = handleMethod(other, name);
        if (method !== undefined) assert.deepEqual(method.shape, handleMethod(kind, name)!.shape);
      }
});
