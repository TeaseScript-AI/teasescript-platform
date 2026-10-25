import assert from "node:assert/strict";
import test from "node:test";

import { DICT_METHODS, DICT_PROPERTIES, type DictMethod } from "../src/dict-operations.js";
import { HANDLE_MEMBERS } from "../src/handle-members.js";
import { LIST_METHODS, LIST_PROPERTIES, type ListMethod } from "../src/list-methods.js";
import {
  CALENDAR_DURATION_PARTS,
  hasTemporalField,
  hasTemporalMethod,
  TEMPORAL_FIELDS,
  TEMPORAL_KINDS,
  TEMPORAL_METHODS,
} from "../src/temporal-builtins.js";
import { TEXT_METHODS } from "../src/text-operations.js";
import { analyseCore } from "../src/type-inference/core/answers.js";
import { withConsumerOrder } from "../src/type-inference/core/consumers.js";
import { REASON } from "../src/type-inference/core/items.js";
import { withSolverSeam } from "../src/type-inference/core/solver.js";
import { coreRequest } from "./helpers/type-core-analysis.js";

/*
 * TABLE r4.47 (1), member completeness (#1026's follow-up): every built-in member the language's tables give a
 * receiver kind answers through the core, by its declared result or as the runtime's opaque `unknown` whose consumers
 * keep their checks, never with no items (a member with none made `repeat d.weekday {}` silently valid). Per pair, the
 * read's published items on the value side (a bound receiver) and through the contract (a function's result of two
 * returns), in both orders. The members whose results the core reads from the tables (the temporal fields, calendar
 * parts and methods, a range's `toList`) give exactly their declared kind.
 */

/** A receiver of each kind, as a script writes one. */
const SEEDS: Readonly<Record<string, string>> = {
  date: 'toDate("2026-10-04")',
  time: 'toTime("14:30")',
  datetime: 'toDateTime("2026-10-04T14:30")',
  absoluteDateTime: 'toAbsoluteDateTime("2026-10-04T12:30:00Z")',
  calendarDuration: "2 calendar days",
  list: '["s"]',
  set: 'set ["s"]',
  dict: 'dict {k: "s"}',
  string: '"sample"',
  range: "1..3",
  timer: "timer async 10 s {}",
  media: 'playAudio async "a.mp3"',
  camera: "showCamera",
  messageHandle: 'say("hello", 0 s)',
  permanentButton: 'showPermanentButton "Press" {}',
};

/** An argument of each parameter kind the tables name. */
const ARGUMENTS: Readonly<Record<string, string>> = {
  value: '"s"',
  list: '["s"]',
  collection: '["s"]',
  index: "0",
  count: "1",
  text: '"a"',
  textOrRegex: '"a"',
  regex: "/a/",
  position: "0",
};

const LISTS: readonly ListMethod[] = Object.values(LIST_METHODS);
const DICTS: readonly DictMethod[] = Object.values(DICT_METHODS);

interface Member {
  readonly receiver: string;
  readonly read: string;
  /** The declared kind the core reads from the tables, where it does. */
  readonly declared?: string;
}

function members(): Member[] {
  const out: Member[] = [];
  // a call with an argument per required parameter (a dict's key `"k"`), and a default where it takes one
  const call = (
    name: string,
    parameters: readonly {
      readonly name: string;
      readonly kind?: string;
      readonly optional?: true;
    }[],
    named?: readonly string[],
  ): string =>
    `${name}(${[
      ...parameters
        .filter((parameter) => parameter.optional !== true)
        .map((parameter) => (parameter.kind === undefined ? '"k"' : ARGUMENTS[parameter.kind]!)),
      ...(named === undefined ? [] : ['default: "s"']),
    ].join(", ")})`;
  for (const receiver of ["list", "set"]) {
    for (const name of Object.keys(LIST_PROPERTIES)) out.push({ receiver, read: name });
    for (const method of LISTS)
      if (method.receivers.some((kind) => kind === receiver))
        out.push({ receiver, read: call(method.name, method.parameters, method.named) });
  }
  for (const name of Object.keys(DICT_PROPERTIES)) out.push({ receiver: "dict", read: name });
  for (const method of DICTS)
    out.push({ receiver: "dict", read: call(method.name, method.parameters, method.named) });
  out.push({ receiver: "string", read: "length" });
  for (const [name, method] of Object.entries(TEXT_METHODS))
    out.push({ receiver: "string", read: call(name, method.parameters) });
  out.push({ receiver: "range", read: "toList()", declared: "list" });
  for (const receiver of TEMPORAL_KINDS) {
    for (const [name, field] of Object.entries(TEMPORAL_FIELDS))
      if (hasTemporalField(receiver, name))
        out.push({ receiver, read: name, declared: field.result });
    for (const [name, method] of Object.entries(TEMPORAL_METHODS))
      if (hasTemporalMethod(receiver, name))
        out.push({ receiver, read: `${name}()`, declared: method.result });
  }
  for (const [name, part] of Object.entries(CALENDAR_DURATION_PARTS))
    out.push({ receiver: "calendarDuration", read: name, declared: part.result });
  for (const [receiver, handle] of Object.entries(HANDLE_MEMBERS)) {
    for (const name of Object.keys(handle.properties)) out.push({ receiver, read: name });
    for (const name of Object.keys(handle.methods)) out.push({ receiver, read: `${name}()` });
  }
  return out;
}

test("every member a receiver kind has answers by its declared result or the runtime's, never with nothing", () => {
  const failing: string[] = [];
  for (const member of members()) {
    const seed = SEEDS[member.receiver]!;
    const read = `r.${member.read}`;
    const routes: readonly (readonly [string, string, string])[] = [
      ["bound", `let r = ${seed}\nsay ${read}\nexit`, read],
      [
        "result",
        `function make {\nlet r = ${seed}\nif askBoolean "pick" { return ${read} }\nreturn ${read}\n}\nlet v = make()\nsay v\nexit`,
        "v",
      ],
    ];
    for (const [route, source, text] of routes)
      for (const reversed of [false, true]) {
        const name = `${member.receiver}.${member.read} ${route}${reversed ? " reversed" : ""}`;
        const request = coreRequest([{ path: "main.tease", source }]);
        if (request === null) {
          failing.push(`${name}: does not parse or resolve`);
          continue;
        }
        const run = () => analyseCore(request);
        const answers = withSolverSeam({ reverseWorklist: reversed }, () =>
          reversed ? withConsumerOrder((list) => [...list].reverse(), run) : run(),
        );
        const node = answers.graph.nodes.find(
          (candidate) =>
            candidate.kind === "expression" &&
            candidate.span !== null &&
            source.slice(candidate.span.start.offset, candidate.span.end.offset) === text,
        );
        const items = (node === undefined ? null : answers.at(node))?.items.filter(
          (item) => item.tag !== "empty",
        );
        if (items === undefined || items.length === 0) failing.push(`${name}: no items`);
        else if (
          items.some((item) => item.tag === "unknown" && (item.reasons & REASON.external) !== 0)
        )
          failing.push(`${name}: external data`);
        else if (
          member.declared !== undefined &&
          (items.some((item) => item.tag !== member.declared) || items.length === 0)
        )
          failing.push(
            `${name}: ${items.map((item) => item.tag).join("|")}, not ${member.declared}`,
          );
      }
  }
  assert.deepEqual(failing, []);
});
