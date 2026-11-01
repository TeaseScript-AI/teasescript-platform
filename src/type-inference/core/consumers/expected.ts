import { compileChild, runCompileTask, type CompileTask } from "../../../compiler/continuation.js";
import { VALUE_KIND_NAMES, VALUE_KINDS, type ValueKind } from "../../../value-kinds.js";
import type { PlaceId, SourceSite } from "../../graph.js";
import { fits } from "../admission.js";
import { joinSteps } from "../budget.js";
import type { Consumers } from "../consumers.js";
import { operatorOf } from "../contract.js";
import { kindsInOrder, type ItemTag } from "../items.js";
import { COMPARISONS, DIVISIONS, OPERATOR_ROWS } from "../operator-table.js";
import { siteKey, type Consumption } from "../program.js";
import type { SiteExpectation } from "../result.js";
import { hasMethod, hasProperty, operandDomain } from "./kinds.js";
import { indexOwner, kindsOf } from "./names.js";

/** The kinds `${...}` shows as text (V30 §8), by their own `shown` (TABLE r4.151 reads it from there). */
const SHOWN_KINDS: readonly ValueKind[] = VALUE_KIND_NAMES.filter(
  (kind) => VALUE_KINDS[kind].shown !== null,
);

/** A site no fact describes: no value is proved to fit it. */
const UNPROVED: SiteExpectation = {
  takes: [],
  binds: "whole",
  elements: "unproved",
  divides: "unproved",
};

/** What `say` shows (V30 §8): every kind `${...}` shows, and a list, set, dict or object in code-like notation. */
const SAID: readonly ValueKind[] = [...SHOWN_KINDS, "list", "set", "dict", "object"];

/**
 * TABLE r4.151: what the place the value at `site` lands in takes, read from what consumes it
 * (`CoreProgram.consumersOf`): a store's, an argument's or a result's place, its admitted type and its elements' (where
 * this value decides it, unwritten, what every read of it takes); a use, the kind it requires; nothing, where `say` shows
 * the value, what `say` shows (V30 §8: text, numbers and the other shown kinds, a list, set, dict or object in
 * notation), else nothing a fix can prove (a command the core does not model, such as `wait`). Where the consumer's
 * own result depends on the value (an operator's, a member's), the kinds it takes whose result its own site takes in
 * turn, up the expression to a consumer that does not; a comparison, a logic operator, an interpolation give one type
 * whatever they take. Any other consumer takes nothing a fix can prove. A divisor's value divides, and so does any
 * value an operation, a member, a fallback or a default computes its result from where that result divides (TABLE
 * r4.159).
 */
export function expected(walk: Consumers, site: SourceSite): SiteExpectation {
  // (one task per site or place, on the driver's own stack: a long chain of them is no native call depth, Codex r8)
  return runCompileTask(expectedTask(walk, site));
}

function* expectedTask(walk: Consumers, site: SourceSite): CompileTask<SiteExpectation> {
  const { program } = walk.pass;
  const key = siteKey(site);
  const known = walk.expectations.get(key);
  if (known !== undefined) return known;
  // (once per site, shared by every diagnosis below it and charged; a consumer that leads back to the site, as a `for`
  // loop's iterable does, proves nothing, Codex r6)
  walk.expectations.set(key, UNPROVED);
  program.work.charge("checks");
  const place = program.placeBySite.get(key);
  const consumers = place === undefined ? [] : (program.consumersOf.get(place) ?? []);
  let found: SiteExpectation;
  if (consumers.length === 1) found = yield* compileChild(consumerTakesTask(walk, consumers[0]!));
  else if (consumers.length === 0)
    found =
      program.effectNode(site)?.statement?.kind === "sayStatement"
        ? { takes: SAID, binds: "whole", elements: null, divides: false }
        : UNPROVED;
  else {
    // (several consumers: no type proved; it divides where one of them does, and not where every one proves not)
    const all: SiteExpectation[] = [];
    for (const consumer of consumers)
      all.push(yield* compileChild(consumerTakesTask(walk, consumer)));
    found = all.some((one) => one.divides === true)
      ? { ...UNPROVED, divides: true }
      : all.every((one) => one.divides === false)
        ? { ...UNPROVED, divides: false }
        : UNPROVED;
  }
  walk.expectations.set(key, found);
  return found;
}

/**
 * What every read of an unwritten place takes, a function's result each call (`read` consumptions): a kind each read
 * takes, by `fits`, and their elements'; any where nothing reads it. Once per place, charged per read.
 */
function* readsTakeTask(walk: Consumers, place: PlaceId): CompileTask<SiteExpectation> {
  const known = walk.placeExpectations.get(place);
  if (known !== undefined) return known;
  // (a read that leads back to the place, as a recursive call's argument does, proves nothing)
  walk.placeExpectations.set(place, UNPROVED);
  const { program } = walk.pass;
  // (what two reads take together, a composition: the kinds' fixed order, #1398)
  const both = (a: readonly ItemTag[], b: readonly ItemTag[]): ItemTag[] =>
    kindsInOrder([
      ...a.filter((tag) => b.some((other) => fits(tag, other, true))),
      ...b.filter((tag) => !a.includes(tag) && a.some((other) => fits(tag, other, true))),
    ]);
  let takes: readonly ItemTag[] | null = null;
  let elements: SiteExpectation["elements"] = null;
  for (const consumer of program.consumersOf.get(place) ?? []) {
    if (consumer.kind !== "read") continue;
    program.work.charge("checks");
    const site = program.place(consumer.occurrence).site;
    const read = site === null ? UNPROVED : yield* compileChild(expectedTask(walk, site));
    if (read.takes !== null) takes = takes === null ? read.takes : both(takes, read.takes);
    elements =
      elements === "unproved" || read.elements === "unproved"
        ? "unproved"
        : read.elements === null
          ? elements
          : elements === null
            ? read.elements
            : both(elements, read.elements);
  }
  const found: SiteExpectation = { takes, binds: "whole", elements, divides: "unproved" };
  walk.placeExpectations.set(place, found);
  return found;
}

/**
 * A place's admitted type, and its elements' where it holds a collection; where this value decides it, unwritten, what
 * its reads take (Codex r7, TABLE r4.160); beside values of other types, or below the place's root, nothing proved.
 */
function* placeTakesTask(
  walk: Consumers,
  root: PlaceId,
  path: readonly string[],
): CompileTask<SiteExpectation> {
  const { program } = walk.pass;
  // (a literal's own element or property: no type proved, and it divides where its literal does)
  const cell = program.cellOwner.get(root);
  if (cell !== undefined) {
    const site = program.place(cell.owner).site;
    const outer = site === null ? UNPROVED : yield* compileChild(expectedTask(walk, site));
    return { ...UNPROVED, divides: outer.divides };
  }
  // (a place's value is read by later statements, where a zero it holds is the script's own, TABLE r4.159)
  const placed = (found: SiteExpectation): SiteExpectation => ({ ...found, divides: false });
  const admitted = (at: readonly string[]): ItemTag[] | null => {
    const tags = walk.admission.admitted(root, at).filter((tag) => tag !== "empty");
    return tags.length === 0 || tags.includes("unknown") ? null : tags;
  };
  const takes = admitted(path);
  if (takes === null) {
    const others = walk.admission
      .admitted(root, path)
      .some((tag) => tag !== "empty" && tag !== "unknown");
    return placed(
      path.length > 0 || others ? UNPROVED : yield* compileChild(readsTakeTask(walk, root)),
    );
  }
  return placed({
    takes,
    binds: "whole",
    elements: takes.some((tag) => tag === "list" || tag === "set" || tag === "dict")
      ? (admitted(joinSteps(path, ["element"])) ?? "unproved")
      : null,
    divides: false,
  });
}

function* consumerTakesTask(walk: Consumers, consumer: Consumption): CompileTask<SiteExpectation> {
  const { program } = walk.pass;
  // (a value whose consumer computes its result from it divides where that result does, unproved where that is; a
  // scalar the consumer takes has no elements to prove)
  const computed = (
    takes: readonly ItemTag[],
    binds: SiteExpectation["binds"],
    outer: SiteExpectation,
  ): SiteExpectation => ({ takes, binds, elements: "unproved", divides: outer.divides });
  switch (consumer.kind) {
    case "store": {
      const target = program.targetRoot(consumer.into, true);
      return yield* compileChild(placeTakesTask(walk, target.root, target.path));
    }
    case "argument": {
      const fn = program.functionOf(consumer.fn);
      const parameter =
        typeof consumer.parameter === "number"
          ? fn.parameters[consumer.parameter]
          : program.parameterPlace(consumer.fn, consumer.parameter);
      // (a function the value is passed to reads it in later statements, TABLE r4.159)
      return parameter === undefined
        ? { ...UNPROVED, divides: false }
        : yield* compileChild(placeTakesTask(walk, parameter, []));
    }
    case "return":
      return yield* compileChild(placeTakesTask(walk, program.functionOf(consumer.fn).result, []));
    case "operand": {
      const c = consumer.operation;
      const { family } = c.contract;
      // (its result's own site: an interpolation's is its text's, not the interpolated value's, Codex r10)
      const outer = yield* compileChild(expectedTask(walk, program.place(c.result).site ?? c.site));
      if (family === "interpolation") return computed(SHOWN_KINDS, "whole", outer);
      if (family === "logic") return computed(["boolean"], "operand", outer);
      // (a range's bounds are whole numbers, and it is a range whatever they are)
      if (family === "range") return computed(["integer"], "operand", outer);
      const operator = operatorOf(c);
      const node = program.exprAt(c.site);
      // (an operation the table does not hold, or whose operands have no flow point, as a compound assignment's have
      // not: nothing proved of what it takes, Codex r8)
      if (operator === null || node === null) return computed([], "operand", outer);
      const operands = c.arguments.map((argument) => kindsOf(walk, argument, node));
      const rows = OPERATOR_ROWS.filter((row) => row.operator === operator);
      const domain = operandDomain(rows, operands, consumer.index).filter(
        (kind): kind is ValueKind => kind !== "unknown" && kind !== "non-null",
      );
      // (a comparison gives true or false whatever it takes; a calculation's result is its operands', which its own
      // site takes in turn)
      if (COMPARISONS.some((found) => found === operator))
        return computed(domain, "operand", outer);
      const results = (kind: ValueKind): ValueKind[] =>
        rows
          .filter(
            (row) =>
              row.operands[consumer.index] === kind &&
              operands.every(
                (items, other) =>
                  other === consumer.index ||
                  items.length === 0 ||
                  items.some((item) => item.tag === "unknown" || row.operands[other] === item.tag),
              ),
          )
          .map((row) => row.result);
      // (a divisor, or an operand whose zero can give a zero result where that result divides)
      const divides: SiteExpectation["divides"] =
        DIVISIONS.some((found) => found === operator) && consumer.index === 1
          ? true
          : outer.divides;
      return {
        takes: domain.filter((kind) => {
          if (outer.takes === null) return true;
          const found = results(kind);
          return (
            found.length > 0 &&
            found.every((result) => outer.takes!.some((tag) => fits(result, tag, true)))
          );
        }),
        binds: "operand",
        elements: outer.takes === null ? null : outer.elements,
        divides,
      };
    }
    case "method": {
      // (a method's result the core reads by its receiver's kind, which no fix proves: any where its site takes any)
      const outer = yield* compileChild(expectedTask(walk, consumer.site));
      return {
        takes:
          outer.takes === null
            ? VALUE_KIND_NAMES.filter((kind) => hasMethod(kind, consumer.name))
            : [],
        binds: "receiver",
        elements: null,
        divides: outer.divides,
      };
    }
    case "access": {
      const step = consumer.step.step;
      // (a loop's iterable: what its variable then holds the loop's body reads, which no fact here follows)
      if (step === "iteration")
        return { takes: [], binds: "receiver", elements: "unproved", divides: false };
      const outer = yield* compileChild(expectedTask(walk, consumer.step.site));
      // (a member's result: a length a whole number, any other read's only where its site takes any)
      const property = typeof step === "object" ? step.property : null;
      const gives: readonly ValueKind[] | null = property === "length" ? ["integer"] : null;
      const holds =
        outer.takes === null ||
        (gives !== null &&
          gives.every((kind) => outer.takes!.some((tag) => fits(kind, tag, true))));
      return {
        takes: !holds
          ? []
          : property !== null
            ? VALUE_KIND_NAMES.filter((kind) => hasProperty(kind, property))
            : step === "index"
              ? ["list", "dict"]
              : [],
        binds: "receiver",
        elements: null,
        divides: outer.divides,
      };
    }
    case "part": {
      // (a side of `otherwise`, a default, a named argument: its type must also fit the value it stands beside (C10),
      // which no fact here proves, Codex r9; it divides where the result does)
      const site = program.place(consumer.result).site;
      const outer = site === null ? UNPROVED : yield* compileChild(expectedTask(walk, site));
      return computed([], "operand", outer);
    }
    case "use": {
      if (consumer.what !== "index")
        return {
          takes:
            consumer.what === "condition"
              ? ["boolean"]
              : consumer.what === "count"
                ? ["integer"]
                : ["string"],
          binds: "whole",
          elements: "unproved",
          divides: false,
        };
      // (an index takes a list's whole number or a dict's text, by its receiver)
      const owner = indexOwner(walk, consumer.span);
      const kinds =
        owner === undefined
          ? []
          : kindsOf(walk, owner, program.exprAt(consumer.span)).map((item) => item.tag);
      const only = (tag: ItemTag): boolean =>
        kinds.length > 0 && kinds.every((found) => found === tag);
      // (it picks the script's own element, whose value is the script's, TABLE r4.160)
      return {
        takes: only("list") ? ["integer"] : only("dict") ? ["string"] : [],
        binds: "whole",
        elements: "unproved",
        divides: false,
      };
    }
    case "read":
    case "other":
      return UNPROVED;
  }
}
