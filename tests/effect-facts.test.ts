import assert from "node:assert/strict";
import test from "node:test";

import type { DictMethodName } from "../src/dict-operations.js";
import {
  handleProperty,
  HANDLE_KINDS,
  type AnyHandleMethodName,
  type HandleKind,
  type HandlePropertyName,
} from "../src/handle-members.js";
import type {
  CORE_RUNTIME_BUILTINS,
  PLATFORM_STANDARD_LIBRARY_PRELUDE,
} from "../src/language-facts.js";
import type { ListMethodName, ListPropertyName } from "../src/list-methods.js";
import type { ExpressionPlan } from "../src/plan/model.js";
import {
  expressionEffects,
  functionEffects,
  methodEffects,
  writeDraws,
  type EffectFacts,
} from "../src/runtime/effect-facts.js";
import type { TemporalMethodName } from "../src/temporal-builtins.js";
import type { TextMethodName } from "../src/text-operations.js";

/*
 * What each built-in operation may do besides giving its value, as rollback of a paused draw, say staging, and operand
 * copies read it (src/runtime/effect-facts.ts). The tables are keyed by the names of the operations' contracts, so an
 * operation added to a contract needs its row here, and a contract that leaves out an effect fails its row.
 */

type Effect =
  "reads" | "draws" | "changes" | "draws, then changes" | "changes, then may draw" | "anything";

function effect(facts: EffectFacts): Effect {
  if (facts.changesValue && facts.changesState) return "anything";
  if (facts.changesValue && facts.draws)
    return facts.drawsAfterChange ? "changes, then may draw" : "draws, then changes";
  if (facts.changesValue) return "changes";
  return facts.draws ? "draws" : "reads";
}

/** Every method of lists and sets, dicts, text, date and time values, and handles, under one name on all of them. */
const METHODS: {
  readonly [
    Name in
      ListMethodName | DictMethodName | TextMethodName | TemporalMethodName | AnyHandleMethodName
  ]: Effect;
} = {
  add: "changes",
  addAll: "changes",
  remove: "changes",
  removeAt: "changes",
  removeFirst: "changes",
  removeLast: "changes",
  clear: "changes",
  sort: "changes",
  reverse: "changes",
  // A shuffle draws the new order, then puts the items in it.
  shuffle: "draws, then changes",
  // A timer's pause may end a round that is due, which draws the next one.
  pause: "changes, then may draw",
  resume: "changes",
  stop: "changes",
  capture: "reads",
  contains: "reads",
  count: "reads",
  difference: "reads",
  endsWith: "reads",
  find: "reads",
  findAll: "reads",
  formatDate: "reads",
  formatDateTime: "reads",
  formatTime: "reads",
  get: "reads",
  indexOf: "reads",
  intersection: "reads",
  join: "reads",
  lastIndexOf: "reads",
  lowercase: "reads",
  matches: "reads",
  padEnd: "reads",
  padStart: "reads",
  repeat: "reads",
  replace: "reads",
  split: "reads",
  startsWith: "reads",
  substring: "reads",
  take: "reads",
  takeLast: "reads",
  toAbsoluteDateTime: "reads",
  toDateTime: "reads",
  toISO: "reads",
  toList: "reads",
  toMilliseconds: "reads",
  toSeconds: "reads",
  toSet: "reads",
  trim: "reads",
  trimEnd: "reads",
  trimStart: "reads",
  union: "reads",
  uppercase: "reads",
  uppercaseFirst: "reads",
};

/** Every core function and Platform Standard Library function the engine runs itself. */
const FUNCTIONS: {
  readonly [
    Name in
      (typeof CORE_RUNTIME_BUILTINS)[number] | (typeof PLATFORM_STANDARD_LIBRARY_PRELUDE)[number]
  ]: Effect;
} = {
  random: "draws",
  chance: "draws",
  randomInteger: "draws",
  randomWeighted: "draws",
  randomNormal: "draws",
  randomBeta: "draws",
  randomPert: "draws",
  toString: "reads",
  toNumber: "reads",
  toInteger: "reads",
  toBoolean: "reads",
  toDate: "reads",
  toTime: "reads",
  toDateTime: "reads",
  toAbsoluteDateTime: "reads",
  toRegex: "reads",
  toJson: "reads",
  fromJson: "reads",
  toBase64: "reads",
  fromBase64: "reads",
  round: "reads",
  floor: "reads",
  ceil: "reads",
  abs: "reads",
  sign: "reads",
  sqrt: "reads",
  pow: "reads",
  mod: "reads",
  clamp: "reads",
  exp: "reads",
  ln: "reads",
  log10: "reads",
  sin: "reads",
  cos: "reads",
  tan: "reads",
  asin: "reads",
  acos: "reads",
  atan: "reads",
  atan2: "reads",
  toDeg: "reads",
  toRad: "reads",
  sum: "reads",
  average: "reads",
  median: "reads",
  percentile: "reads",
  stddev: "reads",
  min: "reads",
  max: "reads",
  linearRegression: "reads",
  predict: "reads",
  getDate: "reads",
  getTime: "reads",
  getDateTime: "reads",
  getAbsoluteDateTime: "reads",
  hashText: "reads",
  script: "reads",
  escapeMarkup: "reads",
  // They run as `fileStore` and `lock` instructions; a call of one in an expression may do anything.
  fileFromBase64: "anything",
  fileToBase64: "anything",
  hashFile: "anything",
  encryptText: "anything",
  encryptFile: "anything",
  decryptText: "anything",
  decryptFile: "anything",
};

/** Whether reading each property of lists and sets draws. */
const LIST_PROPERTY_DRAWS: { readonly [Name in ListPropertyName]: boolean } = {
  length: false,
  first: false,
  last: false,
  random: true,
};

/** Whether assigning each property of each kind of handle may draw: a timer's `remaining` may end its round. */
const HANDLE_PROPERTY_WRITE_DRAWS: {
  readonly [Kind in HandleKind]: { readonly [Name in HandlePropertyName<Kind>]: boolean };
} = {
  timer: {
    remaining: true,
    elapsed: false,
    display: false,
    label: false,
    state: false,
    repeatDuration: false,
  },
  media: {
    position: false,
    elapsed: false,
    remaining: false,
    duration: false,
    volume: false,
    state: false,
  },
  camera: { placement: false },
  messageHandle: { text: false },
  permanentButton: {},
};

const SPAN = { so: 0, sl: 0, sc: 0, eo: 0, el: 0, ec: 0 };

test("each method may do what its contracts say on every value that has it", () => {
  for (const [name, expected] of Object.entries(METHODS))
    assert.equal(effect(methodEffects(name)), expected, name);
  // A name no value has a method of may do anything.
  assert.equal(effect(methodEffects("frobnicate")), "anything");
});

test("each core function may do what its family or its own row says, and a host built-in anything", () => {
  for (const [name, expected] of Object.entries(FUNCTIONS))
    assert.equal(effect(functionEffects(name)), expected, name);
  assert.equal(effect(functionEffects("hostFunction")), "anything");
});

test("reading a property draws only as a list property, and assigning one only as a handle property that draws", () => {
  const read = (name: string): ExpressionPlan => ({
    kind: "property",
    object: { kind: "identifier", name: "value", span: SPAN },
    name,
    span: SPAN,
  });
  for (const [name, draws] of Object.entries(LIST_PROPERTY_DRAWS))
    assert.equal(effect(expressionEffects(read(name))), draws ? "draws" : "reads", name);
  assert.equal(effect(expressionEffects(read("name"))), "reads", "an object's field");
  for (const kind of HANDLE_KINDS) {
    for (const [name, draws] of Object.entries(HANDLE_PROPERTY_WRITE_DRAWS[kind])) {
      assert.equal(handleProperty(kind, name)?.draws === true, draws, `${kind}.${name}`);
      // A write is judged by its name alone, as any handle's property of that name may be written.
      if (draws) assert.equal(writeDraws(name), true, `${kind}.${name}`);
    }
  }
});
