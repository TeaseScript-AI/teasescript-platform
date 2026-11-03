import type { PlaceId, SourceSite } from "../../graph.js";
import { Admission } from "../admission.js";
import { joinParts, joinSteps, keepText, keptArray } from "../budget.js";
import type { Consumers } from "../consumers.js";
import { termAt, writtenOf } from "../contract.js";
import { kindsInOrder, type ItemTag } from "../items.js";
import { propertyStep, type ValueConstraint } from "../program.js";
import type { DiagnosticRule } from "../result.js";
import { error } from "./diagnostics.js";
import { heldKinds, mixedAnswer, oneType, passedOperands } from "./kinds.js";
import type { Landing, LandingQuestion } from "./model.js";
import { copiesOnly, firstDirect, valueReach } from "./reach.js";
import { placeText, storeRoot, storeSteps } from "./warnings.js";

// Values of more than one type (ADR 0021 1.3): a literal's elements where it lands, a list join's (#1272), and an
// `askChoice`'s answer where its type would be inferred (V30 §19, #1352).

/**
 * Where a literal lands (A2): the place and the key path that a whole store, an add (an added list as the collection
 * itself, an added element one step below), or the literals around it (a collection's cell as `element`, an object's
 * property by name) put it at; `null` where nothing stores it. Each literal is placed once, from the nearest literal
 * above it already placed.
 */
function landingOf(walk: Consumers, literal: PlaceId): Landing | null {
  const { program, definitions } = walk.pass;
  const known = walk.landings.get(literal);
  if (known !== undefined) return known;
  const chain: { readonly literal: PlaceId; readonly step: string }[] = [];
  let node: Landing | null = null;
  for (let at = literal; ;) {
    const placed = walk.landings.get(at);
    if (placed !== undefined) {
      node = placed;
      break;
    }
    program.work.charge("checks");
    const d = (definitions.byValue.get(at) ?? []).find(
      (each) => each.kind === "whole" || each.kind === "add",
    );
    if (d === undefined) {
      walk.landings.set(at, null);
      break;
    }
    const owner = d.kind === "whole" ? program.cellOwner.get(d.place) : undefined;
    if (owner === undefined) {
      // (an added element's path made here is kept with the node; a definition's is its own)
      const path =
        d.kind === "add" && d.how !== "elements"
          ? keptArray(program.work, joinSteps(d.path, ["element"]))
          : d.path;
      node = {
        id: walk.landingCount++,
        place: d.place,
        above: null,
        step: "",
        path,
        below: new Map(),
      };
      walk.landings.set(at, node);
      break;
    }
    const kind = program.place(d.place).kind;
    chain.push({
      literal: at,
      step: kind.kind === "property" ? propertyStep(kind.name) : "element",
    });
    at = owner.owner;
  }
  for (let at = chain.length - 1; at >= 0; at -= 1) {
    const { literal: link, step } = chain[at]!;
    if (node !== null) {
      let next: Landing | undefined = node.below.get(step);
      if (next === undefined) {
        next = {
          id: walk.landingCount++,
          place: node.place,
          above: node,
          step,
          path: null,
          below: new Map(),
        };
        node.below.set(step, next);
      }
      node = next;
    }
    walk.landings.set(link, node);
  }
  return node;
}

/** A mixed literal's question at its landing and a path below it: the key path and whether only copies bring it. */
function landingQuestion(
  walk: Consumers,
  node: Landing,
  below: readonly string[],
): LandingQuestion | null {
  const memoKey = joinParts(node.id, below);
  let question = walk.questions.get(memoKey);
  if (question === undefined) {
    keepText(walk.pass.program.work, memoKey.length);
    const path = joinSteps(landingPath(walk, node), ["element"], below);
    const last = path.at(-1);
    // (only a question kept keeps its path)
    question =
      last === undefined || last === "element" || last === "entry"
        ? null
        : {
            path: keptArray(walk.pass.program.work, path),
            copiesOnly: copiesOnly(walk, node.place, path),
            first: undefined,
            into: null,
          };
    walk.questions.set(memoKey, question);
  }
  return question;
}

/** A landing's key path, made once: its steps up to the nearest landing that has its path, below that path. */
function landingPath(walk: Consumers, node: Landing): readonly string[] {
  if (node.path !== null) return node.path;
  const steps: string[] = [];
  let at: Landing = node;
  while (at.path === null) {
    steps.push(at.step);
    at = at.above!;
  }
  node.path = keptArray(walk.pass.program.work, joinSteps(at.path, steps.reverse()));
  return node.path;
}

/**
 * ADR 0021 1.3, A8: a literal's element of another type than the earliest element's (`Admission.literalElements`): an
 * error at the offending element, also where a copy brought it into a property and the copies meet there (A2, TABLE
 * r4.131); where they were not found to meet (a cycle of copies that adds or takes steps, r4.154), at the property's
 * first direct read or store.
 */
export function mixed(
  walk: Consumers,
  site: SourceSite,
  found: Parameters<Parameters<Admission["literalElements"]>[1]>[1],
): void {
  const { program } = walk.pass;
  const owner = program.cellOwner.get(found.cell);
  const literal = owner?.kind === "cell" ? owner.owner : undefined;
  const cell = program.place(found.cell).kind;
  const step = cell.kind === "cell" ? cell.step : "element";
  // the place the literal lands in, through which a later read reaches the property
  const store =
    literal === undefined || found.path.length === 0 || found.atCopy
      ? null
      : landingOf(walk, literal);
  if (store !== null) {
    // (a key's steps: a dict value is an `element`, as `targetRoot` makes it)
    const below = found.path.map((at) => (at === "entry" ? "element" : at));
    const reach = found.d.value === undefined ? null : valueReach(walk, found.d.value, below);
    // (the offending element and every other contribution through whole copies; each landing's question once)
    const question = reach !== null && reach.brought ? landingQuestion(walk, store, below) : null;
    if (question !== null && question.copiesOnly) {
      if (question.first === undefined)
        question.first = firstDirect(walk, store.place, question.path);
      const copy = reach!.copy === null ? null : (program.places[reach!.copy]?.site ?? null);
      if (question.first !== null) {
        question.into ??= placeText(walk, store.place, question.path);
        mixedError(
          walk,
          question.first,
          {
            rule: "store",
            into: question.into,
            type: found.decided,
            written: false,
            decider: null,
            brought: copy ?? site,
            root: storeRoot(walk, store.place),
            steps: storeSteps(walk, store.place, question.path),
          },
          found.kinds,
        );
        return;
      }
    }
  }
  const node = literal === undefined ? null : program.place(literal).kind;
  mixedError(
    walk,
    site,
    {
      rule: "mixed",
      collection:
        node?.kind === "value" && node.node === "setLiteral"
          ? "set"
          : step === "entry"
            ? "dict"
            : "list",
      path: found.path,
      type: found.earliest,
      // (the variable the literal is the start value of)
      root: ((d) => (d === undefined ? null : storeRoot(walk, d.place)))(
        literal === undefined
          ? undefined
          : (walk.pass.definitions.byValue.get(literal) ?? []).find(
              (each) => each.kind === "whole" && each.path.length === 0,
            ),
      ),
    },
    found.kinds,
  );
}

/**
 * ADR 0021 1.3, V30 §4 and §16: a list's `+` whose right operand's elements are of another type than the left's
 * (`Admission.joinElements`, #1272): an error at the join, a `+=`'s at its right operand, as the current checker gives
 * it. Its fix declares the variable whose start value the joined list is, with its own start value (#1268, TABLE
 * r4.146), and names the type in words elsewhere (`mixedJoinFix`).
 */
export function mixedJoin(
  walk: Consumers,
  found: Parameters<Parameters<Admission["joinElements"]>[1]>[0],
): void {
  const { program } = walk.pass;
  const { c } = found;
  const right = c.arguments[1]!;
  const place = program.place(c.result).kind;
  const compound = place.kind === "value" && place.node === "compound";
  const start = (walk.pass.definitions.byValue.get(found.value) ?? []).find(
    (d) =>
      d.kind === "whole" &&
      d.path.length === 0 &&
      (d.how === "initializer" || d.how === "parameter default"),
  );
  mixedError(
    walk,
    compound ? (program.places[right]?.site ?? c.site) : c.site,
    {
      rule: "mixed",
      collection: "list",
      path: found.path,
      type: found.earliest,
      root: start === undefined ? null : storeRoot(walk, start.place),
      operator: compound ? "+=" : "+",
      levels: found.levels,
    },
    found.kinds,
  );
}

/**
 * Per pass, the sites of the literals' and joins' errors of mixed elements (`mixed`, `mixedJoin`, made before the walk,
 * `Consumers.check`), and whether they are in order yet.
 */
const MIXED_SITES = new WeakMap<Consumers, { sites: SourceSite[]; sorted: boolean }>();

/** A literal's or a join's error of mixed elements, its site recorded for `holdsMixed`. */
function mixedError(
  walk: Consumers,
  site: SourceSite,
  rule: DiagnosticRule,
  kinds: readonly ItemTag[],
): void {
  error(walk, "written-target", site, rule, kinds);
  let made = MIXED_SITES.get(walk);
  if (made === undefined) MIXED_SITES.set(walk, (made = { sites: [], sorted: true }));
  made.sites.push(site);
  made.sorted = false;
}

/**
 * Whether a literal's or a join's error of mixed elements lies within `site`: a search of their sites, by start, each
 * step charged (their sort once, by their number).
 */
function holdsMixed(walk: Consumers, site: SourceSite): boolean {
  const made = MIXED_SITES.get(walk);
  if (made === undefined) return false;
  if (!made.sorted) {
    walk.pass.program.work.charge("checks", made.sites.length);
    made.sites.sort((a, b) => a.file - b.file || a.start - b.start);
    made.sorted = true;
  }
  const { sites } = made;
  // (the first at or after the site's start, which lies within it where any does)
  let low = 0;
  let high = sites.length;
  while (low < high) {
    walk.pass.program.work.charge("checks");
    const middle = (low + high) >> 1;
    const at = sites[middle]!;
    if (at.file < site.file || (at.file === site.file && at.start < site.start)) low = middle + 1;
    else high = middle;
  }
  const first = sites[low];
  return first !== undefined && first.file === site.file && first.end <= site.end;
}

/**
 * V30 §13, §19 (#1352): an `askChoice` whose buttons return more than one type (`mixedAnswer`) is an error at the
 * choice where its answer, as it stands or through what passes it on unchanged (`passedOperands`: an `otherwise`, a
 * `get`'s default), lands in a place whose type would be inferred and so would be their union: a store, an argument, a
 * return or an add, or a literal holding it where the literal lands (`landingOf`), into a place with no written type
 * there, none unrestricted above it and none a copy brings (A4), whose admitted type (A2: every type stored there where
 * no store decides one) holds more than one type. A place another store decides as one type keeps that store's check
 * (C1). An argument's call alone types its parameter (V30 §11): its own value's types decide it, whatever another call
 * passes. Once per choice, at its first such store.
 */
export function mixedChoice(
  walk: Consumers,
  c: Extract<ValueConstraint, { readonly kind: "operation" }>,
): void {
  const answer = mixedAnswer(walk, c.result);
  // (a list or set option whose elements mix is that literal's error already, as the current checker gives it)
  if (answer === null || holdsMixed(walk, c.site)) return;
  const { program, definitions } = walk.pass;
  const { admission } = walk;
  // (the values the answer is, unchanged: each once, in the order reached)
  const values = [c.result];
  const reached = new Set(values);
  for (let at = 0; at < values.length; at += 1) {
    const uses = program.consumersOf.get(values[at]!) ?? [];
    program.work.charge("checks", uses.length);
    for (const use of uses)
      if (
        use.kind === "part" &&
        !reached.has(use.result) &&
        passedOperands(program.opOf.get(use.result)).includes(values[at]!)
      ) {
        reached.add(use.result);
        values.push(use.result);
      }
  }
  for (const value of values) {
    const stores = definitions.byValue.get(value) ?? [];
    program.work.charge("checks", stores.length);
    for (const d of stores) {
      if (d.kind !== "whole" && d.kind !== "add") continue;
      // (a literal's cell: where the literal lands, at the cell's step below it)
      const owner = program.cellOwner.get(d.place);
      let place = d.place;
      let path = admission.destPath(d);
      if (owner !== undefined) {
        const landing = landingOf(walk, owner.owner);
        if (landing === null) continue;
        const cell = program.place(d.place).kind;
        place = landing.place;
        path = joinSteps(landingPath(walk, landing), [
          cell.kind === "property" ? propertyStep(cell.name) : "element",
        ]);
      }
      const written = writtenOf(program.place(place).kind);
      if (written !== null && termAt(written, path) !== null) continue;
      // (below an unrestricted written part, the place's own or a copy's, every type fits: `unknown`, one type)
      const admitted = admission.admitted(place, path);
      const own = heldKinds(walk, value);
      const argument = d.how === "argument";
      if (argument ? own === null || oneType(own) : admission.inheritsWritten(place, path))
        continue;
      // (the union to declare: every type the place takes, this value's among them)
      const type = kindsInOrder(new Set([...admitted, ...(own ?? [])]));
      if (!argument && oneType(admitted)) continue;
      const steps = storeSteps(walk, place, path);
      error(
        walk,
        "written-target",
        c.site,
        {
          rule: "mixed-choice",
          into: placeText(walk, place, path),
          root: storeRoot(walk, place),
          steps,
          type,
          // (a collection root that holds null beside its lists: an optional collection, V30 §13)
          ...(steps.length === 1 && admission.admitted(place, []).includes("null")
            ? { optional: true as const }
            : {}),
        },
        answer,
      );
      return;
    }
  }
}
