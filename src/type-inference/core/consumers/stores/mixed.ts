import type { PlaceId, SourceSite } from "../../../graph.js";
import { Admission } from "../../admission.js";
import { joinParts, joinSteps, keepText, keptArray } from "../../budget.js";
import type { Consumers } from "../../consumers.js";
import { termAt, writtenOf } from "../../contract.js";
import { kindsInOrder, type ItemTag } from "../../items.js";
import { propertyStep, type ValueConstraint } from "../../program.js";
import type { DiagnosticRule } from "../../result.js";
import { error } from "../reports/diagnostics.js";
import { answerRead, oneType, passedOperands, recordAnswer } from "../kinds.js";
import type { Landing, LandingQuestion } from "../model.js";
import { copiesOnly, firstDirect, valueReach } from "./reach.js";
import { placeText, storeRoot, storeSteps } from "../reports/warnings.js";

// Values of more than one type (ADR 0021 1.3): a literal's elements where it lands, a list join's (#1272), and an
// `askChoice`'s answer where its type would be inferred (V30 §19, #1352).

/**
 * Where a literal lands: the place and the key path that a whole store, an add (an added list as the collection
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
 * ADR 0021 1.3: a literal's element of another type than the earliest element's (`Admission.literalElements`): an
 * error at the offending element, also where a copy brought it into a property and the copies meet there; where
 * they were not found to meet (a cycle of copies that adds or takes steps,
 * docs/specifications/type-inference-accepted-record/admission.md#r4-154), at the property's first direct read or
 * store.
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
      ...(found.shown === undefined ? {} : { shown: found.shown }),
      type: found.earliest,
      ...(found.optional === undefined ? {} : { optional: found.optional }),
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
 * it. Its fix declares the variable whose start value the joined list is, with its own start value (#1268),
 * and names the type in words elsewhere (`mixedJoinFix`).
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
      ...(found.shown === undefined ? {} : { shown: found.shown }),
      type: found.earliest,
      root: start === undefined ? null : storeRoot(walk, start.place),
      operator: compound ? "+=" : "+",
      levels: found.levels,
      ...(found.optional === undefined ? {} : { optional: found.optional }),
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

/** What a mixed answer's first store into a place whose type would be inferred says (`mixedChoice`). */
type Stored = Omit<Extract<DiagnosticRule, { rule: "mixed-choice" }>, "rule">;

/** Per pass, each value's first such store, its own or one a value it passes on reaches (`passedOperands`), once. */
const REACHED = new WeakMap<Consumers, Map<PlaceId, Stored | null>>();

/**
 * The first store of `value` itself (a store, an argument, a return, an add, or a literal holding it where the literal
 * lands, `landingOf`) into a place with no written type there whose type would be a union: its admitted type (the
 * decision, else every type stored there; `unknown` below an unrestricted written part, the place's own or a copy's)
 * holds more than one type and comes from no copy of a written type; a place another store decides as one type keeps
 * that store's check. An argument's call alone types its parameter (V30 §11): its own value's known types
 * decide it, whatever another call passes. The union to declare is every type the place takes, this value's among them.
 */
function storedUnion(walk: Consumers, value: PlaceId): Stored | null {
  const { program, definitions } = walk.pass;
  const { admission } = walk;
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
    const admitted = admission.admitted(place, path);
    const own = answerRead(walk, value).kinds;
    const argument = d.how === "argument";
    if (argument ? oneType(own) : admission.inheritsWritten(place, path) || oneType(admitted))
      continue;
    const steps = storeSteps(walk, place, path);
    return {
      into: placeText(walk, place, path),
      root: storeRoot(walk, place),
      steps,
      type: kindsInOrder(new Set([...admitted.filter((tag) => tag !== "unknown"), ...own])),
      // (a collection root that holds null beside its lists: an optional collection, V30 §13)
      ...(steps.length === 1 && admission.admitted(place, []).includes("null")
        ? { optional: true as const }
        : {}),
    };
  }
  return null;
}

/**
 * The first store whose place's type would be a union of `value`'s, or of what it passes on (`passedOperands`), its
 * own stores first, then each value it reaches in order: each value once per pass (`REACHED`), however many choices
 * reach it, in an explicit post-order, so a chain of `otherwise`s costs its length (#1660).
 */
function reachedUnion(walk: Consumers, start: PlaceId): Stored | null {
  const { program } = walk.pass;
  let memo = REACHED.get(walk);
  if (memo === undefined) REACHED.set(walk, (memo = new Map()));
  const known = memo.get(start);
  if (known !== undefined) return known;
  const next = new Map<PlaceId, PlaceId[]>();
  const stack: { readonly value: PlaceId; readonly expanded: boolean }[] = [
    { value: start, expanded: false },
  ];
  while (stack.length > 0) {
    const { value, expanded } = stack.pop()!;
    if (memo.has(value)) continue;
    if (expanded) {
      // (what a warning keeping this value declares, from a settled read alone: its known types where more than one,
      // none for one; a stopped read proves neither, whatever it holds)
      const read = answerRead(walk, value);
      recordAnswer(walk, value, read.stopped ? "stopped" : oneType(read.kinds) ? [] : read.kinds);
      let found = storedUnion(walk, value);
      for (const to of next.get(value)!) found ??= memo.get(to) ?? null;
      memo.set(value, found);
      continue;
    }
    if (next.has(value)) continue;
    const uses = program.consumersOf.get(value) ?? [];
    program.work.charge("checks", uses.length);
    const to = uses.flatMap((use) =>
      use.kind === "part" && passedOperands(program.opOf.get(use.result)).includes(value)
        ? [use.result]
        : [],
    );
    next.set(value, to);
    stack.push({ value, expanded: true });
    for (const each of to.toReversed())
      if (!memo.has(each) && !next.has(each)) stack.push({ value: each, expanded: false });
  }
  return memo.get(start) ?? null;
}

/**
 * V30 §13, §19 (#1352): an `askChoice` whose buttons return more than one type (its known types, `answerRead`, of more than one: V30 §19,
 * whole numbers with numbers one type, `null` beside a type optional, an unknown button adding none) is an error at the
 * choice where its answer, as it stands or through what passes it on unchanged (`passedOperands`), lands in a place
 * whose type would be their union (`storedUnion`), at its first such store (`reachedUnion`); once per choice.
 */
function mixedChoice(
  walk: Consumers,
  c: Extract<ValueConstraint, { readonly kind: "operation" }>,
): void {
  // (the choice's answer: one known type from a settled read, nothing to record; more than one, the error where it
  // lands, proved whether its read settled or stopped, since a stop only hides types. A stopped read of one known type
  // proves neither: it records what it reaches, each value's own read settled or stopped, and makes no error, #1660)
  const read = answerRead(walk, c.result);
  if (oneType(read.kinds) && !read.stopped) return;
  const stored = reachedUnion(walk, c.result);
  if (oneType(read.kinds)) return;
  const answer = read.kinds;
  // (a list or set option whose elements mix is that literal's error already, as the current checker gives it; what
  // the answer reaches is still recorded)
  if (stored !== null && !holdsMixed(walk, c.site))
    error(walk, "written-target", c.site, { rule: "mixed-choice", ...stored }, answer);
}

/**
 * The mixed choices' check (#1352), the last of `Consumers.check`: `mixedChoice` of every `askChoice` outside the
 * units past the nesting limit, in the consumers' order, each read with its choice's demand allowance and each its own
 * unit (`Consumers.startUnit`: a stop takes back the running choice's findings alone, #1660); run after every other
 * consumer's read and the publication, so no read of the pass that can stop at its demand allowance comes after its
 * reads.
 * A choice past the nesting limit has no published warning that reads its record (TSV076 defers them).
 */
export function mixedChoices(walk: Consumers): void {
  const { program } = walk.pass;
  const choices = program.constraints.filter(
    (c): c is Extract<ValueConstraint, { readonly kind: "operation" }> =>
      c.kind === "operation" && c.evidence?.kind === "choice",
  );
  for (const c of walk.order(choices)) {
    // (each choice its own unit: a stop takes back the running choice's findings alone, #1660)
    if (!walk.startUnit(c.site)) continue;
    const node = program.exprAt(c.site);
    if (node === null) continue;
    walk.reading = node;
    mixedChoice(walk, c);
  }
  walk.reading = null;
}
