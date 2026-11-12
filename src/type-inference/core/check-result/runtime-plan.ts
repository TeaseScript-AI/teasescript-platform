// The plan's runtime checks: the checks the warnings and the stop's deferred warnings owe at their stores
// (`runtimeChecks`), the count the stop's warning names (`movedChecks`), and the lost-check gate (`lostCheck`, with
// `settledOwed`).
import type {
  BinaryExpression,
  Expression,
  AssignmentStatement,
  CallExpression,
  LoadExpression,
} from "../../../ast.js";
import {
  type TypeCheckPlan,
  type TypePlan,
  type PartCheckPlan,
  repairedObject,
  type PartStep,
} from "../../../plan/model.js";
import { type StaticType, union } from "../../../static-types.js";
import { typePlan } from "../../../type-plans.js";
import type { RuntimeCheckSite, CoreRuntimeChecks } from "../../backend.js";
import { type Answers, closedType } from "../answers.js";
import { type ContractResult } from "../contract-descriptors.js";
import { leftOutWarning, leftOutCheck, leftOutCompletion } from "../consumers.js";
import { type ItemTag } from "../items.js";
import { type CoreAnalysisRequest, propertyName } from "../program.js";
import { pathPhrase } from "../messages.js";
import { type Obligation, type RequiredKind } from "../result.js";
import {
  DEFAULT_LOST_AT_BUDGET,
  LOST_AT_BUDGET,
  OutsideContract,
  SliceIndex,
  UNDECIDED_AT_BUDGET,
  UNESTABLISHED_AT_BUDGET,
  type Store,
  declarations,
  nodeOf,
  unwrap,
} from "./slice-index.js";
import { Contracts, isCollection, kindsPlan, membersOf, unionOf } from "./store-contracts.js";
import { keeps } from "./kept-checks.js";

/** A site of the plan's checks: a store or load, a list `get` call, or the owner of a selected fallback. */
type CheckSite = RuntimeCheckSite | BinaryExpression;

/**
 * Who owes each site's check (#2081): a published warning or a boundary, or only warnings a stop deferred, which the
 * stop's warning counts (`movedChecks`).
 */
interface Owers {
  readonly published: Set<CheckSite>;
  readonly stopped: Set<CheckSite>;
}

/** A selected fallback's checks (C10): the fallback and each depth its obligations name. */
interface Selected {
  readonly fallback: Expression;
  readonly depths: FallbackDepth[];
}

/** An obligation owed at its store, with the kinds its rule names and who owes it. */
interface Owed {
  readonly obligation: Obligation;
  readonly kinds: readonly ItemTag[] | null;
  readonly by: Set<CheckSite>;
}

/**
 * The checks the warnings owe (`runtimeChecks`), the published warnings' and then those a stop moved to the runtime:
 * C1's obligations, each placed at its store later, with the kinds its rule names, a stopped analysis's store type
 * where it decided none (D4 a′); C10's fallbacks by owner; C5c's stores and C2's calls, into `core`. Each site's owers
 * are marked as it is reached (`owers`).
 */
function warningChecks(
  answers: Answers,
  index: SliceIndex,
  core: {
    readonly requireExisting: Set<AssignmentStatement>;
    readonly indexChecks: Set<CallExpression>;
  },
  owers: Owers,
): { owed: Owed[]; fallbacks: Map<BinaryExpression | CallExpression, Selected> } {
  const owed: Owed[] = [];
  const fallbacks = new Map<BinaryExpression | CallExpression, Selected>();
  // (in this order: the published warnings', then the stop's)
  for (const [diagnostics, by] of [
    [answers.diagnostics, owers.published],
    [answers.budget.deferred, owers.stopped],
  ] as const)
    for (const diagnostic of diagnostics) {
      if (diagnostic.class !== "warning-runtime-check" || diagnostic.kind === "budget") continue;
      if (leftOutWarning(diagnostic)) continue;
      const expression = index.expressionAt(diagnostic.site);
      switch (diagnostic.kind) {
        case "written-target": {
          // C10's obligation names the fallback as every obligation names its value (§10.5: `xs.element` for
          // `xs[0]`, `d.entry` for a dict's, its text where no place holds it), with the element steps of a nested
          // literal's depth; C1's a place (S6's departure 6)
          const held = index.fallbackOf(expression);
          const steps =
            held === undefined
              ? null
              : fallbackSteps(
                  diagnostic.obligation.target,
                  answers.targetName(nodeOf(answers, index, expression)),
                );
          const owner = steps === null ? undefined : held;
          if (owner === undefined)
            owed.push({
              obligation: diagnostic.obligation,
              kinds: diagnostic.rule.rule === "store" ? diagnostic.rule.type : null,
              by,
            });
          // C10: a load's default is checked as the load's result; any other where it is selected, all its depths at
          // once
          else if (owner.kind !== "loadExpression") {
            const found = fallbacks.get(owner) ?? { fallback: expression, depths: [] };
            found.depths.push({ steps: steps!, against: diagnostic.obligation.against });
            fallbacks.set(owner, found);
            by.add(owner);
          }
          break;
        }
        case "member-read": {
          // C5c: a store whose receiver may lack the property, or not be an object, needs it there
          const store = index.storeOfReceiver(expression);
          if (store !== undefined) {
            core.requireExisting.add(store);
            by.add(store);
          }
          break;
        }
        case "integer-use": {
          // C2: a list `get` checks its index's kind; a count or an index read is the runtime's own check
          const call = index.getOfIndex(expression);
          if (call !== undefined) {
            core.indexChecks.add(call);
            by.add(call);
          }
          break;
        }
        case "operator":
          break;
      }
    }
  return { owed, fallbacks };
}

/**
 * The plan's checks only warnings a stop deferred owe (#2081): the checks the stop's warning says run while the script
 * plays instead, each check field of the plan once, a part check each. A check a published warning or a boundary also
 * owes runs whether or not the analysis stops: it is not one the stop moved.
 */
function movedChecks(
  checks: ReadonlyMap<RuntimeCheckSite, TypeCheckPlan>,
  core: CoreRuntimeChecks,
  owers: Owers,
): number {
  const moved = (site: CheckSite): boolean => owers.stopped.has(site) && !owers.published.has(site);
  let count = 0;
  for (const site of [
    ...checks.keys(),
    ...core.requireExisting,
    ...core.indexChecks,
    ...core.fallbackChecks.keys(),
  ])
    if (moved(site)) count += 1;
  for (const [store, parts] of core.partChecks) if (moved(store)) count += parts.length;
  return count;
}

/**
 * The runtime checks the core's obligations owe, through S3 §4's discharge map: C1's and C9's at the store that brings
 * the value into its place, the destination's written type or, else, its admitted type at the stored path, one check per
 * store whatever the obligations inside its value; a typed load's own type (F18), which repairs an object per field
 * (ADR 0021 rule 6.5); and the new content only the core emits (`CoreRuntimeChecks`): a property store that needs the
 * property (C5c), a list `get` that needs a whole number (C2), the check of a selected fallback or default (C10) and
 * `fromJson`'s expected type (F18). A boundary at a load or a `fromJson` that no store takes is its own type's.
 */
export function runtimeChecks(
  answers: Answers,
  index: SliceIndex,
  request: CoreAnalysisRequest,
): {
  checks: Map<RuntimeCheckSite, TypeCheckPlan>;
  core: CoreRuntimeChecks;
  contracts: ReadonlyMap<Store, ContractResult>;
  moved: number;
} {
  const textOf = (node: Expression): string => {
    const file = index.fileOf(node);
    return request.files[file]!.source.slice(node.span.start.offset, node.span.end.offset);
  };
  const contracts = new Contracts(answers, index, declarations(answers, index));
  const checks = new Map<RuntimeCheckSite, TypeCheckPlan>();
  const core = {
    requireExisting: new Set<AssignmentStatement>(),
    indexChecks: new Set<CallExpression>(),
    fallbackChecks: new Map<BinaryExpression | CallExpression, TypeCheckPlan>(),
    expected: new Map<CallExpression, TypePlan>(),
    repairs: new Set<LoadExpression>(),
    partChecks: new Map<Store, readonly PartCheckPlan[]>(),
  };
  const owers: Owers = { published: new Set(), stopped: new Set() };
  const { owed, fallbacks } = warningChecks(answers, index, core, owers);
  for (const [owner, { fallback, depths }] of fallbacks) {
    const type = fallbackPlan(
      fallback,
      depths,
      (steps) => contracts.takesNull(owner, steps),
      (steps) => contracts.direct(owner, steps),
    );
    if (type !== null)
      core.fallbackChecks.set(owner, { type, place: `the value of '${textOf(owner)}'` });
  }
  // (a boundary carries the kinds it was retained with through the discharge, never derived again)
  for (const check of answers.checks)
    if (check.boundary && !leftOutCheck(check))
      owed.push({
        obligation: check,
        kinds: check.against.filter(
          (kind): kind is Exclude<typeof kind, "non-null"> => kind !== "non-null",
        ),
        by: owers.published,
      });
  // the types a typed load and a `fromJson` read their value as (F18)
  const typed = new Set<Expression>();
  for (const load of index.loads) {
    const type = contracts.expected(load);
    if (type === null) continue;
    typed.add(load);
    checks.set(load, { type, place: `Storage key ${textOf(unwrap(load.key))}` });
    if (repairedObject(type) !== undefined) core.repairs.add(load);
  }
  for (const call of index.calls)
    if (call.callee.kind === "identifier" && call.callee.name === "fromJson") {
      const type = contracts.expected(call);
      if (type === null) continue;
      typed.add(call);
      core.expected.set(call, type);
    }
  const stopped = answers.budget.exhausted !== null;
  // each store's owed obligations, for the parts below its destination its own check does not reach (#1224)
  const atStore = new Map<Store, Obligation[]>();
  for (const { obligation, kinds, by } of owed) {
    // a boundary check against `unknown` is the runtime's validation of representable external data, which runs for
    // every plan: no plan content (S3 §4); where a stopped decision left a store's own check against `unknown` (no
    // boundary's), the receiving completion completed its contract and its own store check owes a check at this site,
    // as the unstopped analysis does (#1526 phase C step 5), the store checks that contract
    if (obligation.against.length === 1 && obligation.against[0] === "unknown") {
      const at =
        !obligation.boundary && answers.completedCheck(obligation.site) && !leftOutCompletion()
          ? index.findExpressionAt(obligation.site)
          : undefined;
      const owner = at === undefined ? undefined : index.storeOf(at);
      if (owner === undefined || !contracts.completes(owner)) continue;
    }
    const expression = index.expressionAt(obligation.site);
    const store = index.storeOf(expression);
    if (store === undefined) {
      if (obligation.boundary && typed.has(expression)) continue;
      // (a loop variable's check has no place in the plan yet: its loop stays outside the slice)
      for (let at: Expression | undefined = expression; at !== undefined; at = index.parentOf(at))
        if (index.iterates(at)) throw new OutsideContract(at, "a check of a loop variable");
      // (nor has any other check that no store takes, such as one inside a command's operand: a place for it is the
      // command operand table's, #2488's step 1½)
      throw new OutsideContract(expression, "a check that no store takes");
    }
    by.add(store);
    const held = atStore.get(store);
    if (held === undefined) atStore.set(store, [obligation]);
    else held.push(obligation);
    if (checks.has(store)) continue;
    const type = contracts.stored(store) ?? (stopped ? storedKinds(store, kinds) : null);
    if (type !== null) checks.set(store, type);
  }
  // after a demand stop, the obligations the receiving completion's own store checks owe (#1682): the natural walk's of
  // the decisions it made on the settled pass's inputs, each at its store as the unstopped one is, for that store's
  // parts only (its own check stays step 5's), merged into its owed ones in the published order (none where the
  // completion's records are left out: no completion runs, `asked`)
  const completed = new Map<Store, Obligation[]>();
  for (const warning of answers.completedWarnings()) {
    if (leftOutWarning(warning) || index.fallbackOf(index.expressionAt(warning.site)) !== undefined)
      continue;
    const store = index.storeOf(index.expressionAt(warning.obligation.site));
    if (store === undefined) continue;
    // (owed after a stop only: the completion runs where the analysis stopped)
    owers.stopped.add(store);
    const held = completed.get(store);
    if (held === undefined) completed.set(store, [warning.obligation]);
    else held.push(warning.obligation);
  }
  if (completed.size > 0) {
    // (an obligation no warning owns, a boundary, after every warning's, in its own order: the sort is stable)
    const order = answers.publishedOrder();
    const at = (obligation: Obligation): number => order.get(obligation) ?? Number.MAX_SAFE_INTEGER;
    for (const [store, more] of completed)
      atStore.set(
        store,
        [...(atStore.get(store) ?? []), ...more].sort((a, b) => at(a) - at(b)),
      );
  }
  for (const [store, obligations] of atStore) {
    // (the label of the place it stores into, as `stored` finds it: no question beyond the store's own check's)
    const destination = contracts.destination(store);
    if (destination === undefined) continue;
    const whole = checks.get(store)?.type ?? null;
    // (each object type's properties by name, made once for every part the store's check is read at: no search per part)
    const named = new Map<TypePlan, ReadonlyMap<string, TypePlan>>();
    const parts = partChecksOf(destination, obligations).filter(
      (part) => whole === null || !reaches(whole, part.path, named),
    );
    if (parts.length > 0) core.partChecks.set(store, parts);
  }
  return { checks, core, contracts: contracts.results, moved: movedChecks(checks, core, owers) };
}

/**
 * #1526 decision 2, condition 1: while a required check is missing, the candidate publishes no plan that
 * lets the invalid value through unchecked. Every plan published after a stop is gated here, at the one seam `asked`
 * publishes through, against the capture its path has (`Answers.gated`): the receiving registry where a receiving
 * completion ran (#1526 phase C), its results; after a stop where none ran or it kept none, the registry's obligations
 * without results. Each obligation a store owes when the script runs, its C1 check (a warning the walk made) or its C9
 * boundary (external data entering), is Lost where the plan's check at its store does not carry its required contract
 * (`keeps`), a stopped decision's own marks among them (#2080): a stopped mark whose completion result was lost, or
 * that has none, is kept only by a complete store check. The first Lost obligation, in the registry's source order,
 * declines the program at its store
 * (`OutsideContract`): the stopped plan would otherwise run past a check the natural plan makes (ADR 0021 §1.10
 * column (2)). A program the analysis rejects has no plan and is not asked. Where admission did not settle there is no
 * registry: each owed obligation against `unknown` is a check no completion decided, and the first, in the owed order
 * `runtimeChecks` reads, declines the program at its site (#2080, the owner's decision: no inference after the stop).
 * One visit per obligation, whose making charged each one.
 */
export function lostCheck(
  answers: Answers,
  index: SliceIndex,
  published: ReadonlyMap<Store, ContractResult>,
  checks: ReadonlyMap<RuntimeCheckSite, TypeCheckPlan>,
  core: CoreRuntimeChecks,
): void {
  const gated = answers.gated();
  // (obligations a settled stop cannot establish: the program is declined at its first store, never read as owing none)
  if (gated === null) {
    const first = index.statements.find(
      (statement): statement is Store =>
        statement.kind === "letStatement" || statement.kind === "assignmentStatement",
    );
    if (first === undefined) return;
    throw new OutsideContract(
      first.kind === "letStatement" ? first.initializer : first.value,
      UNESTABLISHED_AT_BUDGET,
    );
  }
  // (#2080: before admission settled, a store's, a literal's or an ingress's mark against `unknown`. None was found to be
  // a boundary obligation or carried by a complete store check, 11,034 at 1,606 such stops (campaign
  // lane1a/2080-part2-owed), so neither is excepted)
  if (answers.budget.exhausted !== null && !answers.budget.settled)
    for (const diagnostic of [...answers.diagnostics, ...answers.budget.deferred]) {
      if (diagnostic.class !== "warning-runtime-check" || diagnostic.kind === "budget") continue;
      if (leftOutWarning(diagnostic)) continue;
      const { obligation } = diagnostic;
      if (obligation.against.length !== 1 || obligation.against[0] !== "unknown") continue;
      const expression = index.expressionAt(obligation.site);
      const store = index.storeOf(expression);
      throw new OutsideContract(
        store === undefined
          ? expression
          : store.kind === "letStatement"
            ? store.initializer
            : store.value,
        UNDECIDED_AT_BUDGET,
      );
    }
  // (the stores the completion's own C1 owes a check at, each once: a stopped mark there is never NoCheck, `keeps`)
  const warned = new Set<Store>();
  for (const warning of answers.completedWarnings()) {
    if (leftOutWarning(warning)) continue;
    const store = index.storeOf(index.expressionAt(warning.obligation.site));
    if (store !== undefined) warned.add(store);
  }
  for (const { obligation, result } of gated) {
    if (obligation.epoch !== answers.epoch) continue;
    const store = index.storeAt(obligation.slot.site);
    if (
      store === undefined ||
      keeps(answers, index, store, obligation, result, published, checks, core, warned)
    )
      continue;
    throw new OutsideContract(
      store.kind === "letStatement" ? store.initializer : store.value,
      LOST_AT_BUDGET,
    );
  }
  settledOwed(answers, index);
}

/**
 * After a settled stop, an owed obligation against exactly `unknown` that is not a store's declines the program at its
 * site (#2183): a fallback's (C10) is the requirement the stop lost, which no
 * `fallbackCheck` can carry (`fallbackPlan`), so the default would run unchecked; any other rule's declines too, as an
 * unestablished check. No set shows one (#2183's census, sweep and natural sets: `store` and `fallback` only). A store's
 * is the registry's, which `keeps` decides. Not caught: a contract the stop left incomplete that a natural producer
 * reads, where C10 owes nothing (#2183, measured 0, not shown impossible), and a store whose C1 the stop removed, where
 * no obligation is owed (#2245).
 */
function settledOwed(answers: Answers, index: SliceIndex): void {
  const { budget } = answers;
  const stopped =
    budget.exhausted !== null || budget.decisions.some((decision) => decision.stopped);
  if (!stopped || (budget.exhausted !== null && !budget.settled)) return;
  for (const diagnostic of [...answers.diagnostics, ...budget.deferred]) {
    if (diagnostic.class !== "warning-runtime-check" || diagnostic.kind === "budget") continue;
    if (leftOutWarning(diagnostic)) continue;
    const { obligation } = diagnostic;
    if (obligation.against.length !== 1 || obligation.against[0] !== "unknown") continue;
    if (diagnostic.rule.rule === "store") continue;
    throw new OutsideContract(
      index.expressionAt(obligation.site),
      diagnostic.rule.rule === "fallback" ? DEFAULT_LOST_AT_BUDGET : UNESTABLISHED_AT_BUDGET,
    );
  }
}

/**
 * The part checks a store's owed obligations below its destination make (#1224, the lead's ruling (c)): one per obligation
 * the analysis owes at the store below its destination (`destination`, the label of the place it stores into), with
 * the obligation's kinds at the steps its target names below the destination (`pathText`'s: a property's name, quoted
 * for an internal one, `element`, `entry` or `index` for an element). None is made for an obligation at the destination
 * itself, for one whose kinds leave its part open, or for a step of another form: nothing is checked that the analysis
 * does not owe there.
 */
function partChecksOf(destination: string, obligations: readonly Obligation[]): PartCheckPlan[] {
  const out: PartCheckPlan[] = [];
  const made = new Set<string>();
  for (const obligation of obligations) {
    if (!obligation.target.startsWith(`${destination}.`)) continue;
    const type = kindsPlan(obligation.against);
    const part =
      type === null
        ? null
        : partOf(destination, obligation.target.slice(destination.length + 1).split("."), type);
    if (part === null) continue;
    const key = JSON.stringify([part.path, part.type]);
    if (made.has(key)) continue;
    made.add(key);
    out.push(part);
  }
  return out;
}

/**
 * A part check of `type` at `steps` below a destination (`pathText`'s steps: a property's name, quoted for an internal
 * one, `element`, `entry` or `index` for an element), its place the path as messages name one (`pathPhrase`); `null` for
 * a step of another form, which makes no part.
 */
function partOf(
  destination: string,
  steps: readonly string[],
  type: TypePlan,
): PartCheckPlan | null {
  const path: PartStep[] = [];
  for (const step of steps)
    if (step === "element" || step === "entry" || step === "index") path.push({ element: true });
    else if (
      step !== "iteration" &&
      (step.startsWith("'") || /^[\p{L}_][\p{L}\p{N}_]*$/u.test(step))
    )
      path.push({ property: propertyName(step) });
    else return null;
  // (the place as messages name a path below one in words: `'copy.open'`, `an element of 'copy.xs'`)
  const [root, ...above] = destination.split(".");
  return {
    path,
    type,
    place: pathPhrase({ code: root! }, [
      ...above,
      ...steps.map((step) => (step === "index" ? "element" : step)),
    ]),
  };
}

/**
 * Whether a store's check of `type` checks every value at `path` below it (`named`: each object type's properties by
 * name, shared by the store's parts): each member that can hold the next step (an
 * object, or a collection for an element) lists it and checks below it; a member that cannot hold it leaves no value
 * there. An open level (an object without the property, a collection whose elements are open) reaches nothing below.
 */
function reaches(
  type: TypePlan,
  path: readonly PartStep[],
  named: Map<TypePlan, ReadonlyMap<string, TypePlan>>,
): boolean {
  const pending: [TypePlan, number][] = [[type, 0]];
  for (let next = pending.pop(); next !== undefined; next = pending.pop()) {
    const [at, depth] = next;
    if (depth === path.length) continue;
    const step = path[depth]!;
    if (at.kind === "union") {
      for (const member of at.members) pending.push([member, depth]);
      continue;
    }
    if ("property" in step) {
      if (at.kind !== "object") continue;
      let properties = named.get(at);
      if (properties === undefined) {
        const byName = new Map<string, TypePlan>();
        for (const property of at.properties)
          if (!byName.has(property.name)) byName.set(property.name, property.type);
        named.set(at, (properties = byName));
      }
      const found = properties.get(step.property);
      if (found === undefined) return false;
      pending.push([found, depth + 1]);
    } else if (at.kind === "list" || at.kind === "set" || at.kind === "dict") {
      if (at.element === null) return false;
      pending.push([at.element, depth + 1]);
    }
  }
  return true;
}

/**
 * A store's check by the kinds its warning names, where a stopped analysis decided no type to check it against (D4 a′):
 * the type admission decided before the stop, its kinds' containers unrestricted below them.
 */
function storedKinds(store: Store, kinds: readonly ItemTag[] | null): TypeCheckPlan | null {
  const types = (kinds ?? []).map(closedType).filter((type): type is StaticType => type !== null);
  const type = types.length === 0 ? null : typePlan(union(types));
  if (type === null) return null;
  const target =
    store.kind === "letStatement"
      ? store.name.name
      : store.target.kind === "identifier"
        ? store.target.name
        : null;
  return { type, place: target === null ? "the place" : `'${target}'` };
}

/** C10's obligation at one depth of a fallback: its element steps below the fallback, and the kinds it requires there. */
interface FallbackDepth {
  readonly steps: readonly string[];
  readonly against: readonly RequiredKind[];
}

/** The element steps of a C10 target below the fallback named `name` (`targetName`), or `null` for another (a C1's). */
function fallbackSteps(target: string, name: string | null): string[] | null {
  if (name === null) return null;
  if (target === name) return [];
  if (!target.startsWith(`${name}.`)) return null;
  const steps = target.slice(name.length + 1).split(".");
  return steps.every((step) => step === "element" || step === "entry") ? steps : null;
}

/**
 * The check of a selected fallback from C10's obligations at its depths (ADR 0021 7.2, nested literals by their
 * elements): at each depth the kinds required there, `null` below the fallback itself where `takesNull` allows it, the
 * collection below it as the fallback's literal is one, else a list or a set for an element and a dict for an entry;
 * `null` where no depth requires a kind. Where C10 publishes nothing below a collection no literal holds, that collection
 * is checked whole, as the value the fallback stands in for is at that depth (`whole`), not its first level alone (Astra
 * r1's B1 on #1539); where that value gives no collection there the program leaves the slice.
 */
function fallbackPlan(
  fallback: Expression,
  depths: readonly FallbackDepth[],
  takesNull: (steps: readonly string[]) => boolean,
  whole: (steps: readonly string[]) => TypePlan | null,
): TypePlan | null {
  const deepest = depths.reduce((most, depth) => Math.max(most, depth.steps.length), 0);
  // the literal the fallback's value is at each depth, as far as a literal holds it
  const literals: (Expression | null)[] = [];
  for (
    let at: Expression | null = selectedLiteral(fallback), depth = 0;
    depth <= deepest;
    depth += 1
  ) {
    literals.push(at);
    at =
      at !== null &&
      (at.kind === "listLiteral" || at.kind === "setLiteral") &&
      at.elements.length > 0
        ? selectedLiteral(at.elements[0]!)
        : null;
  }
  let below: TypePlan | null = null;
  for (let depth = deepest; depth >= 0; depth -= 1) {
    const here = depths.filter((entry) => entry.steps.length === depth);
    const kinds = here.flatMap((entry) => entry.against);
    const step = depths.find((entry) => entry.steps.length > depth)?.steps[depth];
    const literal = literals[depth] ?? null;
    const collections: TypePlan[] =
      below === null || step === undefined
        ? []
        : step === "entry"
          ? [{ kind: "dict", element: below }]
          : literal?.kind === "listLiteral"
            ? [{ kind: "list", element: below }]
            : literal?.kind === "setLiteral"
              ? [{ kind: "set", element: below }]
              : [
                  { kind: "list", element: below },
                  { kind: "set", element: below },
                ];
    // below the fallback itself an element may be `null` too, unless a written place it lands in excludes it (C10)
    const steps = depths.find((entry) => entry.steps.length >= depth)?.steps.slice(0, depth) ?? [];
    if (literal === null && collections.length === 0 && kinds.some(isCollection)) {
      const complete = whole(steps);
      const held =
        complete === null ? [] : membersOf(complete).filter((member) => isCollection(member.kind));
      if (held.length === 0)
        throw new OutsideContract(
          fallback,
          "a default whose collection the value it stands in for does not type",
        );
      const scalars = kindsPlan(kinds.filter((kind) => !isCollection(kind)));
      below = unionOf([
        ...held,
        ...(scalars === null ? [] : [scalars]),
        ...(depth > 0 && takesNull(steps) ? [{ kind: "null" } as const] : []),
      ]);
      continue;
    }
    const others = kindsPlan([
      ...(collections.length === 0
        ? kinds
        : kinds.filter((kind) => kind !== "list" && kind !== "set" && kind !== "dict")),
      ...(depth > 0 && (kinds.length > 0 || collections.length > 0) && takesNull(steps)
        ? (["null"] as const)
        : []),
    ]);
    const parts = [...collections, ...(others === null ? [] : [others])];
    below = parts.length === 0 ? null : unionOf(parts);
  }
  return below;
}

/** The literal a value is, through parentheses and constant indexes of list literals, or `null`. */
function selectedLiteral(expression: Expression): Expression | null {
  let at = unwrap(expression);
  while (at.kind === "indexExpression") {
    const list = unwrap(at.object);
    const index = unwrap(at.index);
    const element =
      list.kind === "listLiteral" && index.kind === "numberLiteral"
        ? list.elements[index.value]
        : undefined;
    if (element === undefined) return null;
    at = unwrap(element);
  }
  return at.kind === "listLiteral" || at.kind === "setLiteral" || at.kind === "dictLiteral"
    ? at
    : null;
}
