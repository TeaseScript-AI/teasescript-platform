import type { PlaceId } from "../graph.js";
import type { CorePass } from "./answers.js";
import {
  carried,
  choiceItems,
  conversionKind,
  defaultOf,
  emptyAt,
  heldReference,
  hostAt,
  ingressNull,
  ONLY_NULL,
  OPAQUE_MEMBER,
  operatorOf,
  plusElements,
  propertyOnly,
  REFERENCE,
  typedDefault,
  unknownItem,
  WIDE,
  withOwnSelection,
  type ChoicePart,
} from "./contract.js";
import { joinParts, joinSteps, keepText } from "./budget.js";
import { isSteps, spanRef, type Rest } from "./contract/key-ids.js";
import {
  keptKey,
  keyOf,
  keyPath,
  keyPlace,
  type Definition,
  type ForLoopFacts,
  type Key,
} from "./definitions.js";
import { belowSelected, withoutEmpty, withWriter } from "./exact-path.js";
import type { FlowNode } from "./flow-graph.js";
import { marked } from "./guards.js";
import {
  builtinResult,
  clockResult,
  conversionCategory,
  declaredResult,
  declaredMethod,
  declaredProperty,
  dictList,
  interactionCategory,
  kindElement,
  memberStep,
  measuresLength,
  memberResult,
  methodCategory,
  selectsElement,
  shownResult,
} from "./method-categories.js";
import {
  alternatives,
  EMPTY,
  makeItem,
  mergeItems,
  REASON,
  STOPPED,
  weaken,
  type Item,
  type ItemTag,
  type Writer,
} from "./items.js";
import { Laminar, narrowedItems, type Narrowing } from "./narrowing.js";
import { operationItems } from "./operator-table.js";
import { stepName, type CoreProgram, type ValueConstraint } from "./program.js";
import { Position, positions, UNPOSITIONED } from "./positions.js";
import type { Proof, ProofDemand, Proven, Work } from "./solver.js";

/*
 * The value side of the coarse core (checkpoint 9, TABLE §3): a read of a key at a node takes, in this order, the host
 * or reference answer (§3 step 1), the exact path's value at D (§3.1), or the contract (§3.2), and under a guard of
 * its key its kinds are possible and marked (§3.2). A read inside a stored value takes its narrowing definition G
 * where G holds (§13 N2, S10 part 2b): so a copy, an operation or a store check sees the tested kinds, and N5's
 * preserving test, which reads a store's own value, takes them too. The value of an expression at its node follows the
 * read through projections, call results (F20), operations (F7, F10, F16–F19, F25, F26b) and literals (F12). Literals
 * and operations are demands, once per value and path.
 */

const COLLECTIONS = new Set(["list", "set", "dict", "object"]);

/** The receiver kinds a copy of their elements (F10) is not. */
const COPIED: ReadonlySet<ItemTag> = new Set(["list", "set", "range"]);

/** Which path answered a read (S3 §1's route): the exact path's definition, or the contract (§3 step 1 included). */
export type ReadRoute = "exact" | "contract";

/**
 * A read that takes its narrowing (S10 part 2b, `Values.#narrowingOf`): its G and its node, and the key, binding
 * occurrence and node the exact path reads it by.
 */
interface NarrowedRead {
  readonly g: Narrowing;
  readonly read: FlowNode;
  readonly root: PlaceId;
  readonly key: Key;
  readonly node: FlowNode | null;
}

/** Per program, per file, the spans of its stored values (`Values.#inStoredValue`), made on the first question. */
const STORED_SPANS = new WeakMap<CoreProgram, ReadonlyMap<number, Laminar<null>>>();

/**
 * G's items' demand key (`Values.narrowingValue`): its entry, its input (whose stable path, with the element steps,
 * is its location), its form and its element steps.
 */
export function narrowingKey(g: Narrowing): string {
  return joinParts("gv", g.node.id, g.input.id, g.form.kind, g.elements);
}

export class Values {
  /** The route each read took, by key, node and `before`, recorded as the read is answered. */
  readonly #routes = new Map<string, ReadRoute>();
  /** Per read, the narrowing it takes (`#narrowingOf`). */
  readonly #narrowings = new Map<PlaceId, NarrowedRead | null>();

  public constructor(readonly pass: CorePass) {}

  /** A read of `key` at `node` (§3); `before`: a definition at `node` itself does not count. */
  public *keyItems(key: Key, node: FlowNode | null, before = false): Work<readonly Item[]> {
    const read = yield* this.#keyRead(key, node, before);
    // §3.2: under a test of its variable a read's kinds are possible and marked, and no consumer errs on them
    return read.guardable && this.pass.guards.narrowed(key, node!)
      ? marked(read.items)
      : read.items;
  }

  /**
   * `keyItems` before §3.2's mark: the host or reference answer, the exact path's value at D (`def`, where D answers),
   * or the contract; `guardable` where the mark applies.
   */
  *#keyRead(
    key: Key,
    node: FlowNode | null,
    before: boolean,
  ): Work<{
    readonly items: readonly Item[];
    readonly def: Definition | null;
    readonly guardable: boolean;
  }> {
    const { program, exact, contract, lists } = this.pass;
    const route = (taken: ReadRoute): void => {
      const at = joinParts(key, node?.id ?? "-", before ? 1 : 0);
      // (a route's text charged where it is kept first, TABLE r4.58)
      if (!this.#routes.has(at)) keepText(program.work, at.length);
      this.#routes.set(at, taken);
    };
    // (a key whose decision stopped: its contract, `budget`, for every read, a narrowed one's input included:
    // `Contract.stop`)
    if (contract.keyStopped(key)) {
      route("contract");
      return { items: STOPPED, def: null, guardable: false };
    }
    if (program.isHost(keyPlace(key))) {
      route("contract");
      return { items: hostAt(keyPath(key)), def: null, guardable: false };
    }
    if (yield* contract.refReceiver(key)) {
      route("contract");
      return { items: [OPAQUE_MEMBER], def: null, guardable: false };
    }
    if (node === null) {
      route("contract");
      return { items: yield* contract.contractOf(key), def: null, guardable: false };
    }
    const answer = exact.exactPath(contract.keyText(key), node, before);
    // F5a: the loop ran only over a held iterable, and nothing between the add and the body's end may change the
    // collection: X6's events, a call into a callable that stores it included
    let loop = false;
    if ("def" in answer && answer.def.loop !== undefined) {
      const facts = answer.def.loop;
      loop =
        !(yield* this.#iterableHeld(facts)) ||
        facts.backs.some(
          (back) => lists.eventBetween(contract.keyText(key), answer.def.orig!.node, back) !== null,
        );
    }
    const items =
      "def" in answer && !loop
        ? yield* exact.defVal(answer.def, answer.rest)
        : yield* contract.contractRead(
            key,
            node,
            loop ? "loop" : "fail" in answer ? answer.fail : "loop",
            loop || ("fail" in answer && answer.later === true),
          );
    route("def" in answer && !loop ? exact.defRoute(answer.def, answer.rest) : "contract");
    return { items, def: "def" in answer && !loop ? answer.def : null, guardable: true };
  }

  /**
   * S10 part 2b: the narrowing a read takes, `null` for none. A read of a stable path at its own path (a binding's
   * occurrence, or a chain of its properties and indexes) inside a stored value (`#inStoredValue`) takes the nearest
   * narrowing definition its node finds (N2, `NarrowingIndex.nearestAt`: one walk of its steps down the tested paths);
   * any other read keeps the mark until its consumer reads G (§13.2's order, the consumers' part). A selection as the
   * read's own step (`xs.first`, `rows[0].random`) reads its element's (U4a: an element G proves its kinds, never its
   * emptiness, which C6 asks of the owner); a selection below another step, a length or a member step answers by
   * itself (N1: G proves kinds only). Once per read.
   */
  #narrowingOf(value: PlaceId): NarrowedRead | null {
    const known = this.#narrowings.get(value);
    if (known !== undefined) return known;
    const { program, guards } = this.pass;
    program.work.charge("eventSteps");
    let found: NarrowedRead | null = null;
    const outer = program.projOf.get(value);
    const read = outer === undefined ? (program.occNode.get(value) ?? null) : outer.node;
    // (the chain down to its binding, its steps as the exact path keys them, the node `#valueAt` passes down)
    const steps: string[] = [];
    let at = value;
    let node: FlowNode | null = null;
    let stable = read !== null && read.span !== null;
    for (let projection = outer; projection !== undefined && stable;) {
      program.work.charge("eventSteps");
      const step = projection.step;
      stable =
        step !== "iteration" &&
        (projection === outer || !selectsElement(step)) &&
        !measuresLength(step) &&
        memberStep([step], 0) < 0;
      steps.push(stepName(step));
      node = projection.node ?? node;
      at = projection.owner;
      projection = program.projOf.get(at);
    }
    const binding = stable ? program.occurrenceOf.get(at) : undefined;
    // (a root no test names is never narrowed: one lookup before the stored values and the tested paths)
    if (binding !== undefined && guards.narrowing.tests(binding) && this.#inStoredValue(read!)) {
      const g = guards.narrowing.nearestAt(read!);
      if (g !== null)
        found = {
          g,
          read: read!,
          root: at,
          key: keptKey(program.work, binding, steps.reverse()),
          node: program.occNode.get(at) ?? node,
        };
    }
    this.#narrowings.set(value, found);
    return found;
  }

  /**
   * Whether a read lies in a stored value: the value of a store, an add, an argument binding, a parameter default or a
   * return (their definitions' values), one laminar list of their spans per file, made once per program (the
   * definitions are the program's: a pass's rejections act through its lists, A6).
   */
  #inStoredValue(read: FlowNode): boolean {
    const { program, definitions } = this.pass;
    const work = program.work;
    let storedSpans = STORED_SPANS.get(program);
    // (the program's, shared by every later read: no demand's own work, S3 §5)
    storedSpans ??= work.shared(() => {
      const byFile = new Map<number, { start: number; end: number; item: null }[]>();
      for (const list of [definitions.storeDefs, definitions.transferDefs])
        for (const d of list) {
          work.charge("indexSteps");
          const site = d.value === undefined ? null : (program.places[d.value]?.site ?? null);
          if (site === null) continue;
          const spans = byFile.get(site.file);
          const span = { start: site.start, end: site.end, item: null };
          if (spans === undefined) byFile.set(site.file, [span]);
          else spans.push(span);
        }
      const made = new Map<number, Laminar<null>>();
      for (const [file, spans] of byFile) made.set(file, new Laminar(work, spans));
      STORED_SPANS.set(program, made);
      return made;
    });
    const spans = storedSpans.get(read.file);
    if (spans === undefined || read.span === null) return false;
    // (the innermost span holding its start, and those holding that one, until one holds its end)
    for (let index = spans.innermostIndex(read.span.start.offset); index >= 0;) {
      work.charge("eventSteps");
      if (spans.ends[index]! >= read.span.end.offset) return true;
      index = spans.parents[index]!;
    }
    return false;
  }

  /**
   * A read that takes its narrowing G (N2, S10 part 2b): where G holds, G's items, or, where the exact path's
   * definition D reaches the read, D's value (after G's entry: a preserving store there, the read's nearest candidate,
   * §13.2 (2)) or D's value filtered by G's form (before it); where G fails, the read as before, marked (§3.2's
   * fallback). A demand per read. The read, G's items and N2's query are always asked, so what it reads never depends
   * on what they answer. G's kinds never wait on the read's own component (`narrowingValue`); were they still being
   * solved, the read would ask N2 with no preserving store, the conservative answer.
   */
  *#narrowedRead(narrowed: NarrowedRead, node: FlowNode | null): Work<readonly Item[]> {
    const { program, contract, guards, solver } = this.pass;
    const { g, root, key } = narrowed;
    const at = narrowed.node ?? node;
    const read = yield* this.#keyRead(key, at, false);
    const items = yield* this.narrowingValue(g);
    const kinds =
      solver.answer(narrowingKey(g)) === undefined
        ? null
        : withoutEmpty(items).map((item) => item.tag);
    const fails = yield* guards.narrowings(this.pass).events.holds(g, narrowed.read, kinds);
    if (fails !== null)
      return contract.entered(
        root,
        read.guardable && guards.narrowed(key, at!) ? marked(read.items) : read.items,
      );
    // (the exact path's definition, where it reaches the read, is the value G tested: after G's entry itself, before it
    // filtered by G's form)
    if (read.def !== null)
      return contract.entered(
        root,
        program.dom.dominates(g.node, read.def.node)
          ? read.items
          : narrowedItems(g.form, read.items, program.scope),
      );
    return contract.entered(root, items);
  }

  /**
   * G's items (N1): its key read at its input, as part 1 reads it (the exact path's definition value at the test, else
   * the contract; unmarked, no other narrowing), filtered by its form; a definition inside a loop around the test is
   * read as the contract, since its value may read the loop's own narrowings (through a store of the loop, by copies),
   * so G's kinds never wait on the component they decide, and a read the definition still reaches filters its value
   * itself (`#narrowedRead`). A demand per G.
   */
  public *narrowingValue(g: Narrowing): Work<readonly Item[]> {
    return yield {
      key: narrowingKey(g),
      kind: "value",
      file: g.input.file,
      offset: g.input.span?.start.offset ?? -1,
      make: () => this.#narrowingMade(g),
    };
  }

  /** The demand of `narrowingValue`. */
  *#narrowingMade(g: Narrowing): Work<readonly Item[]> {
    const { program, contract, exact } = this.pass;
    // (the contract chosen before any definition's value is asked: asking it would make G wait on it)
    const loopDefinition =
      g.input.loops.length > 0 &&
      !program.isHost(keyPlace(g.key)) &&
      !(yield* contract.refReceiver(g.key)) &&
      "def" in exact.exactPath(g.key, g.input);
    const input = loopDefinition
      ? yield* contract.contractOf(g.key)
      : (yield* this.#keyRead(g.key, g.input, false)).items;
    return narrowedItems(g.form, input, program.scope);
  }

  /**
   * What a read's answer takes from its narrowing, for the value classes that share answers (S10 part 2b): nothing for
   * a read that takes none; else its G's environment (`NarrowingEvents.environment`: two reads with one answer it
   * alike).
   */
  public narrowingMark(value: PlaceId): string {
    const narrowed = this.#narrowingOf(value);
    if (narrowed === null) return "";
    return `n${this.pass.guards.narrowings(this.pass).events.environment(narrowed.g, narrowed.read)}`;
  }

  /**
   * The route the value of a place at a node took at a path, read from the routes recorded as it was answered (its
   * items are asked first): a read's own, through projections, a call's result read, a literal's (F12); a length's,
   * its owner's own field's where the owner is an object (F14; a computed length is `exact`); an operation's value is
   * computed, `exact`.
   */
  public valueRoute(value: PlaceId, node: FlowNode | null, rest: readonly string[]): ReadRoute {
    const { program, contract } = this.pass;
    const recorded = (key: Key, at: FlowNode | null): ReadRoute =>
      this.#routes.get(joinParts(key, at?.id ?? "-", 0)) ?? "exact";
    let path = rest;
    let at = node;
    for (let projection = program.projOf.get(value); projection !== undefined;) {
      if (projection.step === "iteration") return "exact";
      path = joinSteps(
        [measuresLength(projection.step) ? projection.step : stepName(projection.step)],
        path,
      );
      at = projection.node ?? at;
      value = projection.owner;
      projection = program.projOf.get(value);
    }
    if (program.speakerPlaces.has(value) || program.isHost(value)) return "contract";
    const binding = program.occurrenceOf.get(value);
    if (binding !== undefined)
      return recorded(keyOf(binding, path), program.occNode.get(value) ?? at);
    const call = program.callOutOf.has(value) ? program.opOf.get(value) : undefined;
    if (call?.kind === "call")
      return recorded(
        keyOf(program.functionOf(call.fn).result, path),
        program.callOutOf.get(value) ?? at,
      );
    if (program.opOf.has(value)) return "exact";
    if (program.hasOf.has(value) || program.cellOwner.has(value))
      return contract.literalRoute(value, path, at);
    return recorded(keyOf(value, path), at);
  }

  /** F5a: the loop's iterable holds an element at the loop's entry, by the contract or by the exact value (C6's test). */
  *#iterableHeld(facts: ForLoopFacts): Work<boolean> {
    const { contract } = this.pass;
    const elements = yield* contract.contractOfValueAt(facts.value, ["element"]);
    if (
      elements.length > 0 &&
      !elements.some((item) => item.tag === "empty") &&
      !(yield* contract.contractOfValue(facts.value)).some((item) => item.tag === "unknown")
    )
      return true;
    const read = yield* this.valueItems(facts.value, facts.node, ["element"]);
    return (
      withoutEmpty(read).length > 0 &&
      !read.some((item) => item.tag === "empty") &&
      !(yield* this.valueItems(facts.value, facts.node, [])).some((item) => item.tag === "unknown")
    );
  }

  /**
   * S6c: what a computed value's exact answer rests on beside its operands, as a part of its class
   * (`Contract.classOf`): a `get`'s whether its default runs, and alone (`getProof`), an `otherwise`'s whether its
   * fallback runs only where the left is null; each at the operation's own node, so where it has none, or for any other
   * value, `null`.
   */
  public proofOf(value: PlaceId): string | null {
    const { program } = this.pass;
    const c = program.opOf.get(value);
    const at = c === undefined ? null : program.exprAt(c.site);
    if (at === null || c === undefined) return null;
    if (c.kind === "get") {
      const { reached, only } = getProof(program, c, at);
      return `${reached ? "r" : ""}${only ? "o" : ""}`;
    }
    if (c.kind !== "fallback") return null;
    const rightAt = program.exprAt(program.places[c.right]?.site ?? c.site);
    return rightAt === null
      ? "-"
      : at.predecessors.length === 1 && at.predecessors[0] === rightAt
        ? "d"
        : "";
  }

  /** The value of a place at a node, read at the path `rest` below it. */
  public valueItems(value: PlaceId, node: FlowNode | null, asked: Rest): Work<readonly Item[]> {
    // (G3 stage 1: a cursor's span read by its path's id)
    if (!isSteps(asked) && asked.kind === "span") return this.valueItemsAt(value, node, asked.id());
    const rest = isSteps(asked) ? asked : asked.steps();
    // G3 3a: a read at a path of property steps stands one step below its parent's position
    if (rest.length > 0 && positions() && rest.every(propertyOnly) && this.#rooted(value, rest[0]!))
      return this.#positioned(value, node, rest);
    return this.#through(value, node, rest, 0);
  }

  /**
   * Whether a value's read at a path of property steps stands at a position (`#position`): a read, a literal, or a chain
   * of property reads of a read, whose first step passes a wrapper (`Contract.wrapperHop`, `Contract.literalHop`); a
   * read through no wrapper is its own read, as before.
   */
  #rooted(value: PlaceId, first: string): boolean {
    const { program, contract } = this.pass;
    if (program.occurrenceOf.has(value)) return contract.wrapperHop(value, first) !== null;
    if (program.hasOf.has(value)) return contract.literalHop(value, first) !== null;
    const chain = contract.chainOf(value);
    return chain !== null && contract.wrapperHop(chain.root, chain.first) !== null;
  }

  /**
   * G3 3a: a value's read at a path with its position (`#position`'s proof), `null` where it stands at none (a read
   * through no wrapper, outside positions): A2's scan past wrappers asks it (`admission/inherited.ts`).
   */
  public *valuePosition(
    value: PlaceId,
    node: FlowNode | null,
    rest: readonly string[],
  ): Work<{ readonly items: readonly Item[]; readonly proof: Position | null }> {
    if (
      rest.length > 0 &&
      positions() &&
      rest.every(propertyOnly) &&
      this.#rooted(value, rest[0]!)
    ) {
      const { items, proof } = yield* this.pass.solver.proven(
        this.#position(value, node, this.pass.contract.pathIdOf(rest)),
      );
      return { items, proof: proof instanceof Position ? proof : null };
    }
    return { items: yield* this.#through(value, node, rest, 0), proof: null };
  }

  /** `valuePosition` at the path of a path id (G3 stage 1: a decided cursor's), from the arena's metadata. */
  public *valuePositionAt(
    value: PlaceId,
    node: FlowNode | null,
    path: number,
  ): Work<{ readonly items: readonly Item[]; readonly proof: Position | null }> {
    const { contract } = this.pass;
    if (
      path > 0 &&
      positions() &&
      contract.pathProperties[path]! &&
      this.#rooted(value, contract.pathFirstSteps[path]!)
    ) {
      const { items, proof } = yield* this.pass.solver.proven(this.#position(value, node, path));
      return { items, proof: proof instanceof Position ? proof : null };
    }
    return {
      items: yield* this.#through(value, node, spanRef(contract, path).steps(), 0),
      proof: null,
    };
  }

  *#positioned(
    value: PlaceId,
    node: FlowNode | null,
    rest: readonly string[],
  ): Work<readonly Item[]> {
    return yield this.#position(value, node, this.pass.contract.pathIdOf(rest));
  }

  /**
   * `valueItems` at the path of a path id (G3 stage 1: a decided cursor's path, or a span of it): positioned where its
   * steps are property steps and its first passes a wrapper, from the arena's metadata; else its steps made (uncharged,
   * as a caller's array was) for the read's own computation.
   */
  public valueItemsAt(value: PlaceId, node: FlowNode | null, path: number): Work<readonly Item[]> {
    const { contract } = this.pass;
    if (
      path > 0 &&
      positions() &&
      contract.pathProperties[path]! &&
      this.#rooted(value, contract.pathFirstSteps[path]!)
    )
      return this.#positionedAt(value, node, path);
    // (no position: its steps made through the charged boundary)
    return this.#through(value, node, spanRef(contract, path).steps(), 0);
  }

  *#positionedAt(value: PlaceId, node: FlowNode | null, path: number): Work<readonly Item[]> {
    return yield this.#position(value, node, path);
  }

  /**
   * G3 3a: a value at a node and a path of property steps as a demand that proves its position (`positions.ts`): its
   * parent's (one step up, at its root its own) advanced one step (`#advance`).
   */
  #position(value: PlaceId, node: FlowNode | null, path: number): ProofDemand<Proof> {
    const { contract, program } = this.pass;
    const site = program.places[value]?.site ?? null;
    const key = joinParts("vq", value, node?.id ?? "-", path);
    return {
      key,
      kind: "value",
      file: site?.file ?? -1,
      offset: site?.start ?? -1,
      proves: true,
      make: () => {
        contract.remember(key);
        return this.#advance(value, node, path);
      },
    };
  }

  /**
   * G3 3a: a value's read one step below its parent's position. Where every receiver of the read's key on the way holds
   * no reference (`Contract.refReceiver`'s walk, step by step), a read past a wrapper or a literal's lone read is its
   * frontier's read at its path below, as one literal's alternatives with the outermost wrapper's writer (the wrapper's
   * lemma: `Contract.wrapperHop`); its frontier passes the next wrapper where it stands at one, a wrapper's read where
   * the exact path answers its key at the step from its declaration. A read through no wrapper, and wherever a receiver
   * fails, is the read's own computation from its root, which every read answers outside positions.
   */
  *#advance(value: PlaceId, node: FlowNode | null, path: number): Work<Proven<Proof>> {
    const { contract, program } = this.pass;
    const step = contract.pathLast(path);
    // (the read's own computation takes its path's steps, made where it runs: a position carries its path's id alone)
    const own = (): Work<readonly Item[]> =>
      this.#through(value, node, contract.pathSteps(path), 0);
    const from = yield* this.#positionOf(value, node, contract.pathParent(path));
    const hop =
      from !== null && from.rest === 0 ? yield* this.#hop(from.read, from.node, step) : null;
    if (from === null || (!from.hopped && hop === null))
      return { items: yield* own(), proof: UNPOSITIONED };
    const noRef =
      from.noRef &&
      (from.outer === null || !heldReference(yield* contract.receiverKinds(from.outer)));
    if (!noRef) return { items: yield* own(), proof: UNPOSITIONED };
    const items = from.hopped
      ? mergeItems(
          withWriter(
            alternatives(
              yield* this.#through(
                from.read,
                from.node,
                joinSteps(contract.pathSteps(from.rest), [step]),
                0,
              ),
              program.scope,
            ),
            from.writer,
          ),
          program.scope,
        )
      : yield* own();
    // (the receiver's key one step down in its identity: a wrapper's family's its cursor's child)
    const outer = from.outer === null ? null : contract.keptKeyBelowIn(from.outer, [step]);
    return {
      items,
      proof:
        hop === null
          ? new Position(
              from.read,
              contract.pathStep(from.rest, step),
              from.node,
              true,
              from.writer,
              true,
              false,
              outer,
            )
          : new Position(
              hop.read,
              0,
              hop.node,
              true,
              from.writer ?? hop.writer,
              true,
              false,
              outer ?? keptKey(program.work, program.occurrenceOf.get(hop.read)!, []),
            ),
    };
  }

  /**
   * A value's position at a path (`#advance`): a read's or a literal's own at no path, a property read's its owner's one
   * step down; else its demand's proof; `null` for any other value, and outside positions.
   */
  *#positionOf(value: PlaceId, node: FlowNode | null, path: number): Work<Position | null> {
    const { program, solver, contract } = this.pass;
    if (!positions()) return null;
    if (path === 0) {
      const binding = program.occurrenceOf.get(value);
      if (binding !== undefined)
        return new Position(
          value,
          0,
          node,
          false,
          null,
          true,
          false,
          keptKey(program.work, binding, []),
        );
      if (program.hasOf.has(value)) return new Position(value, 0, node, false, null, true, false);
      const projection = program.projOf.get(value);
      if (
        projection === undefined ||
        selectsElement(projection.step) ||
        !propertyOnly(stepName(projection.step))
      )
        return null;
      const step = stepName(projection.step);
      return yield* this.#positionOf(
        projection.owner,
        projection.node ?? node,
        contract.pathStep(0, step),
      );
    }
    const { proof } = yield* solver.proven(this.#position(value, node, path));
    return proof instanceof Position ? proof : null;
  }

  /**
   * The wrapper a value position's frontier passes at `step` (`#advance`): a literal's lone read there
   * (`Contract.literalHop`), read at the literal's node; or a read of a wrapper (`Contract.wrapperHop`) whose key at the
   * step the exact path answers from the wrapper's declaration, read at the node its literal reads it at.
   */
  *#hop(
    read: PlaceId,
    node: FlowNode | null,
    step: string,
  ): Work<{
    readonly read: PlaceId;
    readonly node: FlowNode | null;
    readonly writer: Writer | null;
  } | null> {
    const { program, contract, exact } = this.pass;
    if (program.hasOf.has(read)) {
      const lone = contract.literalHop(read, step);
      return lone === null ? null : { read: lone.read, node: lone.node ?? node, writer: null };
    }
    const binding = program.occurrenceOf.get(read);
    const hop = binding === undefined ? null : contract.wrapperHop(read, step);
    const at = program.occNode.get(read) ?? node;
    if (hop === null || at === null) return null;
    const answer = exact.exactPath(keyOf(binding!, [step]), at);
    if (!("def" in answer) || answer.def !== hop.decl || answer.rest.length !== 1) return null;
    return { read: hop.read, node: hop.node, writer: hop.writer };
  }

  /**
   * A value read along a path through a member a built-in value answers by itself, from the step `from` on, where the
   * path ends: at a literal or an operation (a projection passes its step to its owner, and a variable or a call its key
   * to the key's reads, which the contract answers the same way). A dict's `values` is a new list of its values and its
   * `keys` one of text (TABLE r4.46 (2)), as certain as the dict, either may hold none (no count proof, no `null`); a
   * temporal field or a calendar duration's part gives its declared result (V30 §35); an object's own property of the
   * name is read as any property (F11), and a receiver that may be a reference has the runtime's members (F19a).
   */
  #through(
    value: PlaceId,
    node: FlowNode | null,
    rest: readonly string[],
    from: number,
  ): Work<readonly Item[]> {
    const { program } = this.pass;
    // (a read, a projection or a call passes the path on whole: its member steps are scanned where it ends, S6c)
    if (
      program.occurrenceOf.has(value) ||
      program.projOf.has(value) ||
      program.speakerPlaces.has(value) ||
      (program.callOutOf.has(value) && program.opOf.get(value)?.kind === "call")
    )
      return this.#valueAt(value, node, rest);
    const at = memberStep(rest, from);
    if (at < 0) return this.#valueAt(value, node, rest);
    return this.#members(value, node, rest, at, from);
  }

  /** `#through` at the step `at`, the first of `rest` from `from` on that a built-in value answers by itself. */
  *#members(
    value: PlaceId,
    node: FlowNode | null,
    rest: readonly string[],
    at: number,
    from: number,
  ): Work<readonly Item[]> {
    const { program } = this.pass;
    const before = rest.slice(0, at);
    const after = rest.slice(at + 1);
    // F19a, r4.44: a receiver that may be a reference, by its completed contract, has the runtime's members
    const contract = this.pass.contract;
    const decided =
      before.length === 0
        ? yield* contract.valueReceiver(value)
        : yield* contract.contractOfValueAt(value, before);
    if (heldReference(decided) || decided.some((item) => REFERENCE.has(item.tag)))
      return yield* this.#through(value, node, rest, at + 1);
    const receiver = withoutEmpty(yield* this.#through(value, node, before, from));
    const out: Item[] = [];
    let own = false;
    const step = rest[at]!;
    for (const item of receiver) {
      const of = (tag: ItemTag): Item =>
        carried({ ...makeItem(tag, item.writer, { context: item.context }), cert: item.cert }, [
          item,
        ]);
      const declared = declaredProperty(item.tag, step);
      if (item.tag === "dict" && dictList(step) !== undefined) {
        if (after.length === 0) out.push(of("list"));
        else if (after[0] === "element") {
          // a key is text from the list's contract, possible: no literal holds a derived list's element (r4.47, P3)
          const below =
            dictList(step) === "keys"
              ? after.length === 1
                ? weaken([of("string")])
                : []
              : yield* this.#through(value, node, joinSteps(before, after), at);
          // the list's own selection takes its own emptiness (open); a deeper selection's marker is that selection's
          const elements = after.length === 1 ? withoutEmpty(below) : below;
          out.push(...(item.cert === "def" ? elements : weaken(elements)));
          if (after.length === 1) out.push(EMPTY);
        }
      } else if (declared !== undefined) {
        // a temporal field or a calendar duration's part: its declared result, as certain as its receiver
        if (after.length === 0) out.push(of(declared));
      } else if (item.tag === "object") own = true;
      else if (item.tag === "unknown") out.push(item);
    }
    if (own) out.push(...(yield* this.#through(value, node, rest, at + 1)));
    return mergeItems(out, program.scope);
  }

  /** A written element of a list or set at a path, read as the list's literal reads it, below its element step (F12). */
  *#belowElement(
    literal: PlaceId,
    node: FlowNode | null,
    rest: readonly string[],
  ): Work<readonly Item[]> {
    const { program, contract } = this.pass;
    if (!program.hasOf.has(literal)) return yield* this.valueItems(literal, node, rest);
    return alternatives(yield* contract.indexItems(literal, rest, node, true, true), program.scope);
  }

  /** The value of a place at a node at a path, by the place's kind. */
  *#valueAt(value: PlaceId, node: FlowNode | null, rest: readonly string[]): Work<readonly Item[]> {
    if (!this.pass.solver.enterRead()) return STOPPED;
    try {
      const { program, contract } = this.pass;
      if (program.speakerPlaces.has(value))
        return [makeItem("unknown", null, { reasons: REASON.opaque, context: "unmodelled" })];
      // S10 part 2b: a read in a stored value takes its narrowing; a selection its element's, beside its owner's own
      // selection (U4a, F11)
      const narrowed = rest.length === 0 ? this.#narrowingOf(value) : null;
      if (narrowed !== null) {
        const site = program.places[value]?.site ?? null;
        const selected = program.projOf.get(value);
        return yield {
          key: joinParts("vg", value, narrowed.node === null ? (node?.id ?? "-") : ""),
          kind: "value",
          file: site?.file ?? -1,
          offset: site?.start ?? -1,
          make: () =>
            selected !== undefined && selectsElement(selected.step)
              ? this.#selection(selected.owner, selected.step, selected.node ?? node, [], narrowed)
              : this.#narrowedRead(narrowed, node),
        };
      }
      const binding = program.occurrenceOf.get(value);
      if (binding !== undefined)
        return contract.entered(
          value,
          yield* this.keyItems(keyOf(binding, rest), program.occNode.get(value) ?? node),
        );
      const projection = program.projOf.get(value);
      if (projection !== undefined) {
        const at = projection.node ?? node;
        if (projection.step === "iteration")
          return yield* this.#iteration(projection.owner, at, rest);
        if (measuresLength(projection.step))
          return yield* this.#length(projection.owner, at, projection.step, rest);
        if (!selectsElement(projection.step))
          return yield* this.valueItems(
            projection.owner,
            at,
            joinSteps([stepName(projection.step)], rest),
          );
        // S6c: a selection reads its owner twice, at its step and whole, so its whole value once per value and node,
        // whatever asks: a chain of k `.first` reads each link once whole, never each link 2^k times
        if (rest.length > 0)
          return yield* this.#selection(projection.owner, projection.step, at, rest);
        const site = program.places[value]?.site ?? null;
        return yield {
          key: joinParts("vpj", value, projection.node === null ? (node?.id ?? "-") : ""),
          kind: "value",
          file: site?.file ?? -1,
          offset: site?.start ?? -1,
          make: () => this.#selection(projection.owner, projection.step, at, []),
        };
      }
      if (program.callOutOf.has(value)) {
        const call = program.opOf.get(value);
        if (call?.kind === "call")
          return yield* this.keyItems(
            keyOf(program.functionOf(call.fn).result, rest),
            program.callOutOf.get(value) ?? node,
          );
      }
      const operation = program.opOf.get(value);
      if (operation !== undefined)
        return contract.entered(value, yield* this.#operationItems(operation, node, rest));
      if (program.hasOf.has(value) || program.cellOwner.has(value))
        return yield* this.#literalItems(value, rest, node);
      if (program.isHost(value)) return hostAt(rest);
      return yield* this.keyItems(keyOf(value, rest), node);
    } finally {
      this.pass.solver.leaveRead();
    }
  }

  /**
   * An element selection's value at a path (`#valueAt`): its owner's at the step, or its narrowing's read where it
   * takes one (`#narrowingOf`), with the owner's own selection.
   */
  *#selection(
    owner: PlaceId,
    step: string,
    node: FlowNode | null,
    rest: readonly string[],
    narrowed: NarrowedRead | null = null,
  ): Work<readonly Item[]> {
    const elements =
      narrowed === null
        ? yield* this.valueItems(owner, node, joinSteps([stepName(step)], rest))
        : yield* this.#narrowedRead(narrowed, node);
    const owners = withoutEmpty(yield* this.valueItems(owner, node, []));
    return withOwnSelection(elements, owners, this.pass);
  }

  /** F27: the loop variable is the element of the iterable's value at loop entry; a dict's key is text, a range's a whole number. */
  *#iteration(
    owner: PlaceId,
    node: FlowNode | null,
    rest: readonly string[],
  ): Work<readonly Item[]> {
    const out: Item[] = [];
    for (const item of withoutEmpty(yield* this.valueItems(owner, node, []))) {
      if (item.tag === "list" || item.tag === "set") {
        const elements = belowSelected(
          yield* this.valueItems(owner, node, joinSteps(["element"], rest)),
          rest,
        );
        out.push(...(item.cert === "def" ? elements : weaken(elements)));
      } else if ((item.tag === "dict" || kindElement(item.tag) !== undefined) && rest.length === 0)
        out.push(
          carried(
            {
              ...makeItem(item.tag === "dict" ? "string" : kindElement(item.tag)!, item.writer, {
                context: item.context,
              }),
              cert: item.cert,
            },
            [item],
          ),
        );
      // (an unknown's element: a collection below it may hold none)
      else if (item.tag === "unknown") out.push(item, ...emptyAt(rest));
    }
    return mergeItems(out, this.pass.program.scope);
  }

  /**
   * F14: a text's or a collection's length is a whole number, as certain as the receiver; an object's own `length` is
   * its property (F11); a kind without it gives nothing (C5b reports it).
   */
  *#length(
    owner: PlaceId,
    node: FlowNode | null,
    step: string,
    rest: readonly string[],
  ): Work<readonly Item[]> {
    // F19a before F14 and the exact value: a receiver that may be a reference has the runtime's members, its `length`
    // among them, read as a member so its route is the member's
    if (heldReference(yield* this.pass.contract.valueReceiver(owner)))
      return yield* this.valueItems(owner, node, joinSteps([step], rest));
    const out: Item[] = [];
    for (const item of withoutEmpty(yield* this.valueItems(owner, node, []))) {
      if (
        item.tag === "string" ||
        item.tag === "list" ||
        item.tag === "set" ||
        item.tag === "dict"
      ) {
        if (rest.length === 0)
          out.push(
            carried(
              { ...makeItem("integer", item.writer, { context: item.context }), cert: item.cert },
              [item],
            ),
          );
      } else if (item.tag === "object" || REFERENCE.has(item.tag)) {
        // an object's own `length` (F11), a reference's member (F19a)
        const own = yield* this.valueItems(owner, node, joinSteps([step], rest));
        out.push(...(item.cert === "def" ? own : weaken(own)));
      } else if (item.tag === "unknown") out.push(item);
    }
    return mergeItems(out, this.pass.program.scope);
  }

  /** A literal's value at a path (F12): a demand per literal, path and node. */
  *#literalItems(
    literal: PlaceId,
    rest: readonly string[],
    node: FlowNode | null,
  ): Work<readonly Item[]> {
    const site = this.pass.program.places[literal]?.site ?? null;
    return yield {
      key: joinParts("lit", literal, rest, node?.id ?? "-"),
      kind: "value",
      file: site?.file ?? -1,
      offset: site?.start ?? -1,
      make: () => this.literalValue(literal, rest, node),
    };
  }

  /** The demand of `#literalItems`. */
  public *literalValue(
    literal: PlaceId,
    rest: readonly string[],
    node: FlowNode | null,
  ): Work<readonly Item[]> {
    const { program, definitions, contract } = this.pass;
    // the element cell of an empty literal holds no element
    if (!program.hasOf.has(literal) && (definitions.cellDefs.get(literal) ?? []).length === 0)
      return rest.length === 0 && program.cellOwner.get(literal)?.kind === "cell" ? [EMPTY] : [];
    return alternatives(yield* contract.indexItems(literal, rest, node, true), program.scope);
  }

  /**
   * An operation's value at a path: a demand per result and path, and one for every path below a computed-key load's
   * root, where F19 gives host data whatever the path (`operationValue`; #1203: `loadsBelow`).
   */
  *#operationItems(
    c: ValueConstraint,
    node: FlowNode | null,
    rest: readonly string[],
  ): Work<readonly Item[]> {
    const site = this.pass.program.places[c.result]?.site ?? c.site;
    const below = rest.length > 0 && c.kind === "load" && c.key === null;
    const items = yield {
      key: below ? joinParts("op-below", c.result) : joinParts("op", c.result, rest),
      kind: "value",
      file: site.file,
      offset: site.start,
      make: () => this.operationValue(c, node, rest),
    };
    // (the one answer below the root is the path's but for the mark of an element step there, `hostAt`)
    return below ? [...items, ...emptyAt(rest)] : items;
  }

  /** The demand of `#operationItems`. */
  public *operationValue(
    c: ValueConstraint,
    node: FlowNode | null,
    rest: readonly string[],
  ): Work<readonly Item[]> {
    const { program, contract } = this.pass;
    const scope = program.scope;
    const at = program.exprAt(c.site) ?? node;
    const external = (): Item[] => [unknownItem(REASON.external)];
    let out: Item[] = [];
    if (c.kind === "fallback") {
      const left = yield* this.valueItems(c.left, at, rest);
      // (a left operand that is only null gives nothing, at its path or below it: the fallback is the value)
      const value = rest.length === 0 ? left : yield* this.valueItems(c.left, at, []);
      const kept = value.some((item) => item.tag !== "null")
        ? left.filter((item) => rest.length > 0 || item.tag !== "null")
        : [];
      // F17a: K = (K(a) \ {null}) ∪ K(b), the fallback's kinds kept even where the graph never evaluates it; the
      // fallback runs where a is null, so its own known items without a word take that null's (§3.4)
      const rightSite = program.places[c.right]?.site ?? c.site;
      const rightAt = program.exprAt(rightSite);
      const rightDefinite =
        rightAt !== null &&
        at !== null &&
        at.predecessors.length === 1 &&
        at.predecessors[0] === rightAt;
      const why =
        rest.length === 0 ? (left.find((item) => item.tag === "null")?.context ?? null) : null;
      out = [
        ...kept,
        ...(yield* this.valueItems(c.right, rightAt ?? at, rest)).map((item) => {
          const possible =
            rightDefinite || kept.length === 0 ? item : { ...item, cert: "pos" as const };
          return why !== null && possible.context === null && possible.tag !== "unknown"
            ? { ...possible, context: why }
            : possible;
        }),
      ];
    } else if (c.kind === "get" && heldReference(yield* contract.valueReceiver(c.receiver))) {
      // F19a before F17b: a receiver that may be a reference has the runtime's `get`, no default merged beside it
      out = [OPAQUE_MEMBER];
    } else if (c.kind === "get") {
      const receiver = belowSelected(
        yield* this.valueItems(c.receiver, at, joinSteps(["element"], rest)),
        rest,
      );
      const { fallbackAt, reached, only } = getProof(program, c, at);
      out = [
        ...(reached && only ? [] : reached ? weaken(receiver, "member") : receiver),
        ...(reached
          ? (yield* this.valueItems(c.fallback, fallbackAt, rest)).map((item) =>
              only ? item : { ...item, cert: "pos" as const },
            )
          : []),
      ];
    } else if (c.kind === "load" && c.key === null) {
      // F19: a computed key is host data
      // (below the root one answer for every path, `#operationItems`, which marks an element step)
      if (rest.length > 0) out = external();
      else {
        const nullDefault =
          c.fallback !== null && (yield* this.onlyNull(c.fallback, at)).length > 0;
        out = [...external(), ...(nullDefault ? [ingressNull()] : [])];
      }
    } else if (c.kind === "load") {
      // F18: the expected type (the load checks the value)
      const expected = yield* contract.expectedOf(c, rest);
      if (expected !== null) out = [...expected];
      else if (c.fallback !== null)
        out = [...(yield* this.defaultKinds(c.fallback, at, rest)), ...emptyAt(rest)];
      else out = external();
    } else if (c.kind === "operation") out = yield* this.#operation(c, at, rest);
    else out = external();
    return alternatives(out, scope);
  }

  /**
   * F18 (r4.5): the kinds a `load` or `fromJson` takes from its default's value at `at` (`typedDefault`): definite,
   * the runtime checks the value against the default's type.
   */
  /**
   * A wide choice's options [lo, hi) (V30 §19, S10 part 2b), read at `rest` and merged by kind, as its operation's merge
   * takes them anyway: a balanced tree of demands, so where the options' answers change one by one (a component of N5's
   * stores reading them), a change re-runs only the nodes above it (`Contract.gathered` for a literal's).
   */
  public *choiceRange(
    c: Extract<ValueConstraint, { readonly kind: "operation" }>,
    at: FlowNode | null,
    rest: readonly string[],
    lo: number,
    hi: number,
  ): Work<readonly Item[]> {
    return yield {
      key: joinParts("cr", c.result, lo, hi, at?.id ?? "-", rest),
      kind: "value",
      file: c.site.file,
      offset: c.site.start,
      make: () => this.#choiceRangeMade(c, at, rest, lo, hi),
    };
  }

  /** The demand of `choiceRange`. */
  *#choiceRangeMade(
    c: Extract<ValueConstraint, { readonly kind: "operation" }>,
    at: FlowNode | null,
    rest: readonly string[],
    lo: number,
    hi: number,
  ): Work<readonly Item[]> {
    const { contract, program } = this.pass;
    program.work.charge("invSteps");
    if (hi - lo <= WIDE) {
      const options = contract.choiceOptions(c, true);
      return mergeItems(
        yield* choiceItems(c, rest, this.#choiceRead(at), contract.choiceKeysStored(), options, {
          ...this.#choiceWide(c, at),
          lo,
          hi,
        }),
        program.scope,
      );
    }
    const middle = (lo + hi) >> 1;
    return mergeItems(
      [
        ...(yield* this.choiceRange(c, at, rest, lo, middle)),
        ...(yield* this.choiceRange(c, at, rest, middle, hi)),
      ],
      program.scope,
    );
  }

  /** A choice's part whose wide written lists read their elements as trees of demands (`choiceElements`). */
  #choiceWide(
    c: Extract<ValueConstraint, { readonly kind: "operation" }>,
    at: FlowNode | null,
  ): ChoicePart {
    return { wide: (index, count, rest) => this.choiceElements(c, at, rest, index, 0, count) };
  }

  /**
   * A choice's written list or set option's elements [lo, hi) (V30 §19, S10 part 2b), as `choiceRange` reads its
   * options: a balanced tree of demands, each node its range's items merged by kind.
   */
  public *choiceElements(
    c: Extract<ValueConstraint, { readonly kind: "operation" }>,
    at: FlowNode | null,
    rest: readonly string[],
    index: number,
    lo: number,
    hi: number,
  ): Work<readonly Item[]> {
    return yield {
      key: joinParts("ce", c.result, index, lo, hi, at?.id ?? "-", rest),
      kind: "value",
      file: c.site.file,
      offset: c.site.start,
      make: () => this.#choiceElementsMade(c, at, rest, index, lo, hi),
    };
  }

  /** The demand of `choiceElements`. */
  *#choiceElementsMade(
    c: Extract<ValueConstraint, { readonly kind: "operation" }>,
    at: FlowNode | null,
    rest: readonly string[],
    index: number,
    lo: number,
    hi: number,
  ): Work<readonly Item[]> {
    const { contract, program } = this.pass;
    program.work.charge("invSteps");
    if (hi - lo <= WIDE)
      return mergeItems(
        yield* choiceItems(
          c,
          rest,
          this.#choiceRead(at),
          contract.choiceKeysStored(),
          contract.choiceOptions(c, true),
          { elements: { index, lo, hi } },
        ),
        program.scope,
      );
    const middle = (lo + hi) >> 1;
    return mergeItems(
      [
        ...(yield* this.choiceElements(c, at, rest, index, lo, middle)),
        ...(yield* this.choiceElements(c, at, rest, index, middle, hi)),
      ],
      program.scope,
    );
  }

  /** How a choice's options are read at its node `at` (`choiceItems`). */
  #choiceRead(
    at: FlowNode | null,
  ): (value: PlaceId, path: readonly string[], element?: true) => Work<readonly Item[]> {
    return (value, path, element) =>
      element === true ? this.#belowElement(value, at, path) : this.valueItems(value, at, path);
  }

  public *defaultKinds(
    fallback: PlaceId,
    at: FlowNode | null,
    rest: readonly string[],
  ): Work<readonly Item[]> {
    const site = this.pass.program.places[fallback]?.site ?? null;
    return yield {
      key: joinParts("vdk", fallback, rest, at?.id ?? "-"),
      kind: "value",
      file: site?.file ?? -1,
      offset: site?.start ?? -1,
      make: () => this.valueItems(fallback, at, rest),
      decision: typedDefault(rest, true),
    };
  }

  /** F19 (r4.1): whether a default's value at `at` holds only `null` (or nothing) (`ONLY_NULL`). */
  public *onlyNull(fallback: PlaceId, at: FlowNode | null): Work<readonly Item[]> {
    const site = this.pass.program.places[fallback]?.site ?? null;
    return yield {
      key: joinParts("vdn", fallback, at?.id ?? "-"),
      kind: "value",
      file: site?.file ?? -1,
      offset: site?.start ?? -1,
      make: () => this.valueItems(fallback, at, []),
      decision: ONLY_NULL,
    };
  }

  *#operation(
    c: Extract<ValueConstraint, { readonly kind: "operation" }>,
    at: FlowNode | null,
    rest: readonly string[],
  ): Work<Item[]> {
    const { program, contract } = this.pass;
    const { family, name } = c.contract;
    const out: Item[] = [];
    // F19a: a reference's method is opaque, by the receiver's contract before its exact value (r4.44)
    if (
      family === "method" &&
      c.receiver !== null &&
      heldReference(yield* contract.valueReceiver(c.receiver))
    )
      return [OPAQUE_MEMBER];
    // F26b (r5): `"${v}"` is always text
    if (family === "interpolation") return rest.length === 0 ? [makeItem("string")] : [];
    // a message's handle (F19a)
    if (family === "say") return rest.length > 0 ? [OPAQUE_MEMBER] : [makeItem("messageHandle")];
    // `2 s`, `1 calendar day`, `20 deg`
    if (family === "unit" || family === "angle")
      return rest.length > 0
        ? []
        : [
            makeItem(
              family === "angle"
                ? "angle"
                : name.startsWith("calendar ")
                  ? "calendarDuration"
                  : "duration",
            ),
          ];
    // the builtins' declared results (`script(...)`, the text functions)
    if (family === "builtin") {
      if (rest.length > 0) return [];
      const fallback = defaultOf(c);
      return [
        makeItem(builtinResult(name)),
        ...(fallback === undefined ? [] : yield* this.valueItems(fallback, at, [])),
      ];
    }
    const method = family === "method" && c.receiver !== null ? methodCategory(name) : undefined;
    // F7a–c, F25: a declared result, or what a removal gives
    if (method !== undefined && c.receiver !== null && method.gives.kind !== "copy") {
      const gives = method.gives;
      for (const item of withoutEmpty(yield* this.valueItems(c.receiver, at, []))) {
        if (gives.kind === "declared") {
          const kinds = declaredResult(name, gives.kinds, item.tag);
          if (rest.length === 0)
            out.push(
              ...kinds.map((tag) =>
                carried(
                  { ...makeItem(tag), cert: kinds.length === 1 ? item.cert : ("pos" as const) },
                  [item],
                ),
              ),
            );
        } else if (item.tag === "unknown") {
          // a dict's removed value, or a list's or a set's `null` where it gives that
          out.push(item);
          if (gives.fromList === "null" && rest.length === 0)
            out.push(carried(makeItem("null", null, { cert: "pos" }), [item]));
        } else if (gives.fromList === "null" && item.tag !== "dict") {
          if (rest.length === 0)
            out.push(carried(makeItem("null", null, { cert: item.cert }), [item]));
        } else if (COLLECTIONS.has(item.tag))
          out.push(
            ...weaken(
              belowSelected(
                yield* this.valueItems(c.receiver, at, joinSteps(["element"], rest)),
                rest,
              ),
            ),
          );
      }
      return out;
    }
    // F10: a copy of the elements, which may hold none where it takes a count: a receiver's own elements, or those its
    // kind declares (a range's whole numbers)
    if (method !== undefined && c.receiver !== null && method.gives.kind === "copy") {
      const copy = method.gives;
      const receiver = yield* this.valueItems(c.receiver, at, []);
      // the receiver's own collection is not the copy's kind (a range's `toList` gives a list)
      if (rest.length === 0)
        return [
          carried(makeItem(copy.into), receiver),
          ...receiver.filter((item) => !COPIED.has(item.tag)),
        ];
      const kinds = withoutEmpty(receiver);
      const declared = kinds.some((item) => kindElement(item.tag) !== undefined);
      return [
        // a kind's declared elements may be none (a range's bounds decide): the copy's element step keeps that mark
        ...(declared && rest.length === 1 ? [EMPTY] : []),
        ...(rest.length === 1
          ? kinds.flatMap((item) => {
              const element = kindElement(item.tag);
              return element === undefined
                ? []
                : [
                    carried(
                      {
                        ...makeItem(element, item.writer, { context: item.context }),
                        cert: item.cert,
                      },
                      [item],
                    ),
                  ];
            })
          : []),
        ...(kinds.some((item) => kindElement(item.tag) === undefined)
          ? yield* this.valueItems(c.receiver, at, joinSteps(["element"], rest.slice(1)))
          : []),
        ...(copy.mayHoldNone && rest.length === 1 ? [EMPTY] : []),
      ];
    }
    if (family === "operator" && name === "+" && rest.length > 0) {
      // TABLE r4.87: a `+` fourth or later in a run of terms answers below its root as the run's third
      const repeated = contract.plusRepeatOf(c.result, true);
      if (repeated !== c.result) return [...(yield* this.valueItems(repeated, at, rest))];
      const operands: (readonly Item[])[] = [];
      // (an operand admission rejected from the join gives it nothing: A6, `joinElements`)
      for (const argument of c.arguments)
        if (this.pass.lists.joined(argument))
          operands.push(yield* this.valueItems(argument, at, rest));
      return [...plusElements(operands, rest, this.pass)];
    }
    // F16
    const operator = operatorOf(c);
    if (operator !== null) {
      if (rest.length > 0) return [];
      const operands: (readonly Item[])[] = [];
      for (const argument of c.arguments)
        operands.push(withoutEmpty(yield* this.valueItems(argument, at, [])));
      return operationItems(operator, operands, program.scope, c.site);
    }
    // `and`, `or`, `not`, `==`, `!=`, `is`: a truth value (C3, C13 check the operands)
    if (family === "logic" || family === "comparison" || family === "typeTest")
      return rest.length > 0 ? [] : [makeItem("boolean")];
    // F25: the result or the default
    const conversion = family === "conversion" ? conversionCategory(name) : undefined;
    if (conversion?.kind === "converts") {
      if (rest.length > 0) return [];
      const kind = conversionKind(conversion.result);
      const fallback = defaultOf(c);
      if (fallback !== undefined)
        return [makeItem(kind), ...(yield* this.valueItems(fallback, at, []))];
      return conversion.optional
        ? [makeItem(kind, null, { cert: "pos" }), makeItem("null", null, { cert: "pos" })]
        : [makeItem(kind)];
    }
    if (conversion?.kind === "parses") {
      const expected = yield* contract.expectedOf(c, rest);
      if (expected !== null) return [...expected];
      const fallback = defaultOf(c);
      return fallback === undefined
        ? [unknownItem(REASON.external)]
        : [...(yield* this.defaultKinds(fallback, at, rest)), ...emptyAt(rest)];
    }
    // F25: the built-in's declared result
    const interaction = family === "interaction" ? interactionCategory(name) : undefined;
    if (interaction?.kind === "asks")
      return rest.length === 0 ? [makeItem(interaction.result)] : [];
    // r4.47 (5): a clock read gives its declared kind, as an ask does
    const clock = family === "clock" ? clockResult(name) : undefined;
    if (clock !== undefined) return rest.length === 0 ? [makeItem(clock)] : [];
    // V30 §19: askChoice's answer, per option its label, or each of its buttons' values
    if (interaction?.kind === "options") {
      const options = contract.choiceOptions(c, true);
      // (a wide choice's options as a tree of demands, `choiceRange`)
      if (options.length > WIDE)
        return [...(yield* this.choiceRange(c, at, rest, 0, options.length))];
      return yield* choiceItems(
        c,
        rest,
        this.#choiceRead(at),
        contract.choiceKeysStored(),
        options,
        this.#choiceWide(c, at),
      );
    }
    const member = family === "member" ? memberResult(name) : undefined;
    if (member !== undefined) return member.map((kind) => makeItem(kind));
    // F19a: a handle's members are the runtime's
    if (family === "timer" || family === "media")
      return rest.length === 0 ? [makeItem(family)] : [OPAQUE_MEMBER];
    // F25: a button's, a popup's or a camera's fixed result; a handle's members are the runtime's (F19a)
    const shown = shownResult(name);
    if (shown !== undefined)
      return rest.length === 0 ? [makeItem(shown)] : shown === "duration" ? [] : [OPAQUE_MEMBER];
    // a range: its elements are its kind's (`kindElement`), nothing stands below it by path
    if (family === "range") return rest.length === 0 ? [makeItem("range")] : [];
    // a method without a category, per receiver alternative: its declared result per receiver kind (F25), else the
    // runtime's opaque answer on a known kind (C2: its consumers keep their checks, r4.47 (1)); what the core cannot know
    // keeps its own reasons. A receiver without items yet is a provisional bottom, no answer: the method's result stays
    // the bottom, which the solver completes (S3 §1, r4.44), never an `unknown` with a reason of its own
    if (family === "method" && c.receiver !== null) {
      const receiver = withoutEmpty(yield* this.valueItems(c.receiver, at, []));
      return receiver.flatMap((item) => {
        if (item.tag === "unknown") return [item];
        const declared = declaredMethod(item.tag, name);
        if (declared === undefined) return [OPAQUE_MEMBER];
        return rest.length > 0
          ? []
          : declared.map((tag) =>
              carried(
                {
                  ...makeItem(tag, item.writer, { context: item.context }),
                  cert: declared.length === 1 ? item.cert : ("pos" as const),
                },
                [item],
              ),
            );
      });
    }
    return [unknownItem(REASON.external)];
  }
}

/**
 * P7, F17b: what the graph's literal proof says of a `get` at its node `at`: its default is reached where its node is
 * live (`reached`), and only a `get` on a list literal with a literal index is certain: the default dead, the element
 * the value; the literal with no element there, the default the only value (`only`), its receiver's element given
 * nowhere. Elsewhere the element may be absent and both are possible.
 */
export function getProof(
  program: CoreProgram,
  c: Extract<ValueConstraint, { readonly kind: "get" }>,
  at: FlowNode | null,
): { readonly fallbackAt: FlowNode | null; readonly reached: boolean; readonly only: boolean } {
  const fallbackAt = program.exprAt(program.places[c.fallback]?.site ?? c.site);
  const reached = fallbackAt !== null && !fallbackAt.dead;
  const only = reached && at?.kind === "default-accepted" && at.predecessors.length === 1;
  return { fallbackAt, reached, only };
}
