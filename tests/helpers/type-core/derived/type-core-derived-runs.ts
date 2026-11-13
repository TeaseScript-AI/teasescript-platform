// A run of a source by the rules (`evaluate`): how it ends, the checks it evaluates, and the transfer that ends a file.

import type { Expression, Statement } from "../../../../src/ast.js";
import {
  booleanFromText,
  CONVERSIONS,
  isConversion,
  numberFromText,
} from "../../../../src/conversions.js";
import { escapeMarkup } from "../../../../src/message-markup.js";
import { dictMethod } from "../../../../src/dict-operations.js";
import { hasListMethod, listMethod, listProperty } from "../../../../src/list-methods.js";
import { hasTemporalMethod } from "../../../../src/temporal-builtins.js";
import { isDictKey } from "../../../../src/value-kinds.js";
import {
  DEFAULT_TEMPORAL_CONTEXT,
  parseIsoDate,
  parseIsoDateTime,
  parseIsoTime,
  parseIsoTimestamp,
} from "../../../../src/temporal.js";
import {
  binaryFromBase64,
  binaryFromDataUrl,
} from "../../../../src/runtime/host-data/stored-files.js";
import { RuntimeFault } from "../../../../src/runtime/errors.js";
import type { RuntimeErrorCode } from "../../../../src/diagnostic-codes.js";
import { jsonText } from "../../../../src/runtime/values/json-base64.js";
import {
  readCollection,
  readDict,
  sortOrder,
} from "../../../../src/runtime/values/collection-operations.js";
import { callStringMethod } from "../../../../src/runtime/values/string-operations.js";
import {
  isDict,
  isList as isRuntimeList,
  isRange,
  isSet,
  isTemporal,
} from "../../../../src/runtime/values/value-predicates.js";
import { joinedText } from "../../../../src/runtime/values/value-text.js";
import type { SerializableRuntimeValue } from "../../../../src/runtime/values/serializable-values.js";
import {
  Underivable,
  type DerivedStore,
  type DerivedContent,
  site,
  type Syntax,
  storeOf,
  unwrap,
  writtenType,
  fallbackOf,
} from "./type-core-derived.js";
import { fitsType, jsonValue, readJson, shown } from "./type-core-derived-values.js";
import { askEnd } from "./derived-asks.js";
import { functionCalls, type ProjectFile } from "./derived-functions.js";

// ------------------------------------------------------------------------------------------------- the evaluator

/** A run's end as the engine reports it: its status, its failure `CODE@start:end`, and what it said, with offsets. */
export interface PredictedRun {
  readonly status: "halted" | "failed";
  readonly failure: string | null;
  readonly said: readonly { readonly text: string; readonly at: number }[];
}

/** One check a run evaluates: its discharge's site, whether the value fits, and the host globals the value came from. */
export interface CheckEvent {
  readonly site: string;
  /** The code the check fails with, or `null` for a typed parse's or load's reading, which gives its default. */
  readonly code: string | null;
  readonly fits: boolean;
  readonly from: ReadonlySet<string>;
}

interface Value {
  readonly v: SerializableRuntimeValue;
  readonly from: ReadonlySet<string>;
}

class Stop {
  public constructor(readonly failure: string | null) {}
}

/** A run that waits for an ask's answer (`derived-asks.ts`), which the oracle does not give. */
class Waiting {}

/** Where a file's evaluation ends by a `goto`: the statement, and the value of its `script(…)` path or its quoted path. */
export interface TransferEnd {
  readonly statement: Extract<Statement, { kind: "gotoStatement" }>;
  readonly path: SerializableRuntimeValue;
}

class Transfer {
  public constructor(readonly end: TransferEnd) {}
}

/**
 * A run of the source by the rules, with `inputs` the host globals' values: the plan's checked stores `stores` fail with
 * TSR058 at their value when it does not fit their type; a `repeat` count that is not a whole number of at least 0 fails
 * with TSR043 at the count, a list index that is not a whole number with TSR024, one the list does not have with
 * TSR025, both at the index. With `through`, a failing check is recorded and the run goes on, so a later check's value
 * is still seen (a preempted discharge).
 */
export function evaluate(
  { statements }: Syntax,
  stores: readonly DerivedStore[],
  inputs: Readonly<Record<string, SerializableRuntimeValue>>,
  through = false,
  content: DerivedContent = {
    requireExisting: [],
    indexes: [],
    fallbacks: [],
    expected: [],
    loads: [],
  },
  /** The project's files, whose `global function`s the file's calls may name (`derived-functions.ts`). */
  project: readonly ProjectFile[] = [],
): {
  readonly run: PredictedRun;
  readonly events: readonly CheckEvent[];
  /** Where the file ends by a transfer (`derived-transfers.ts` runs the next file). */
  readonly transfer: TransferEnd | null;
} {
  const env = new Map<string, Value>();
  const said: { text: string; at: number }[] = [];
  const events: CheckEvent[] = [];
  let first: string | null = null;
  const fail = (
    code: string,
    start: number,
    end: number,
    from: ReadonlySet<string>,
    fits: boolean,
  ): void => {
    events.push({ site: `${start}:${end}`, code, fits, from });
    if (fits) return;
    const failure = `${code}@${start}:${end}`;
    first ??= failure;
    if (!through) throw new Stop(failure);
  };
  // (the calls of the script's own functions, `derived-functions.ts`)
  const functions = functionCalls({
    own: statements,
    stores,
    content,
    project,
    env,
    value: (e) => value(e),
    run: (b) => run(b),
    fail,
  });
  const checkedFallback = (owner: Expression, fallback: Expression): Value => {
    const selected = value(fallback);
    const check = content.fallbacks.find((entry) => entry.owner === site(unwrap(owner)));
    if (check !== undefined)
      fail(
        "TSR058",
        unwrap(fallback).span.start.offset,
        unwrap(fallback).span.end.offset,
        selected.from,
        selected.v === null || fitsType(selected.v, check.type),
      );
    return selected;
  };
  const value = (expression: Expression): Value => {
    const result = readValue(expression);
    const type =
      expression.kind === "loadExpression"
        ? content.loads.find((entry) => entry.owner === site(expression))?.type
        : content.expected.find((entry) => entry.owner === site(expression))?.type;
    // Expected reading filters/repairs at the ingress; its selected default has its own failure site.
    if (type !== null && type !== undefined)
      events.push({
        site: site(expression),
        code: null,
        fits: result.v === null || fitsType(result.v, type),
        from: result.from,
      });
    return result;
  };
  const readValue = (expression: Expression): Value => {
    switch (expression.kind) {
      case "numberLiteral":
      case "booleanLiteral":
      case "nullLiteral":
        return { v: expression.value, from: new Set() };
      case "stringLiteral":
        if (expression.parts.some((part) => part.kind !== "stringText"))
          throw new Underivable("an interpolation");
        return {
          v: expression.parts
            .map((part) => (part.kind === "stringText" ? part.value : ""))
            .join(""),
          from: new Set(),
        };
      case "parenthesizedExpression":
        return value(expression.expression);
      case "identifier": {
        if (Object.hasOwn(inputs, expression.name))
          return { v: inputs[expression.name]!, from: new Set([expression.name]) };
        const bound = env.get(expression.name);
        if (bound === undefined)
          throw new Underivable(`a read of ${expression.name} before its store`);
        return bound;
      }
      case "listLiteral": {
        const items = expression.elements.map(value);
        return {
          v: { kind: "list", items: items.map((item) => item.v) },
          from: new Set(items.flatMap((item) => [...item.from])),
        };
      }
      case "regexLiteral":
        return {
          v: { kind: "regex", source: expression.source, flags: expression.flags },
          from: new Set(),
        };
      case "rangeExpression": {
        // (a range of whole-number bounds; any other is the runtime's to reject)
        const [start, end] = [value(expression.start), value(expression.end)];
        if (!Number.isInteger(start.v) || !Number.isInteger(end.v))
          throw new Underivable("a range of other bounds");
        return {
          v: {
            kind: "range",
            start: Number(start.v),
            end: Number(end.v),
            inclusive: expression.inclusive,
          },
          from: new Set([...start.from, ...end.from]),
        };
      }
      case "objectLiteral": {
        const properties = expression.properties.map((property) => ({
          name: property.name.name,
          value: value(property.value),
        }));
        return {
          v: {
            kind: "object",
            properties: properties.map((property) => ({
              name: property.name,
              value: property.value.v,
            })),
          },
          from: new Set(properties.flatMap((property) => [...property.value.from])),
        };
      }
      case "propertyAccessExpression": {
        const object = value(expression.object);
        const name = expression.property.name;
        if (
          object.v !== null &&
          typeof object.v === "object" &&
          (object.v.kind === "list" || object.v.kind === "set")
        ) {
          const property = listProperty(name);
          if (property?.gives === "length") return { v: object.v.items.length, from: object.from };
          if (property?.gives === "element") {
            fail(
              property.empty,
              expression.span.start.offset,
              expression.span.end.offset,
              object.from,
              object.v.items.length > 0,
            );
            if (property.name === "random" && object.v.items.length > 1)
              throw new Underivable("a random selection from several elements");
            return {
              v: object.v.items[property.name === "last" ? object.v.items.length - 1 : 0] ?? null,
              from: object.from,
            };
          }
        }
        let held: SerializableRuntimeValue | undefined;
        if (object.v !== null && typeof object.v === "object" && object.v.kind === "object")
          held = object.v.properties.find((property) => property.name === name)?.value;
        else if (typeof object.v === "string" && name === "length") held = [...object.v].length;
        fail(
          "TSR017",
          expression.span.start.offset,
          expression.span.end.offset,
          object.from,
          held !== undefined,
        );
        return { v: held ?? null, from: object.from };
      }
      case "binaryExpression": {
        // (the narrowing's null tests, `x != null` and `x == null`: whether the other side is `null`, #1073 PR 2)
        if (
          (expression.operator === "!=" || expression.operator === "==") &&
          (unwrap(expression.left).kind === "nullLiteral" ||
            unwrap(expression.right).kind === "nullLiteral")
        ) {
          const other = value(
            unwrap(expression.left).kind === "nullLiteral" ? expression.right : expression.left,
          );
          return { v: (other.v === null) === (expression.operator === "=="), from: other.from };
        }
        if (expression.operator !== "otherwise")
          throw new Underivable(`the operator ${expression.operator}`);
        const left = value(expression.left);
        return left.v !== null ? left : checkedFallback(expression, expression.right);
      }
      case "typeTestExpression": {
        // (`x is T`: whether its value fits T, as a store of it would; `is not` the opposite, #1073 PR 2)
        const tested = value(expression.value);
        return {
          v: fitsType(tested.v, writtenType(expression.type)) !== expression.negated,
          from: tested.from,
        };
      }
      case "loadExpression": {
        const key = value(expression.key);
        if (typeof key.v !== "string") throw new Underivable("a load key that is not text");
        if (expression.defaultValue === null) return { v: null, from: new Set() };
        const fallback = value(expression.defaultValue);
        const type = content.loads.find((entry) => entry.owner === site(expression))?.type;
        if (type !== null && type !== undefined)
          fail(
            "TSR058",
            unwrap(expression.defaultValue).span.start.offset,
            unwrap(expression.defaultValue).span.end.offset,
            fallback.from,
            fallback.v === null || fitsType(fallback.v, type),
          );
        return fallback;
      }
      case "callExpression": {
        const authored = functions.call(expression);
        if (authored !== undefined) return authored;
        const callee = unwrap(expression.callee);
        const receiver = callee.kind === "propertyAccessExpression" ? value(callee.object) : null;
        const operands = expression.arguments
          .filter(
            (argument) => argument.kind !== "namedArgument" || argument.name.name !== "default",
          )
          .map((argument) => ({ argument, value: value(argument.value) }));
        const positional = operands
          .filter((operand) => operand.argument.kind === "positionalArgument")
          .map((operand) => operand.value);
        const named = (name: string): Value | undefined =>
          operands.find(
            (operand) =>
              operand.argument.kind === "namedArgument" && operand.argument.name.name === name,
          )?.value;
        const fallback = fallbackOf(expression);
        const useDefault = (): Value => {
          if (fallback === null) throw new Underivable("a call without its default");
          return checkedFallback(expression, fallback);
        };
        if (callee.kind === "propertyAccessExpression") {
          const method = callee.property.name;
          const from = new Set([
            ...receiver!.from,
            ...positional.flatMap((operand) => [...operand.from]),
          ]);
          const target = receiver!.v;
          const values = positional.map((operand) => operand.v);
          const { span } = expression;
          // (the runtime's own check of the call fails at its site; one that passes is TSV043's and the member's)
          const called = (make: () => SerializableRuntimeValue | undefined): Value => {
            let made: SerializableRuntimeValue | undefined;
            try {
              made = make();
            } catch (error) {
              if (!(error instanceof RuntimeFault)) throw error;
              fail(error.code, error.span.start.offset, error.span.end.offset, from, false);
              return { v: null, from };
            }
            fail("TSV043", span.start.offset, span.end.offset, from, true);
            fail("TSR016", span.start.offset, span.end.offset, from, true);
            return made === undefined ? useDefault() : { v: made, from };
          };
          const fault = (code: RuntimeErrorCode, at: Expression["span"] = span): never => {
            throw new RuntimeFault(code, "", at);
          };
          // a method of the slice (S9b) dispatched as the runtime dispatches it, by the receiver's kind: text's
          // (`callStringMethod`); a date or time value's only where it has one (`hasTemporalMethod`); a dict's, its key text (TSR062 at the key), `contains` and `get` read (`readDict`); a
          // list's or a set's that its kind has, with as many arguments as it takes (TSR028), that changes nothing
          // (`readCollection`), or `sort`, which orders its list in place; any other receiver, or a method its kind
          // does not have, fails the call's member check (TSR016)
          if (typeof target === "string" && method !== "get")
            return called(() => callStringMethod(target, method, values, span));
          if (target !== null && isTemporal(target)) {
            // (a temporal value's own methods are outside the slice's evaluation; one it lacks fails the member check)
            if (hasTemporalMethod(target.kind, method))
              throw new Underivable(`the method ${method} of a ${target.kind}`);
            return called(() => fault("TSR016"));
          }
          if (target !== null && isDict(target)) {
            const contract = dictMethod(method);
            if (contract?.changes !== undefined)
              throw new Underivable(`the method ${method}, which changes its receiver`);
            return called(() => {
              if (contract === undefined) return fault("TSR016");
              if (values.length !== contract.parameters.length) return fault("TSR028");
              const key = values[0]!;
              if (!isDictKey(key)) return fault("TSR062", expression.arguments[0]!.value.span);
              return readDict(target, method === "get" ? "get" : "contains", key);
            });
          }
          if (method !== "get") {
            if (target !== null && isRange(target) && method === "toList")
              throw new Underivable("a range's toList");
            const collection =
              target !== null && (isRuntimeList(target) || isSet(target)) ? target : null;
            const kind = collection === null ? null : collection.kind;
            const contract = listMethod(method);
            if (contract?.changes !== undefined && method !== "sort" && kind !== null)
              throw new Underivable(`the method ${method}, which changes its receiver`);
            return called(() => {
              if (
                collection === null ||
                kind === null ||
                contract === undefined ||
                !hasListMethod(kind, method)
              )
                return fault("TSR016");
              const required = contract.parameters.filter(
                (parameter) => !("optional" in parameter && parameter.optional === true),
              ).length;
              if (values.length < required || values.length > contract.parameters.length)
                return fault("TSR028");
              if (method === "sort") {
                const items = [...collection.items];
                const order = sortOrder(items, span);
                collection.items.splice(0, items.length, ...order.map((index) => items[index]!));
                return null;
              }
              return readCollection(collection, method, values, {}, false, span, (item) =>
                joinedText(item, span, DEFAULT_TEMPORAL_CONTEXT),
              );
            });
          }
          const index = positional[0]!;
          const list = receiver!;
          const isList = typeof list.v === "object" && list.v !== null && list.v.kind === "list";
          fail(
            "TSR016",
            expression.span.start.offset,
            expression.span.end.offset,
            list.from,
            isList,
          );
          if (!isList || list.v === null || typeof list.v !== "object" || list.v.kind !== "list")
            return useDefault();
          const whole = typeof index.v === "number" && Number.isInteger(index.v);
          if (content.indexes.includes(site(expression))) {
            const operand = unwrap(expression.arguments[0]!.value);
            fail("TSR024", operand.span.start.offset, operand.span.end.offset, index.from, whole);
          }
          return whole && Number(index.v) >= 0 && Number(index.v) < list.v.items.length
            ? { v: list.v.items[Number(index.v)]!, from: list.from }
            : useDefault();
        }
        if (callee.kind !== "identifier") throw new Underivable("a non-name call");
        const name = callee.name;
        const input = positional[0] ?? named("value") ?? named("text");
        if (input === undefined) throw new Underivable(`the argument of ${name}`);
        if (name === "toJson") {
          // (the runtime's own writing, and its own check of what it writes, TSV043 at the call)
          let written: string | null = null;
          try {
            written = jsonText(input.v, () => [], expression.span);
          } catch (error) {
            if (!(error instanceof RuntimeFault)) throw error;
          }
          fail(
            "TSV043",
            expression.span.start.offset,
            expression.span.end.offset,
            input.from,
            written !== null,
          );
          return { v: written, from: input.from };
        }
        if (name === "fromJson") {
          if (typeof input.v !== "string") return useDefault();
          let parsed: SerializableRuntimeValue;
          try {
            parsed = jsonValue(JSON.parse(input.v));
          } catch (error) {
            if (error instanceof SyntaxError) return useDefault();
            throw error;
          }
          const type = content.expected.find((entry) => entry.owner === site(expression))?.type;
          if (type === undefined) return { v: parsed, from: input.from };
          const read = readJson(parsed, type);
          if (read !== undefined) return { v: read, from: input.from };
          const supplied = useDefault();
          return {
            v: readJson(parsed, type, supplied.v) ?? supplied.v,
            from: new Set([...input.from, ...supplied.from]),
          };
        }
        let converted: SerializableRuntimeValue | undefined;
        if (name === "toNumber" || name === "toInteger") {
          const number =
            typeof input.v === "number"
              ? input.v
              : typeof input.v === "string"
                ? numberFromText(input.v)
                : undefined;
          converted =
            number === undefined ? undefined : name === "toInteger" ? Math.trunc(number) : number;
        } else if (name === "toBoolean")
          converted =
            typeof input.v === "boolean"
              ? input.v
              : typeof input.v === "string"
                ? booleanFromText(input.v)
                : undefined;
        else if (["toDate", "toTime", "toDateTime", "toAbsoluteDateTime"].includes(name)) {
          const kind =
            name === "toDate"
              ? "date"
              : name === "toTime"
                ? "time"
                : name === "toDateTime"
                  ? "datetime"
                  : "absoluteDateTime";
          if (typeof input.v === "string") {
            if (kind === "date") {
              const parsed = parseIsoDate(input.v);
              if (parsed.ok) converted = { kind, ...parsed.value };
            } else if (kind === "time") {
              const parsed = parseIsoTime(input.v);
              if (parsed.ok) converted = { kind, ...parsed.value };
            } else if (kind === "datetime") {
              const parsed = parseIsoDateTime(input.v);
              if (parsed.ok) converted = { kind, ...parsed.value };
            } else {
              const parsed = parseIsoTimestamp(input.v);
              if (parsed.ok) converted = { kind, epochMilliseconds: parsed.value };
            }
          } else if (input.v !== null && typeof input.v === "object") {
            if (input.v.kind === kind) converted = structuredClone(input.v);
            else if (input.v.kind === "datetime" && kind === "date")
              converted = { kind, year: input.v.year, month: input.v.month, day: input.v.day };
            else if (input.v.kind === "datetime" && kind === "time")
              converted = {
                kind,
                hour: input.v.hour,
                minute: input.v.minute,
                second: input.v.second,
                millisecond: input.v.millisecond,
              };
          }
        } else if (name === "fileFromBase64") {
          if (
            typeof input.v === "string" &&
            (binaryFromDataUrl(input.v) ?? binaryFromBase64(input.v)) !== undefined
          )
            throw new Underivable("a fileFromBase64 result that needs a host file store");
        } else if (name === "decryptText" || name === "decryptFile") {
          for (const operand of operands)
            fail(
              "TSR059",
              expression.span.start.offset,
              expression.span.end.offset,
              operand.value.from,
              typeof operand.value.v === "string",
            );
          if (name === "decryptFile")
            fail(
              "TSR059",
              expression.span.start.offset,
              expression.span.end.offset,
              input.from,
              false,
            ); // no stored files in this oracle's runs
          if (
            name === "decryptText" &&
            typeof input.v === "string" &&
            binaryFromBase64(input.v) !== undefined
          )
            throw new Underivable("a decryptText result that needs a host lock action");
        } else throw new Underivable(`the conversion ${name}`);
        if (converted !== undefined) return { v: converted, from: input.from };
        const supplied = useDefault();
        if (
          !content.fallbacks.some((entry) => entry.owner === site(expression)) &&
          isConversion(name)
        ) {
          const conversion = CONVERSIONS[name];
          const fits =
            conversion.fallback?.type === "any" ||
            conversion.result === "unknown" ||
            (conversion.fallback?.type === "optional" && supplied.v === null) ||
            fitsType(supplied.v, { kind: "kinds", kinds: [conversion.result] });
          fail(
            "TSR058",
            unwrap(fallback!).span.start.offset,
            unwrap(fallback!).span.end.offset,
            supplied.from,
            fits,
          );
        }
        return supplied;
      }
      case "indexExpression": {
        const list = value(expression.object);
        const { start, end } = {
          start: unwrap(expression.index).span.start.offset,
          end: unwrap(expression.index).span.end.offset,
        };
        const collection = list.v !== null && typeof list.v === "object" ? list.v : null;
        const indexable = collection?.kind === "list" || collection?.kind === "dict";
        fail(
          collection?.kind === "set" ? "TSR004" : "TSR008",
          expression.span.start.offset,
          expression.span.end.offset,
          list.from,
          indexable,
        );
        if (!indexable) {
          return { v: null, from: list.from };
        }
        const index = value(expression.index);
        if (collection.kind === "dict") {
          const key = typeof index.v === "string";
          fail("TSR062", start, end, index.from, key);
          const held = collection.entries.find((entry) => entry.key === index.v)?.value;
          fail(
            "TSR061",
            expression.span.start.offset,
            expression.span.end.offset,
            new Set([...list.from, ...index.from]),
            !key || held !== undefined,
          );
          return { v: held ?? null, from: list.from };
        }
        const items: readonly SerializableRuntimeValue[] = collection.items;
        const whole = typeof index.v === "number" && Number.isInteger(index.v);
        fail("TSR024", start, end, index.from, whole);
        const position = Number(index.v);
        fail(
          "TSR025",
          start,
          end,
          index.from,
          !whole || (position >= 0 && position < items.length),
        );
        return { v: items[position] ?? null, from: list.from };
      }
      case "interactionExpression": {
        const end = askEnd(expression, (part) => value(part).v);
        if (end.said !== null) said.push({ text: end.said, at: expression.span.start.offset });
        if (end.failure !== undefined)
          fail(end.failure.code, end.failure.start, end.failure.end, new Set(), false);
        throw new Waiting();
      }
      default:
        throw new Underivable(`a ${expression.kind}`);
    }
  };
  const run = (block: readonly Statement[]): void => {
    for (const statement of block) {
      const store = storeOf(statement);
      if (store !== null) {
        const target =
          statement.kind === "assignmentStatement" &&
          statement.target.kind === "propertyAccessExpression"
            ? statement.target
            : null;
        const receiver = target === null ? null : value(target.object);
        if (target !== null && receiver !== null)
          fail(
            "TSR003",
            target.span.start.offset,
            target.span.end.offset,
            receiver.from,
            receiver.v !== null && typeof receiver.v === "object" && receiver.v.kind === "object",
          );
        const stored = value(store.value);
        const checked = stores.find((candidate) => candidate.so === statement.span.start.offset);
        if (checked !== undefined)
          fail(
            "TSR058",
            checked.valueSo,
            checked.valueEo,
            stored.from,
            fitsType(stored.v, checked.type),
          );
        if (
          target !== null &&
          receiver !== null &&
          typeof receiver.v === "object" &&
          receiver.v !== null &&
          receiver.v.kind === "object"
        ) {
          const property = receiver.v.properties.find(
            (property) => property.name === target.property.name,
          );
          if (content.requireExisting.some((entry) => entry.site === site(statement)))
            fail(
              "TSR017",
              target.span.start.offset,
              target.span.end.offset,
              receiver.from,
              property !== undefined,
            );
          if (property !== undefined) property.value = structuredClone(stored.v);
          else
            receiver.v.properties.push({
              name: target.property.name,
              value: structuredClone(stored.v),
            });
        } else if (target === null)
          env.set(store.name, { v: structuredClone(stored.v), from: stored.from });
      } else if (statement.kind === "repeatStatement") {
        const count = value(statement.count);
        const fits = typeof count.v === "number" && Number.isInteger(count.v) && count.v >= 0;
        fail(
          "TSR043",
          unwrap(statement.count).span.start.offset,
          unwrap(statement.count).span.end.offset,
          count.from,
          fits,
        );
        for (let round = 0; round < (fits ? Number(count.v) : 0); round += 1)
          run(statement.body.statements);
      } else if (statement.kind === "ifStatement") {
        // (a literal, or a test whose value the run knows: a type test, a null test)
        const condition = value(statement.condition).v;
        if (typeof condition !== "boolean")
          throw new Underivable("an `if` on a value that is not a boolean");
        if (condition) run(statement.thenBlock.statements);
        else if (statement.elseBlock !== null)
          run(
            statement.elseBlock.kind === "ifStatement"
              ? [statement.elseBlock]
              : statement.elseBlock.statements,
          );
      } else if (statement.kind === "forStatement") {
        // (the loop's own check of its source, TSR044, then each element, key or entry as the loop visits them)
        const source = value(statement.iterable);
        const iterated = source.v;
        const pair = statement.valueVariable !== null;
        const kind = typeof iterated === "object" && iterated !== null ? iterated.kind : null;
        const iterable = pair
          ? kind === "dict"
          : kind === "list" || kind === "set" || kind === "dict" || kind === "range";
        fail(
          "TSR044",
          unwrap(statement.iterable).span.start.offset,
          unwrap(statement.iterable).span.end.offset,
          source.from,
          iterable,
        );
        if (!iterable || typeof iterated !== "object" || iterated === null) continue;
        const visits: [SerializableRuntimeValue, SerializableRuntimeValue | null][] =
          iterated.kind === "list" || iterated.kind === "set"
            ? iterated.items.map((item) => [item, null])
            : iterated.kind === "dict"
              ? iterated.entries.map((entry) => [entry.key, entry.value])
              : iterated.kind === "range"
                ? Array.from(
                    {
                      length: Math.max(
                        0,
                        iterated.end - iterated.start + (iterated.inclusive ? 1 : 0),
                      ),
                    },
                    (_, at) => [iterated.start + at, null],
                  )
                : [];
        for (const [element, entry] of visits) {
          env.set(statement.variable.name, { v: structuredClone(element), from: source.from });
          if (pair)
            env.set(statement.valueVariable!.name, {
              v: structuredClone(entry),
              from: source.from,
            });
          run(statement.body.statements);
        }
      } else if (statement.kind === "expressionStatement") value(statement.expression);
      else if (statement.kind === "sayStatement") {
        const text = value(statement.value);
        said.push({
          text:
            text.v !== null && typeof text.v === "object"
              ? escapeMarkup(shown(text.v))
              : shown(text.v),
          at: statement.span.start.offset,
        });
      } else if (statement.kind === "exitStatement") throw new Stop(null);
      else if (statement.kind === "gotoStatement") {
        const { target } = statement;
        const call = target.kind === "scriptTarget" ? target.expression : null;
        const argument = call?.kind === "callExpression" ? call.arguments[0] : undefined;
        const path = target.kind === "fileTarget" ? target.path : null;
        throw new Transfer({
          statement,
          path: argument === undefined ? path : value(argument.value).v,
        });
      } else if (!functions.statement(statement)) throw new Underivable(`a ${statement.kind}`);
    }
  };
  let failure: string | null = null;
  let transfer: TransferEnd | null = null;
  let waiting = false;
  try {
    run(statements);
  } catch (stop) {
    if (stop instanceof Transfer) transfer = stop.end;
    else if (stop instanceof Stop) failure = stop.failure;
    // (a run waiting for an answer is no halted one, and has no failure: `runGlobals` reports it so)
    else if (stop instanceof Waiting) waiting = true;
    else throw stop;
  }
  failure ??= first;
  return {
    run: { status: failure === null && !waiting ? "halted" : "failed", failure, said },
    events,
    transfer,
  };
}
