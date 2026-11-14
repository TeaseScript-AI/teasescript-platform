import type { ContractFamily, PlaceId, TypeTerm } from "../../../graph.js";
import { VALUE_KIND_NAMES } from "../../../../value-kinds.js";
import { valueRoute } from "../../contract/value-kinds.js";
import { operatorOf } from "../../contract/operations.js";
import { conversionKind, unitKind } from "../../contract/terms.js";
import {
  builtinResult,
  clockResult,
  conversionCategory,
  declaredMethod,
  declaredProperty,
  declaredResult,
  dictList,
  interactionCategory,
  kindElement,
  measuresLength,
  memberResult,
  methodCategory,
  shownResult,
} from "../../method-categories.js";
import { OPERATOR_ROWS } from "../../operator-table.js";
import type { Definition } from "../../definitions.js";
import type { CoreProgram, ValueConstraint } from "../../program.js";
import { NOTHING } from "./components.js";

/*
 * #2764: the element level a value brings by itself, before any route (`routesOf`) brings one: the deepest level below
 * its root at which the contract answers a kind of its own. The rules follow the contract's own dispatch
 * (`valueRoute`, `contractOfOp`) and read the tables it reads; each switch is exhaustive, so a new route, family or
 * term fails to compile here. A level may be above what the contract knows (the cut is then deeper), never below it.
 */

/** The levels a kind holds by itself: its declared elements' (`kindElement`, a range's whole numbers), and theirs. */
export function kindLevel(kind: string): number {
  let level = 0;
  for (let element = kindElement(kind); element !== undefined; element = kindElement(element))
    level += 1;
  return level;
}

/** The deepest `kindLevel` among `kinds`, a table's rows (`undefined` where it has none); 0 for none. */
function kindsLevel(kinds: readonly (string | undefined)[]): number {
  return Math.max(0, ...kinds.map((kind) => (kind === undefined ? 0 : kindLevel(kind))));
}

/**
 * The levels a type term spells: a list's, a set's or a dict's element one below it, a kind's declared elements, a
 * union's deepest member, an object's deepest property (names ignored, as the graph's phase 1 ignores them). `never`
 * holds no value, an unwritten part (`dynamic`) none the compiler knows; the type of another place (`ref`, a literal's
 * cell) brings its level by that place's route.
 */
export function termLevel(term: TypeTerm): number {
  let level = NOTHING;
  // (a written term nests as deep as it is written: walked on a stack)
  const pending: { readonly term: TypeTerm; readonly at: number }[] = [{ term, at: 0 }];
  for (let next = pending.pop(); next !== undefined; next = pending.pop()) {
    const { term: at, at: depth } = next;
    switch (at.kind) {
      case "list":
      case "set":
      case "dict":
        level = Math.max(level, depth);
        pending.push({ term: at.element, at: depth + 1 });
        break;
      case "atom":
      case "restricted":
        level = Math.max(level, depth + kindLevel(at.name));
        break;
      case "union":
        for (const member of at.members) pending.push({ term: member, at: depth });
        break;
      case "object":
        level = Math.max(level, depth);
        for (const property of at.properties ?? [])
          pending.push({ term: property.type, at: depth });
        break;
      case "dynamic":
      case "ref":
      case "never":
        break;
      default:
        return at satisfies never;
    }
  }
  return level;
}

/**
 * The level a place brings by itself. A variable, a parameter, a result, a literal's cell or property holds what
 * reaches it and the terms it has (a dict loop's key, a block's own handle). An expression's value is a kind at its
 * root, level 0 at least, whatever reaches it; below its root, by the contract's own classification of it
 * (`valueRoute`), a read, a call's result, a fallback, a `get` and a choice (a scalar button, V30 §19, TSV029) hold
 * what their routes bring, a literal the term it has, a projection and an operation what their tables declare.
 */
export function ownLevel(program: CoreProgram, place: PlaceId): number {
  // (a loop's target is a projection)
  if (!program.projOf.has(place) && program.places[place]?.kind.kind !== "value")
    return hasLevel(program, place);
  const route = valueRoute(program, place);
  switch (route) {
    case "binding":
    case "call":
    case "composite":
    case "choice":
    case "speaker":
    case "opaque":
      return 0;
    case "literal":
      return Math.max(0, hasLevel(program, place));
    case "projection":
      return Math.max(0, projectionLevel(program.projOf.get(place)!.step));
    case "operation":
      return Math.max(0, operationLevel(program.opOf.get(place)!));
    default:
      return route satisfies never;
  }
}

/** The deepest level of the terms a place has (`has`). */
function hasLevel(program: CoreProgram, place: PlaceId): number {
  return Math.max(NOTHING, ...(program.hasOf.get(place) ?? []).map((has) => termLevel(has.type)));
}

/**
 * A fixed value's definition (`const`: a function's `null` where its body ends without a value, a dict loop's text
 * key): its kinds' levels below its path's element steps.
 */
export function definedLevel(d: Definition): number {
  const elements = d.path.filter((step) => step === "element").length;
  return elements + kindsLevel((d.items ?? []).map((item) => item.tag));
}

/**
 * A projection's own level: a loop's value is a kind (a dict's key, text; a kind's declared element, `kindElement`); a
 * length a whole number; a dict's `keys` a list of its keys, text; a declared property its kind. An element, a
 * selection, an object's property and a dict's `values` bring what their routes bring. A property of an object that
 * shares a built-in's name is taken as the built-in: its level is then above what the contract knows, never below.
 */
function projectionLevel(step: string): number {
  if (step === "iteration")
    return Math.max(kindLevel("string"), kindsLevel(VALUE_KIND_NAMES.map(kindElement)));
  if (measuresLength(step)) return kindLevel("integer");
  if (dictList(step) === "keys") return 1 + kindLevel("string");
  return Math.max(
    NOTHING,
    ...VALUE_KIND_NAMES.map((kind) => declaredProperty(kind, step)).map((result) =>
      result === undefined ? NOTHING : kindLevel(result),
    ),
  );
}

/** An operation's own level: its declared result's (`contractOfOp`'s tables); none where its operands' bring it. */
function operationLevel(c: ValueConstraint): number {
  switch (c.kind) {
    case "fallback":
    case "get":
    case "call":
      return NOTHING;
    // the written type the load is read into, or its default's routes (`load default`)
    case "load":
      return c.receiver === null ? 0 : termLevel(c.receiver);
    case "operation":
      return familyLevel(c);
    default:
      return c satisfies never;
  }
}

/** An operation's declared result by its family, from the table `contractOfOp` reads for it. */
function familyLevel(c: Extract<ValueConstraint, { readonly kind: "operation" }>): number {
  const { name } = c.contract;
  const family: ContractFamily = c.contract.family;
  switch (family) {
    case "method": {
      const category = methodCategory(name);
      // (a copy and a removal bring the receiver's levels by their routes, a kind's declared elements among them)
      if (category !== undefined)
        return category.gives.kind === "declared"
          ? kindsLevel(declaredResult(name, category.gives.kinds, "unknown"))
          : NOTHING;
      return kindsLevel(VALUE_KIND_NAMES.flatMap((kind) => declaredMethod(kind, name) ?? []));
    }
    case "member":
      return kindsLevel(memberResult(name) ?? []);
    case "operator":
    case "unary":
    case "comparison": {
      const operator = operatorOf(c);
      return kindsLevel(
        OPERATOR_ROWS.filter((row) => row.operator === operator).map((row) => row.result),
      );
    }
    case "logic":
    case "typeTest":
      return kindLevel("boolean");
    case "interpolation":
      return kindLevel("string");
    case "say":
      return kindLevel("messageHandle");
    case "unit":
    case "angle":
      return kindLevel(unitKind(family, name));
    case "range":
      return kindLevel("range");
    case "conversion": {
      const conversion = conversionCategory(name);
      // (a parse's result is typed where it lands, a written place, or by its default's routes)
      return conversion?.kind === "converts" ? kindLevel(conversionKind(conversion.result)) : 0;
    }
    case "interaction": {
      const interaction = interactionCategory(name);
      return interaction?.kind === "asks" ? kindLevel(interaction.result) : 0;
    }
    case "clock":
      return kindsLevel([clockResult(name)]);
    case "timer":
    case "media":
      return kindLevel(family);
    case "showButton":
    case "popup":
    case "camera":
      return kindsLevel([shownResult(name)]);
    case "builtin":
      return kindLevel(builtinResult(name));
    // the runtime's answers: unknown below their root
    case "random":
    case "numeric":
    case "listFunction":
    case "speakerField":
    case "tagQuery":
    case "capture":
      return 0;
    default:
      return family satisfies never;
  }
}
