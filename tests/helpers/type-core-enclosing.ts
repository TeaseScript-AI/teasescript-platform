import { compileSourceWithBackend, type CompilationResult } from "../../src/compiler.js";
import type { SerializableRuntimeValue } from "../../src/runtime/values/serializable-values.js";
import { analyseCore, type Answers } from "../../src/type-inference/core/answers.js";
import { CORE_BACKEND } from "../../src/type-inference/core/backend.js";
import { withTestDemandAllowance } from "../../src/type-inference/core/budget.js";
import { withConsumerOrder } from "../../src/type-inference/core/consumers.js";
import { CoreProgram, propertyStep } from "../../src/type-inference/core/program.js";
import { withoutSharing } from "../../src/type-inference/core/sharing.js";
import { withSolverSeam } from "../../src/type-inference/core/solver.js";
import { coreRequest } from "./type-core-analysis.js";
import { plannedStores, runGlobals } from "./type-core-route.js";
import {
  checkedText,
  collection,
  fits,
  formText,
  name,
  optional,
  type Form,
} from "./type-core-written.js";

/*
 * The stores above a stopped decision (#1416; S3 §5, ADR 0021 rule 1.10): a store or argument whose value holds a key
 * whose decision stopped at its demand allowance keeps that key's obligation, its check against its destination's
 * complete type or its value marked. A generated family over the destination's origin (written, a copy, a copy of a
 * copy, a property a copy decides, one named `element`, an object a literal decides, a sibling property), the store's
 * site (a declaration, a replacement with a literal or with a host value), the written form (lists one, two and four
 * deep, a nullable element, a nullable list, text leaves), each tried with the values the form's own predicate (`fits`)
 * sorts, never the implementation's matcher; judged at every allowance around each decision's work in the eight orders
 * (`enclosingProblems`). CI runs anchors of it; the whole family is a worker run outside CI.
 */

/** A store's destination: its binding and the path below it, in key steps. */
export interface Destination {
  readonly binding: string;
  readonly path: readonly string[];
}

export interface EnclosingCase {
  readonly name: string;
  readonly source: string;
  readonly into: Destination;
  /** The stored value's site. */
  readonly site: { readonly start: number; readonly end: number };
  /**
   * The destination's complete type by the source (its written type, or the one a copy gives it), `null` where an
   * object literal decides it, whose properties' types the store's own decisions give.
   */
  readonly form: Form | null;
  /** Whether the destination's binding is written (`let t: F`): its type known in every phase. */
  readonly written: boolean;
  /** The values a run tries: each a host value, or the one the source stores (`host` false), with whether it fits. */
  readonly values: readonly { readonly value: SerializableRuntimeValue; readonly fits: boolean }[];
  readonly host: boolean;
}

const list = (...items: SerializableRuntimeValue[]): SerializableRuntimeValue => ({
  kind: "list",
  items,
});
const object = (
  properties: Readonly<Record<string, SerializableRuntimeValue>>,
): SerializableRuntimeValue => ({
  kind: "object",
  properties: Object.entries(properties).map(([property, value]) => ({ name: property, value })),
});

/** A value as a TeaseScript literal. */
function literalText(value: SerializableRuntimeValue): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (value.kind === "list") return `[${value.items.map(literalText).join(", ")}]`;
  if (value.kind === "object")
    return `{${value.properties.map((p) => `${p.name}: ${literalText(p.value)}`).join(", ")}}`;
  throw new Error(`No literal of a ${value.kind}.`);
}

const listOf = (of: Form, depth: number): Form =>
  depth === 0 ? of : collection("list", listOf(of, depth - 1));
const integer = name("integer");

/** The written forms: lists one, two and four deep, a nullable element, a nullable list, text leaves. */
const FORMS: readonly Form[] = [
  listOf(integer, 1),
  listOf(integer, 2),
  listOf(integer, 4),
  collection("list", optional(integer)),
  optional(listOf(integer, 1)),
  listOf(name("string"), 2),
];

/** A form's lists' nesting and its leaf's fitting and forbidden values. */
function spine(form: Form): {
  depth: number;
  good: SerializableRuntimeValue;
  bad: SerializableRuntimeValue;
} {
  let depth = 0;
  let at = form.kind === "optional" ? form.of : form;
  while (at.kind === "collection") {
    depth += 1;
    at = at.of.kind === "optional" ? at.of.of : at.of;
  }
  const text = at.kind === "name" && at.name === "string";
  return { depth, good: text ? "ok" : 1, bad: text ? 1 : "bad" };
}

/**
 * A form's values by its structure: the fitting one, a forbidden leaf, a forbidden sibling beside a fitting leaf, a
 * scalar where each level holds a list (the outer one a non-list), an empty list at each level, `null` as the value and
 * as its leaf; `few` keeps the fitting one, the forbidden leaf, the sibling and the innermost wrong container.
 */
function valuesOf(form: Form, few: boolean): SerializableRuntimeValue[] {
  const { depth, good, bad } = spine(form);
  const nest = (levels: number, inner: SerializableRuntimeValue): SerializableRuntimeValue =>
    levels === 0 ? inner : list(nest(levels - 1, inner));
  const out = [nest(depth, good), nest(depth, bad), nest(depth - 1, list(good, bad))];
  if (few) out.push(nest(depth - 1, bad));
  else {
    for (let level = 0; level < depth; level += 1) out.push(nest(level, bad), nest(level, list()));
    out.push(null, nest(depth, null));
  }
  const seen = new Set<string>();
  return out.filter((value) => {
    const key = JSON.stringify(value);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

type Origin =
  | "written"
  | "copy"
  | "copy of a copy"
  | "copied property"
  | "property named element"
  | "object"
  | "sibling property";

const ORIGINS: readonly Origin[] = [
  "written",
  "copy",
  "copy of a copy",
  "copied property",
  "property named element",
  "object",
  "sibling property",
];

/** An origin's lines before the store, the store's target text, and its destination. */
function originOf(
  origin: Origin,
  type: string,
  seed: string,
): { readonly lines: readonly string[]; readonly target: string; readonly into: Destination } {
  switch (origin) {
    case "written":
      return { lines: [`let t: ${type} = ${seed}`], target: "t", into: { binding: "t", path: [] } };
    case "copy":
      return {
        lines: [`let seed: ${type} = ${seed}`, "let t = seed"],
        target: "t",
        into: { binding: "t", path: [] },
      };
    case "copy of a copy":
      return {
        lines: [`let seed: ${type} = ${seed}`, "let mid = seed", "let t = mid"],
        target: "t",
        into: { binding: "t", path: [] },
      };
    case "copied property":
      return {
        lines: [`let seed: ${type} = ${seed}`, "let box = {items: seed}"],
        target: "box.items",
        into: { binding: "box", path: [propertyStep("items")] },
      };
    case "property named element":
      return {
        lines: [`let seed: ${type} = ${seed}`, "let box = {element: seed}"],
        target: "box.element",
        into: { binding: "box", path: [propertyStep("element")] },
      };
    case "object":
      return {
        lines: [`let seed: ${type} = ${seed}`, "let box = {items: seed}"],
        target: "box",
        into: { binding: "box", path: [] },
      };
    case "sibling property":
      // (the sibling's decisions scan more stores, so an allowance stops them alone)
      return {
        lines: [
          `let seedA: ${type} = ${seed}`,
          `let seedB: ${type} = ${seed}`,
          "let box = {a: seedA, b: seedB}",
          ...Array.from({ length: 40 }, () => "box.b = seedB"),
        ],
        target: "box.a",
        into: { binding: "box", path: [propertyStep("a")] },
      };
  }
}

/**
 * The family: every origin and form, a host value's replacement trying every value, a literal's replacement per value
 * (`few` of them in the anchors), and a written binding's declaration per value.
 */
export function enclosingFamily(few = false): EnclosingCase[] {
  const cases: EnclosingCase[] = [];
  for (const form of FORMS) {
    const type = formText(form);
    const seed = literalText(valuesOf(form, true)[0]!);
    for (const origin of ORIGINS) {
      const { lines, target, into } = originOf(origin, type, seed);
      const whole = origin === "object";
      // (an object a literal decides holds the form at its property)
      const stored = (value: SerializableRuntimeValue): SerializableRuntimeValue =>
        whole ? object({ items: value }) : value;
      const add = (site: string, value: string, values: EnclosingCase["values"]): void => {
        const store = site === "declaration" ? `let t: ${type} = ${value}` : `${target} = ${value}`;
        const head = site === "declaration" ? [] : lines;
        const source = [...head, 'say "BEFORE"', store, 'say "AFTER"', "exit"].join("\n") + "\n";
        const start = source.indexOf(store) + store.length - value.length;
        cases.push({
          name: `${origin}, ${type}, ${site}${site === "host" ? "" : ` ${value}`}`,
          source,
          into,
          site: { start, end: start + value.length },
          form: whole ? null : form,
          written: origin === "written",
          values,
          host: site === "host",
        });
      };
      add(
        "host",
        "hostValue",
        valuesOf(form, false).map((value) => ({ value: stored(value), fits: fits(form, value) })),
      );
      for (const value of valuesOf(form, few)) {
        const entry = [{ value: stored(value), fits: fits(form, value) }];
        add("literal", literalText(stored(value)), entry);
        if (origin === "written") add("declaration", literalText(value), entry);
      }
    }
  }
  return cases;
}

/** An order of the analysis: the consumers' and the solver's worklist forward or reversed, the sharing on or off. */
export interface Mode {
  readonly name: string;
  readonly run: <T>(make: () => T) => T;
}

export const MODES: readonly Mode[] = [false, true].flatMap((consumers) =>
  [false, true].flatMap((solver) =>
    [true, false].map((sharing): Mode => ({
      name:
        `${consumers ? "reversed" : "forward"} consumers, ${solver ? "reversed" : "forward"} solver` +
        (sharing ? "" : ", unshared"),
      run: <T>(make: () => T): T => {
        const ordered = consumers
          ? (): T => withConsumerOrder((items) => [...items].reverse(), make)
          : make;
        const solved = solver
          ? (): T => withSolverSeam({ reverseWorklist: true }, ordered)
          : ordered;
        return sharing ? solved() : withoutSharing(solved);
      },
    })),
  ),
);

/** How a store relates to the stopped decisions of its binding: one at or above its path, one below it only, none. */
export type Relation = "at" | "above" | "none";

/** One judged compile of a case: the stops, the store's relation and phase, and what the oracle found wrong. */
export interface EnclosingVerdict {
  readonly allowance: number | null;
  readonly stops: readonly string[];
  readonly relation: Relation;
  /** `unsettled`: a program stop before admission settled, which marks every store into an inferred place (#1252). */
  readonly phase: "settled" | "unsettled" | "unstopped";
  /** What the oracle judged: the full domain, an owned mark, or nothing (the exact-target family, #1275). */
  readonly judged: "domain" | "mark" | "exact";
  readonly problems: readonly string[];
}

/**
 * The allowances around each decision's work in a case's uncapped analysis in a mode, and 1; `own`: the decisions of
 * the destination's binding alone.
 */
export function allowancesOf(c: EnclosingCase, mode: Mode, own = false): number[] {
  const request = coreRequest([{ path: "main.tease", source: c.source }])!;
  const place = own ? placeOf(request, c) : null;
  const units = new Set(
    mode
      .run(() => analyseCore(request))
      .budget.decisions.filter((d) => place === null || d.place === place)
      .map((d) => d.units),
  );
  const out = new Set<number>([1]);
  for (const unit of units) for (const at of [unit - 1, unit, unit + 1]) if (at >= 1) out.add(at);
  return [...out].sort((a, b) => a - b);
}

/** The place of a case's destination binding. */
function placeOf(request: NonNullable<ReturnType<typeof coreRequest>>, c: EnclosingCase): number {
  return new CoreProgram(request).places.find(
    ({ kind }) => kind.kind === "binding" && kind.name === c.into.binding,
  )!.id;
}

/** The budget-context records at a site, shown or deferred: the stop's owned marks there. */
function marksAt(answers: Answers, site: EnclosingCase["site"]): number {
  return [...answers.diagnostics, ...answers.budget.deferred].filter(
    (d) =>
      d.class === "warning-runtime-check" &&
      "provenance" in d &&
      d.provenance.context === "budget" &&
      d.site.start === site.start &&
      d.site.end === site.end,
  ).length;
}

/**
 * The oracle at one allowance (`null`: uncapped) in one mode. Every fitting value reaches `AFTER`. Where the
 * destination's complete type is the source's (`form`) and the store is no exact target of a stop (#1275) nor into an
 * inferred place before admission settled (#1252, whose mark stands for its value), every forbidden value is rejected
 * before `AFTER`, by the compile or at its store, the plan checks the store against the whole form, and a store above a
 * stop has exactly one owned mark at its own site; where an object literal decides the destination, a store above a
 * stop has that mark.
 */
export function enclosingProblems(
  c: EnclosingCase,
  allowance: number | null,
  mode: Mode,
): EnclosingVerdict {
  const request = coreRequest([{ path: "main.tease", source: c.source }]);
  if (request === null) throw new Error(`The case does not resolve: ${c.name}`);
  const place = placeOf(request, c);
  const capped = <T>(make: () => T): T =>
    mode.run(() => (allowance === null ? make() : withTestDemandAllowance(allowance, make)));
  const answers = capped(() => analyseCore(request));
  const compiled: CompilationResult = capped(() =>
    compileSourceWithBackend(c.source, { globals: ["hostValue"] }, CORE_BACKEND),
  );
  const stopped = answers.budget.decisions
    .filter((d) => d.stopped && d.place === place)
    .map((d) => d.path);
  const prefix = (of: readonly string[], path: readonly string[]): boolean =>
    of.length <= path.length && of.every((step, index) => path[index] === step);
  const relation: Relation = stopped.some((path) => prefix(path, c.into.path))
    ? "at"
    : stopped.some((path) => prefix(c.into.path, path))
      ? "above"
      : "none";
  const phase =
    answers.budget.exhausted === null
      ? stopped.length > 0
        ? "settled"
        : "unstopped"
      : answers.budget.settled
        ? "settled"
        : "unsettled";
  const unsettledInferred = phase === "unsettled" && !c.written;
  const judged =
    relation === "at" ? "exact" : c.form === null || unsettledInferred ? "mark" : "domain";
  const problems: string[] = [];
  const plan = compiled.plan;
  const within = (d: CompilationResult["diagnostics"][number]): boolean =>
    d.span.start.offset >= c.site.start && d.span.end.offset <= c.site.end;
  const rejected =
    plan === null && compiled.diagnostics.some((d) => d.severity === "error" && within(d));
  if (plan === null && !rejected)
    problems.push(
      `no plan, no error at the store: ${compiled.diagnostics.map((d) => `${d.code}@${d.span.start.offset}`).join(",")}`,
    );
  for (const { value, fits: fitting } of c.values) {
    const what = JSON.stringify(value);
    if (plan === null) {
      if (fitting && judged !== "exact") problems.push(`fitting ${what} rejected by the compile`);
      continue;
    }
    const ran = runGlobals(plan, { hostValue: c.host ? value : null });
    const after = ran.said.some((said) => said.text === "AFTER");
    if (fitting && !after && judged !== "exact")
      problems.push(`fitting ${what} stopped: ${ran.failure ?? ran.status}`);
    if (!fitting && after && judged === "domain") problems.push(`forbidden ${what} reached AFTER`);
  }
  if (plan !== null && judged === "domain" && c.form !== null) {
    const site = `${c.site.start}:${c.site.end}`;
    const planned = plannedStores(plan).find((store) => store.includes(` ${site} `));
    if (planned !== undefined && !planned.endsWith(` ${checkedText(c.form)}`))
      problems.push(`planned ${planned}, not ${checkedText(c.form)}`);
    if (planned === undefined && c.values.some((each) => !each.fits))
      problems.push(`no planned check at ${site}`);
  }
  if (relation === "above") {
    const marks = marksAt(answers, c.site);
    if (judged === "domain" ? marks !== 1 : marks < 1)
      problems.push(`${marks} owned marks at the store above the stop`);
  }
  if (unsettledInferred && relation !== "at" && marksAt(answers, c.site) < 1)
    problems.push("no mark at a store into an inferred place before admission settled");
  return {
    allowance,
    stops: stopped.map((path) => path.join(".")),
    relation,
    phase,
    judged,
    problems,
  };
}
