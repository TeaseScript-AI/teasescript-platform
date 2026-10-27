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
import { analyseCore, coreResult } from "../src/type-inference/core/answers.js";
import { withConsumerOrder } from "../src/type-inference/core/consumers.js";
import { REASON } from "../src/type-inference/core/items.js";
import { coreRecord } from "../src/type-inference/core/result.js";
import { withSolverSeam } from "../src/type-inference/core/solver.js";
import { coreRequest } from "./helpers/type-core-analysis.js";

/*
 * TABLE r4.47 (1), member completeness (#1026's follow-up): every built-in member the language's tables give a
 * receiver kind answers through the core, by its declared result or as the runtime's opaque `unknown` whose consumers
 * keep their checks, never with no items (a member with none made `repeat d.weekday {}` silently valid). Per pair,
 * on the value side (a bound receiver) and through the contract (a function's result of two returns), in both orders:
 * the read's published items, and a consumer its declared result's kind requires (a count for a whole number, a written
 * place of its kind otherwise, a collection's element through `first`), which never errs. The members whose results the
 * core reads from the tables (the temporal fields, calendar parts and methods, a range's `toList` and its elements)
 * give exactly their declared kind.
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

/** A member's declared result: its kind, `null` beside it where it may be, and a collection's element. */
interface Result {
  readonly kind: string;
  readonly nullable?: true;
  readonly element?: Result;
}

interface Member {
  readonly receiver: string;
  readonly read: string;
  readonly result: Result;
  /** The members whose results the core reads from the tables: their exact kind, and their element's. */
  readonly exact?: true;
}

/** A table's result as a kind, on a receiver of `receiver` whose elements are text (the seeds'). */
function resultOf(declared: string, receiver: string): Result {
  const text: Result = { kind: "string" };
  switch (declared) {
    case "element":
    case "value":
      return text;
    case "same":
      return { kind: receiver, element: text };
    case "list":
    case "set":
      return { kind: declared, element: text };
    case "string[]":
      return { kind: "list", element: text };
    case "string?[]?":
      return { kind: "list", nullable: true, element: { kind: "string", nullable: true } };
    default:
      return declared.endsWith("?")
        ? { kind: declared.slice(0, -1), nullable: true }
        : { kind: declared };
  }
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
    for (const [name, property] of Object.entries(LIST_PROPERTIES))
      out.push({
        receiver,
        read: name,
        result: resultOf(property.gives === "length" ? "integer" : "element", receiver),
      });
    for (const method of LISTS)
      if (method.receivers.some((kind) => kind === receiver))
        out.push({
          receiver,
          read: call(method.name, method.parameters, method.named),
          result: resultOf(method.result, receiver),
        });
  }
  for (const [name, property] of Object.entries(DICT_PROPERTIES))
    out.push({
      receiver: "dict",
      read: name,
      result: resultOf(property.gives === "length" ? "integer" : "list", "dict"),
    });
  for (const method of DICTS)
    out.push({
      receiver: "dict",
      read: call(method.name, method.parameters, method.named),
      result: resultOf(method.result, "dict"),
    });
  out.push({ receiver: "string", read: "length", result: { kind: "integer" } });
  for (const [name, method] of Object.entries(TEXT_METHODS))
    out.push({
      receiver: "string",
      read: call(name, method.parameters),
      result: resultOf(method.result, "string"),
    });
  out.push({
    receiver: "range",
    read: "toList()",
    result: { kind: "list", element: { kind: "integer" } },
    exact: true,
  });
  for (const receiver of TEMPORAL_KINDS) {
    for (const [name, field] of Object.entries(TEMPORAL_FIELDS))
      if (hasTemporalField(receiver, name))
        out.push({ receiver, read: name, result: { kind: field.result }, exact: true });
    for (const [name, method] of Object.entries(TEMPORAL_METHODS))
      if (hasTemporalMethod(receiver, name))
        out.push({ receiver, read: `${name}()`, result: { kind: method.result }, exact: true });
  }
  for (const [name, part] of Object.entries(CALENDAR_DURATION_PARTS))
    out.push({
      receiver: "calendarDuration",
      read: name,
      result: { kind: part.result },
      exact: true,
    });
  for (const [receiver, handle] of Object.entries(HANDLE_MEMBERS)) {
    for (const [name, property] of Object.entries(handle.properties))
      out.push({
        receiver,
        read: name,
        result: { kind: property.type, ...(property.nullable === true ? { nullable: true } : {}) },
      });
    for (const [name, method] of Object.entries(handle.methods))
      out.push({ receiver, read: `${name}()`, result: { kind: method.result } });
  }
  return out;
}

/**
 * The consumer a result's kind requires (C2, C1): a count for a whole number, a written place of its kind otherwise;
 * a collection's element through `first` into its own consumer. With the collection read and its element read.
 */
function consumed(
  read: string,
  result: Result,
): { readonly statement: string; readonly value: string; readonly collection?: string } {
  if (result.element !== undefined) {
    const collection = result.nullable === true ? `(${read} otherwise [])` : read;
    const element = consumed(`${collection}.first`, result.element);
    return { ...element, collection };
  }
  return {
    statement:
      result.kind === "integer" && result.nullable !== true
        ? `repeat ${read} {}`
        : `let x: ${result.kind}${result.nullable === true ? " | null" : ""} = ${read}`,
    value: read,
  };
}

/** A check as the test compares it: its kind, target, required kinds and site. */
const checkText = (check: {
  readonly kind: string;
  readonly target: string;
  readonly against: readonly string[];
  readonly site: { readonly offset: number };
}): string => `${check.kind} ${check.target} [${check.against.join(", ")}] @${check.site.offset}`;

test("every member a receiver kind has answers its declared result to a consumer of its kind, never nothing", () => {
  const failing: string[] = [];
  for (const member of members()) {
    const seed = SEEDS[member.receiver]!;
    const read = `r.${member.read}`;
    const routes: readonly (readonly [string, (use: string) => string, string])[] = [
      ["bound", (use) => `let r = ${seed}\n${use}\nexit`, read],
      [
        "result",
        (use) =>
          `function make {\nlet r = ${seed}\nif askBoolean "pick" { return ${read} }\nreturn ${read}\n}\nlet v = make()\n${use}\nexit`,
        "v",
      ],
    ];
    for (const [route, program, text] of routes)
      for (const reversed of [false, true]) {
        const name = `${member.receiver}.${member.read} ${route}${reversed ? " reversed" : ""}`;
        const use = consumed(text, member.result);
        const source = program(use.statement);
        const request = coreRequest([{ path: "main.tease", source }]);
        if (request === null) {
          failing.push(`${name}: does not parse or resolve`);
          continue;
        }
        const run = () => analyseCore(request);
        const answers = withSolverSeam({ reverseWorklist: reversed }, () =>
          reversed ? withConsumerOrder((list) => [...list].reverse(), run) : run(),
        );
        // the statement's reads by their text, with their published items, emptiness marks included
        const statementAt = source.lastIndexOf(use.statement);
        const siteOf = (at: string) => statementAt + use.statement.indexOf(at);
        const itemsAt = (at: string) => {
          const node = answers.graph.nodes.find(
            (candidate) =>
              candidate.kind === "expression" &&
              candidate.span !== null &&
              candidate.span.start.offset === siteOf(at) &&
              source.slice(candidate.span.start.offset, candidate.span.end.offset) === at,
          );
          return (node === undefined ? null : answers.at(node))?.items ?? [];
        };
        const kinds = (found: readonly { readonly tag: string }[]) =>
          found.map((item) => item.tag).join("|");
        const unknown = (found: readonly { readonly tag: string }[]) =>
          found.some((item) => item.tag === "unknown");
        const items = itemsAt(text).filter((item) => item.tag !== "empty");
        if (items.length === 0) failing.push(`${name}: no items`);
        else if (
          items.some((item) => item.tag === "unknown" && (item.reasons & REASON.external) !== 0)
        )
          failing.push(`${name}: external data`);
        else if (member.exact === true && items.some((item) => item.tag !== member.result.kind))
          failing.push(`${name}: ${kinds(items)}, not ${member.result.kind}`);
        // the consumer's obligations, from its operand's answer: its kind's check where the answer is no kind it knows,
        // a selection's empty check where the collection may hold none, its null check where the collection is
        // unknown; quiet where the declared kind fits (C1, C2, C6). A consumer of the declared kind never errs.
        const expected: string[] = [];
        const value = itemsAt(use.value);
        // F19a: a handle's member read owes its receiver's null check, where the read stands in the consumer
        if (route === "bound" && Object.hasOwn(HANDLE_MEMBERS, member.receiver))
          expected.push(`null-check r [non-null] @${siteOf(use.value)}`);
        const declared = member.result.element ?? member.result;
        if (unknown(value))
          expected.push(
            declared.kind === "integer" && declared.nullable !== true
              ? `integer-check ${use.value} [integer] @${siteOf(use.value)}`
              : `copy-type x [${declared.kind}${declared.nullable === true ? ", null" : ""}] @${siteOf(use.value)}`,
          );
        if (use.collection !== undefined) {
          const inner = use.collection.startsWith("(")
            ? use.collection.slice(1, -1)
            : use.collection;
          const label = inner;
          const collection = itemsAt(inner);
          // (the member check at the whole access, its parentheses included, TABLE §3.4)
          if (unknown(collection))
            expected.push(`null-check ${label} [non-null] @${siteOf(use.value)}`);
          if (unknown(collection) || value.some((item) => item.tag === "empty"))
            expected.push(`empty-check ${label} [list] @${siteOf(use.value)}`);
          // a collection's element is never nothing either, so an empty answer cannot hide its consumer's check
          const elements = value.filter((item) => item.tag !== "empty");
          if (elements.length === 0) failing.push(`${name}: its element has no items`);
          else if (member.exact === true && elements.some((item) => item.tag !== declared.kind))
            failing.push(`${name}: its element ${kinds(elements)}, not ${declared.kind}`);
        }
        const record = coreRecord(coreResult(answers), ["main.tease"]);
        const sites = new Set([
          siteOf(use.value),
          ...(use.collection === undefined
            ? []
            : [
                siteOf(
                  use.collection.startsWith("(") ? use.collection.slice(1, -1) : use.collection,
                ),
              ]),
        ]);
        const got = record.runtimeChecks
          .filter((check) => sites.has(check.site.offset))
          .map(checkText)
          .sort();
        if (JSON.stringify(got) !== JSON.stringify(expected.sort()))
          failing.push(
            `${name}: ${got.join("; ") || "quiet"}, not ${expected.join("; ") || "quiet"}`,
          );
        if (record.outcome === "compile-error") failing.push(`${name}: ${use.statement} errs`);
      }
  }
  assert.deepEqual(failing, []);
});
