import type { ForStatement } from "../../ast.js";
import type { PlaceId, SourceSite } from "../graph.js";
import type { Callable, FlowLoop, FlowNode } from "./flow-graph.js";
import { makeItem, type ContextWord, type Item, type Writer } from "./items.js";
import { siteKey, type CoreProgram } from "./program.js";

/*
 * The definitions of the coarse core (checkpoint 9, TABLE §2, §3.1 X2–X6, §6 O, §8): every store, add, clear,
 * removal, binding and return as a definition of a key at its node, and the indexes the exact path asks of them: per
 * key the definitions in dominator order with a lifting table (X2's nearest dominating definition), per key the own
 * events of the key and the keys below it (X6), the owner sets and the one global list of call sites (X6), and the
 * receiver rule R. Nothing here evaluates a value.
 */

/**
 * A key: a place and a path of steps below it (`state.party.element.hp`), written `place|steps`. The collector's place
 * and the path are its identity; the place's label only shows it.
 */
export type Key = string;

export function keyOf(place: PlaceId, path: readonly string[]): Key {
  return `${place}|${path.join(".")}`;
}

export function keyPlace(key: Key): PlaceId {
  return Number(key.slice(0, key.indexOf("|")));
}

export function keyPath(key: Key): string[] {
  const steps = key.slice(key.indexOf("|") + 1);
  return steps === "" ? [] : steps.split(".");
}

/** The prefixes of a key, the nearest first: `a|b.c` has `a|b` and `a|`. */
export function prefixesOf(key: Key): Key[] {
  const place = keyPlace(key);
  const path = keyPath(key);
  const prefixes: Key[] = [];
  for (let length = path.length - 1; length >= 0; length -= 1)
    prefixes.push(keyOf(place, path.slice(0, length)));
  return prefixes;
}

/**
 * What a definition does to its key (TABLE §2): a whole store (a declaration, an assignment, a loop variable's
 * binding, a parameter's argument or default, a return: F1–F4, F9, F21–F23, F27); an `add` or `addAll` of its
 * collection (F5); a `clear` (F6); a removal, which leaves every element possible (`weaken`, F7a–c); or a fixed value
 * (`const`: a function's result `null` where its body ends without one, a dict loop's text key, F20, F27b).
 */
export type DefinitionKind = "whole" | "add" | "clear" | "weaken" | "const";

export interface Definition {
  /** Its index in the order definitions were made, for memo keys. */
  readonly uid: number;
  readonly kind: DefinitionKind;
  /** A store or mutator through an element step: weak, never an exact D (F13). */
  readonly weak: boolean;
  readonly key: Key;
  readonly place: PlaceId;
  readonly path: readonly string[];
  /** The stored or added value, for a whole store and an add. */
  readonly value?: PlaceId;
  readonly node: FlowNode;
  /** The store's kind (`initializer`, `assignment`, `element`, `elements`, ...), `return`, `argument`, a method. */
  readonly how: string;
  /** Where its diagnostics sit: the stored value, the argument, the returned value. */
  readonly site: SourceSite;
  /** The function of an argument, a parameter default or a return. */
  readonly fn?: number;
  /** The place a store writes into, whose projection's owner is the store's receiver. */
  readonly into?: PlaceId;
  /** The key of the receiver a store through a member or an add changes, for R. */
  readonly recv: Key | null;
  /** Where that receiver is prepared (R), or `null`. */
  readonly prep: FlowNode | null;
  /** A fixed value's items. */
  readonly items?: readonly Item[];
  /** F5a: the add a loop's exit definition stands for, and its loop. */
  readonly orig?: Definition;
  readonly loop?: ForLoopFacts;
}

/** F5a's facts of a `for` loop with a held iterable whose body ends with an add. */
export interface ForLoopFacts {
  readonly loop: FlowLoop;
  /** The ways back to the head from the body: the body's end, a `continue`. */
  readonly backs: readonly FlowNode[];
  /** The iterable's value place and node. */
  readonly value: PlaceId;
  readonly node: FlowNode;
}

const REMOVALS: ReadonlySet<string> = new Set(["removeAt", "remove", "removeFirst", "removeLast"]);

/** The number of comparisons a sort of `count` elements is charged. */
export function sortCost(count: number): number {
  return count <= 1 ? count : count * Math.ceil(Math.log2(count));
}

/** The index of the first of the sorted positions at least `target`. */
function lowerBound(positions: readonly number[], target: number): number {
  let low = 0;
  let high = positions.length;
  while (low < high) {
    const middle = (low + high) >> 1;
    if (positions[middle]! < target) low = middle + 1;
    else high = middle;
  }
  return low;
}

/** A range of dominator positions, both ends included. */
export type PositionRange = readonly [number, number];

/**
 * The definitions of a program, made once: per key the definitions, the stores and transfers C9 and admission index,
 * the literal cells' stores, the owner sets and the global site list (TABLE §8: definitions + sites).
 */
export class DefinitionIndex {
  readonly byKey = new Map<Key, Definition[]>();
  /** The stores into a literal's own cells and properties, by the cell or property place. */
  readonly cellDefs = new Map<PlaceId, Definition[]>();
  /** The stores into each destination key (an add at its element), with the path below the key they reach. */
  readonly candidates = new Map<
    Key,
    { readonly d: Definition; readonly at: readonly string[] }[]
  >();
  /** The stores and adds into places; and the returns, arguments and parameter defaults (C9's transfers). */
  readonly storeDefs: Definition[] = [];
  readonly transferDefs: Definition[] = [];
  /** A binding's declaration: its initializer or its loop binding. */
  readonly declOf = new Map<PlaceId, Definition>();
  /** F5a: a loop's exit definition per collection key. */
  readonly loopAdds = new Map<Key, Definition[]>();
  /** The definitions storing each value, literal cells included (A1, C10, F18). */
  readonly byValue = new Map<PlaceId, Definition[]>();
  /** The operation a fallback operand or a default belongs to: it lands where the operation's result lands. */
  readonly fallbackOf = new Map<PlaceId, PlaceId>();
  /** C9: the values external data enters by, and the store that brought each in (its ingress store). */
  readonly ingress = new Set<PlaceId>();
  readonly ingressStore = new Map<PlaceId, Writer>();
  /** The keys below each key that have definitions (X6's own events, X7's keys below). */
  readonly #keysBelow = new Map<Key, Key[]>();
  readonly #foreignAt = new Set<Key>();
  readonly #foreignBelow = new Set<Key>();
  /** The dominator positions of every live call site's call-in and call-out outside block code, sorted (X6). */
  readonly sitePositions: readonly number[];
  #serial = 0;

  public constructor(readonly program: CoreProgram) {
    const work = program.work;
    const parameterDefaults = new Map<
      PlaceId,
      { readonly value: PlaceId; readonly site: SourceSite }
    >();
    for (const constraint of program.constraints) {
      work.charge("indexSteps");
      for (const operand of [
        constraint.kind === "fallback" ? constraint.left : undefined,
        constraint.kind === "fallback" ? constraint.right : undefined,
        constraint.kind === "get" || constraint.kind === "load" ? constraint.fallback : undefined,
        "named" in constraint
          ? constraint.named.find((argument) => argument.name === "default")?.value
          : undefined,
      ])
        if (typeof operand === "number" && "result" in constraint)
          this.fallbackOf.set(operand, constraint.result);
      if (constraint.kind === "store" && constraint.how === "parameter default") {
        parameterDefaults.set(constraint.into, { value: constraint.value, site: constraint.site });
        continue;
      }
      if (constraint.kind === "store") this.#store(constraint);
      else if (constraint.kind === "return") this.#return(constraint);
      else if (constraint.kind === "call") this.#arguments(constraint);
      else if (
        constraint.kind === "operation" &&
        constraint.contract.family === "method" &&
        typeof constraint.receiver === "number" &&
        (constraint.contract.name === "clear" || REMOVALS.has(constraint.contract.name))
      )
        this.#removal(constraint.receiver, constraint.contract.name, constraint.site);
    }
    this.#parameterDefaults(parameterDefaults);
    this.#ingress();
    this.#loopAdds();
    this.#constants();
    for (const definitions of [...this.byKey.values(), ...this.cellDefs.values()])
      for (const d of definitions)
        if (d.value !== undefined) {
          work.charge("indexSteps");
          append(this.byValue, d.value, d);
        }
    // the owner sets (X6): a live store by a callable other than its key's declaring activation that ordinary code may
    // run; a helper only blocks run stores as their code does (X7, r4.10)
    const ordinary = this.#ordinaryCallables();
    for (const d of this.storeDefs) {
      work.charge("ownerSteps", d.path.length + 1);
      const owner = program.flow.ownerOf(d.node.region);
      if (
        !program.live(d.node) ||
        owner === null ||
        owner === this.declaringCallable(d.place) ||
        !ordinary.has(owner)
      )
        continue;
      this.#foreignAt.add(d.key);
      this.#foreignBelow.add(d.key);
      for (const prefix of prefixesOf(d.key)) this.#foreignBelow.add(prefix);
    }
    const sites = new Set<number>();
    for (const site of program.flow.sites)
      for (const node of [site.callIn, site.callOut])
        if (program.live(node) && !program.inBlockCode(node)) sites.add(program.position(node));
    this.sitePositions = [...sites].sort((a, b) => a - b);
    work.charge("eventSteps", 2 * program.flow.sites.length + sortCost(this.sitePositions.length));
    for (const [key] of this.byKey) {
      const place = keyPlace(key);
      const path = keyPath(key);
      for (let length = 0; length < path.length; length += 1) {
        work.charge("indexSteps");
        append(this.#keysBelow, keyOf(place, path.slice(0, length)), key);
      }
    }
  }

  /**
   * The callables ordinary code may run: each one no block runs, and each one a live call or transfer outside block
   * code in one of them, or in the startup, enters; a worklist over those edges, each once.
   */
  #ordinaryCallables(): ReadonlySet<Callable> {
    const { flow, work } = this.program;
    const ordinary = new Set(flow.callables.filter((callable) => !flow.blockCalled.has(callable)));
    const queue = [...ordinary];
    const reach = (callable: Callable): void => {
      work.charge("ownerSteps");
      if (ordinary.has(callable)) return;
      ordinary.add(callable);
      queue.push(callable);
    };
    const onward = new Map<Callable, Callable[]>();
    const started: Callable[] = [];
    const edge = (at: FlowNode, region: number, callees: readonly Callable[]): void => {
      work.charge("ownerSteps");
      if (!this.program.live(at) || this.program.handlerOf(at) !== null) return;
      const caller = flow.callableOf(region);
      for (const callee of callees)
        if (caller === null) started.push(callee);
        else append(onward, caller, callee);
    };
    for (const site of flow.sites) edge(site.callIn, site.caller, site.callees);
    for (const jump of flow.jumps) edge(jump.node, jump.node.region, jump.files);
    for (const callable of started) reach(callable);
    while (queue.length > 0) for (const callee of onward.get(queue.pop()!) ?? []) reach(callee);
    return ordinary;
  }

  #add(d: Omit<Definition, "uid">, cell = false): Definition {
    const made: Definition = { uid: this.#serial++, ...d };
    if (cell) append(this.cellDefs, made.place, made);
    else {
      append(this.byKey, made.key, made);
      this.program.work.charge("defs");
    }
    return made;
  }

  #candidate(d: Definition, key: Key, at: readonly string[] = []): void {
    append(this.candidates, key, { d, at });
  }

  /** Where the receiver of a store or a mutator is prepared: its read's node (R). */
  #receiverNode(value: PlaceId): FlowNode | null {
    return this.program.occNode.get(value) ?? this.program.projOf.get(value)?.node ?? null;
  }

  #store(constraint: Extract<CoreProgram["constraints"][number], { kind: "store" }>): void {
    const program = this.program;
    const target = program.targetRoot(constraint.into);
    const projection = program.projOf.get(constraint.into);
    const add =
      ["element", "elements", "entry"].includes(constraint.how) &&
      projection !== undefined &&
      projection.step !== "index";
    // an add takes effect at its call, in the order the lowering evaluates the arguments
    const node =
      constraint.how === "loop variable"
        ? (program.flow.loopBindingAt(constraint.site) ?? program.effectNode(constraint.site))
        : add && projection.node !== null && projection.node.expression?.kind === "callExpression"
          ? projection.node
          : program.effectNode(constraint.site);
    const path = add ? target.path.slice(0, -1) : target.path;
    const key = keyOf(target.root, path);
    const cell = program.cellOwner.has(target.root) || program.hasOf.has(target.root);
    if (node === null) return;
    const d = this.#add(
      {
        kind: add ? "add" : "whole",
        weak: path.includes("element"),
        key,
        place: target.root,
        path,
        value: constraint.value,
        node,
        how: constraint.how,
        site: constraint.site,
        into: constraint.into,
        recv: add ? key : path.length > 0 ? keyOf(target.root, path.slice(0, -1)) : null,
        prep: add
          ? this.#receiverNode(projection.owner)
          : node.prepared !== undefined
            ? node.prepared
            : null,
      },
      cell,
    );
    if (cell) return;
    if (constraint.how === "initializer" || constraint.how === "loop variable")
      this.declOf.set(target.root, d);
    this.storeDefs.push(d);
    this.#candidate(
      d,
      add ? keyOf(target.root, target.path) : key,
      add && constraint.how === "elements" ? ["element"] : [],
    );
  }

  #return(constraint: Extract<CoreProgram["constraints"][number], { kind: "return" }>): void {
    if (constraint.value === null) return;
    const program = this.program;
    const fn = program.functionOf(constraint.fn);
    const node =
      program.flow.statementAt(constraint.site) ?? program.effectNode(constraint.site) ?? null;
    if (node === null) return;
    const d = this.#add({
      kind: "whole",
      weak: false,
      key: keyOf(fn.result, []),
      place: fn.result,
      path: [],
      value: constraint.value,
      node,
      how: "return",
      // r4.10: its diagnostics sit on the returned value
      site: program.places[constraint.value]?.site ?? constraint.site,
      fn: constraint.fn,
      recv: null,
      prep: null,
    });
    this.#candidate(d, d.key);
    this.transferDefs.push(d);
  }

  /** F21, F22: each argument is a whole store into its parameter at the parameter's binding node in the callee. */
  #arguments(constraint: Extract<CoreProgram["constraints"][number], { kind: "call" }>): void {
    const program = this.program;
    // F21: a dead call binds nothing
    const call = program.exprAt(constraint.site);
    if (call !== null && !program.live(call)) return;
    const fn = program.functionOf(constraint.fn);
    const region = program.functionRegion(constraint.fn);
    const bind = (parameter: PlaceId | undefined, argument: PlaceId): void => {
      if (parameter === undefined || region === undefined) return;
      const place = program.places[parameter];
      if (place?.kind.kind !== "parameter") return;
      const node = region.parameters.get(place.kind.name) ?? region.entry;
      const d = this.#add({
        kind: "whole",
        weak: false,
        key: keyOf(parameter, []),
        place: parameter,
        path: [],
        value: argument,
        node,
        how: "argument",
        // r4.10: its diagnostics sit on the argument
        site: program.places[argument]?.site ?? constraint.site,
        fn: constraint.fn,
        recv: null,
        prep: null,
      });
      this.#candidate(d, d.key);
      this.transferDefs.push(d);
    };
    constraint.arguments.forEach((argument, index) => bind(fn.parameters[index], argument));
    for (const named of constraint.named)
      bind(program.parameterPlace(constraint.fn, named.name), named.value);
  }

  #removal(receiver: PlaceId, name: string, site: SourceSite): void {
    const program = this.program;
    const target = program.targetRoot(program.occurrenceOf.get(receiver) ?? receiver);
    const node = program.effectNode(site);
    if (node === null || program.cellOwner.has(target.root) || program.hasOf.has(target.root))
      return;
    const key = keyOf(target.root, target.path);
    this.storeDefs.push(
      this.#add({
        kind: name === "clear" ? "clear" : "weaken",
        weak: target.path.includes("element"),
        key,
        place: target.root,
        path: target.path,
        node,
        how: name,
        site,
        recv: key,
        prep: this.#receiverNode(receiver),
      }),
    );
  }

  /**
   * A parameter's default is a whole store into the parameter where the default runs, a transfer C9 indexes like an
   * argument (r4.28): one ingress, one boundary.
   */
  #parameterDefaults(
    defaults: ReadonlyMap<PlaceId, { readonly value: PlaceId; readonly site: SourceSite }>,
  ): void {
    const program = this.program;
    for (const fn of program.graph.functions) {
      if (program.functionRegion(fn.id) === undefined) continue;
      for (const parameter of fn.parameters) {
        const given = defaults.get(parameter);
        const node = given === undefined ? null : program.exprAt(given.site);
        if (given === undefined || node === null) continue;
        const d = this.#add({
          kind: "whole",
          weak: false,
          key: keyOf(parameter, []),
          place: parameter,
          path: [],
          value: given.value,
          node,
          how: "parameter default",
          site: given.site,
          fn: fn.id,
          recv: null,
          prep: null,
        });
        this.#candidate(d, d.key);
        this.transferDefs.push(d);
      }
    }
  }

  /**
   * C9: the values external data enters by (a load, `fromJson`, `askChoice`, a read of a host global) and each one's
   * ingress store: the whole store of the value, or of the value that carries it there (the outermost literal holding
   * it, a property or element read of it, the fallback whose direct value it is). A fallback or default carries
   * nothing to its operation's store (C10): data there names its own read.
   */
  #ingress(): void {
    const program = this.program;
    for (const constraint of program.constraints)
      if (
        constraint.kind === "load" ||
        (constraint.kind === "operation" &&
          (constraint.contract.name === "fromJson" ||
            (constraint.contract.family === "interaction" &&
              constraint.contract.name === "choice")))
      )
        this.ingress.add(constraint.result);
    for (const [occurrence, binding] of program.occurrenceOf)
      if (program.isHost(binding)) this.ingress.add(occurrence);
    const ownOperand = new Set<PlaceId>();
    const readOfValue = new Map<PlaceId, PlaceId>();
    for (const constraint of program.constraints) {
      for (const operand of [
        constraint.kind === "fallback" ? constraint.right : undefined,
        constraint.kind === "get" || constraint.kind === "load" ? constraint.fallback : undefined,
        "named" in constraint
          ? constraint.named.find((argument) => argument.name === "default")?.value
          : undefined,
      ])
        if (typeof operand === "number") ownOperand.add(operand);
      if (constraint.kind === "project" && constraint.step !== "iteration")
        readOfValue.set(constraint.owner, constraint.into);
      else if (constraint.kind === "get" && typeof constraint.receiver === "number")
        readOfValue.set(constraint.receiver, constraint.result);
    }
    const storeOfValue = new Map<PlaceId, Definition>();
    for (const d of [...this.storeDefs, ...this.transferDefs])
      if (
        (d.kind === "whole" || d.kind === "add") &&
        d.value !== undefined &&
        !storeOfValue.has(d.value)
      )
        storeOfValue.set(d.value, d);
    const cellOfValue = new Map<PlaceId, PlaceId>();
    for (const [cell, definitions] of this.cellDefs)
      for (const d of definitions) if (d.value !== undefined) cellOfValue.set(d.value, cell);
    const carrierOf = (value: PlaceId): PlaceId | undefined => {
      const cell = cellOfValue.get(value);
      if (cell !== undefined) return program.cellOwner.get(cell)!.owner;
      return readOfValue.get(value) ?? this.fallbackOf.get(value);
    };
    for (const value of this.ingress) {
      let current = value;
      for (
        let depth = 0;
        depth < 256 &&
        !storeOfValue.has(current) &&
        !ownOperand.has(current) &&
        carrierOf(current) !== undefined;
        depth += 1
      ) {
        program.work.charge("indexSteps");
        current = carrierOf(current)!;
      }
      // a host read there, or a load or `fromJson` call: its own read, so the consumers it reaches stay linked to it
      if (ownOperand.has(current)) {
        const site = program.places[value]?.site;
        if (site !== null && site !== undefined)
          this.ingressStore.set(value, program.writer("read", site));
        continue;
      }
      const store = storeOfValue.get(current);
      if (store !== undefined) this.ingressStore.set(value, program.writer(store.how, store.site));
    }
  }

  /**
   * F5a (r4.5): a `for` loop whose body holds no `break` and no `goto` runs its body to the end at least once on every
   * run that reaches its exit when its iterable is held. An add of the loop's own body (not of an inner loop) that
   * lies on every way back to the head, with no clear, removal or whole store of its key or a prefix after it in the
   * body, is also a definition at the loop's exit; the read asks whether the iterable is held and whether an own event
   * of the collection lies between the add and a way back.
   */
  #loopAdds(): void {
    const program = this.program;
    const work = program.work;
    const ownDefinitions = new Map<FlowNode, Definition[]>();
    const anyDefinitions = new Map<FlowNode, Definition[]>();
    for (const d of this.storeDefs)
      if (d.node.loops.length > 0) {
        append(ownDefinitions, d.node.loops.at(-1)!, d);
        work.charge("defs", d.node.loops.length);
        for (const head of d.node.loops) append(anyDefinitions, head, d);
      }
    for (const loop of program.flow.loops) {
      if (loop.statement.kind !== "forStatement") continue;
      const body = ownDefinitions.get(loop.head);
      if (
        body === undefined ||
        loop.head.dead ||
        program.flow.leftBy.has(loop.head) ||
        !body.some((d) => d.kind === "add")
      )
        continue;
      // per key, the dominator positions of the body's clears, removals and whole stores
      const resets = new Map<Key, number[]>();
      for (const e of anyDefinitions.get(loop.head) ?? [])
        if (e.kind !== "add" && program.reached(e.node)) {
          work.charge("defs");
          append(resets, e.key, program.position(e.node));
        }
      for (const [, positions] of resets) {
        work.charge("defs", sortCost(positions.length));
        positions.sort((a, b) => a - b);
      }
      const backs = loop.head.predecessors.filter(
        (node) => node.loops.includes(loop.head) && program.live(node),
      );
      const iterable = (loop.statement satisfies ForStatement).iterable;
      const site: SourceSite = {
        file: loop.head.file,
        start: iterable.span.start.offset,
        end: iterable.span.end.offset,
      };
      const value = program.placeBySite.get(siteKey(site));
      const node = program.exprAt(site);
      if (value === undefined || node === null) continue;
      const facts: ForLoopFacts = { loop, backs, value, node };
      for (const d of body) {
        work.charge("defs", backs.length + 1);
        if (
          d.kind !== "add" ||
          !program.reached(d.node) ||
          !backs.every((back) => program.dom.dominates(d.node, back))
        )
          continue;
        const covers = [d.key, ...prefixesOf(d.key)];
        if (
          covers.some((key) => {
            const positions = resets.get(key);
            return (
              positions !== undefined &&
              positionsWithin(
                positions,
                program.position(d.node),
                program.positionEnd(d.node),
                program,
              ) > 0
            );
          })
        )
          continue;
        append(this.loopAdds, d.key, {
          ...d,
          uid: this.#serial++,
          node: loop.exit,
          orig: d,
          loop: facts,
        });
      }
    }
  }

  /** A function's result `null` where its body ends without a value (F20), a dict loop's text key (F27b). */
  #constants(): void {
    const program = this.program;
    program.work.charge("indexSteps", 2 * program.graph.functions.length);
    for (const fn of program.graph.functions) {
      const region = program.functionRegion(fn.id);
      if (region === undefined || region.void.dead) continue;
      const d = this.#add({
        kind: "const",
        weak: false,
        key: keyOf(fn.result, []),
        place: fn.result,
        path: [],
        node: region.void,
        how: "no-value",
        site: fn.site,
        recv: null,
        prep: null,
        items: [makeItem("null", program.writer("no-value", fn.site))],
      });
      this.#candidate(d, d.key);
    }
    for (const place of program.places)
      if (
        place.kind.kind === "binding" &&
        place.kind.declared === "loop" &&
        !this.declOf.has(place.id) &&
        place.site !== null
      ) {
        const node = program.flow.loopBindingAt(place.site);
        if (node === undefined) continue;
        this.declOf.set(
          place.id,
          this.#add({
            kind: "const",
            weak: false,
            key: keyOf(place.id, []),
            place: place.id,
            path: [],
            node,
            how: "loop variable",
            site: place.site,
            recv: null,
            prep: null,
            items: [makeItem("string", program.writer("loop variable", place.site))],
          }),
        );
      }
  }

  /** The keys below a key that have definitions. */
  public keysBelow(key: Key): readonly Key[] {
    return this.#keysBelow.get(key) ?? [];
  }

  /**
   * The activation that owns a binding (X6): a parameter's function, a `let`'s or a loop variable's function or file;
   * a `global` has none, so every callable that stores it is in its owner set.
   */
  public declaringCallable(place: PlaceId): Callable | null {
    const kind = this.program.places[place]?.kind;
    if (kind?.kind === "parameter") return this.program.functionRegion(kind.fn) ?? null;
    if (kind?.kind === "binding" && (kind.declared === "let" || kind.declared === "loop")) {
      const d = this.declOf.get(place);
      return d === undefined ? null : this.program.flow.callableOf(d.node.region);
    }
    return null;
  }

  /** Whether some callable other than the key's declaring one stores the key, a prefix or a key below it (X6). */
  public ownedAway(key: Key): boolean {
    if (this.#foreignBelow.has(key)) return true;
    for (const prefix of prefixesOf(key)) {
      this.program.work.charge("ownerSteps");
      if (this.#foreignAt.has(prefix)) return true;
    }
    return false;
  }

  /** The writer of a whole store or an add (F28): its kind and the site its diagnostics sit at. */
  public writerOf(d: Definition): Writer | null {
    return d.kind === "whole" || d.kind === "add" ? this.program.writer(d.how, d.site) : null;
  }
}

function append<K, V>(map: Map<K, V[]>, key: K, value: V): void {
  const list = map.get(key);
  if (list === undefined) map.set(key, [value]);
  else list.push(value);
}

/** How many of the sorted positions lie in [low, high], by two binary searches. */
function positionsWithin(
  positions: readonly number[],
  low: number,
  high: number,
  program: CoreProgram,
): number {
  program.work.charge("eventSteps", 2);
  return lowerBound(positions, high + 1) - lowerBound(positions, low);
}

/** A key's live definitions in dominator order, with their parents in the dominator tree and a lifting table (X2). */
interface SortedDefinitions {
  readonly list: readonly Definition[];
  readonly positions: readonly number[];
  /** `up[j][i]`: the 2^j-th dominating ancestor of definition i among the list, or -1. */
  readonly up: readonly Int32Array[];
  /** The positions of the definitions outside block code that are no loop-exit copies (X6's own events). */
  readonly eventPositions: readonly number[];
}

/** The reaching definition of a key at a node (X2): the definition and the path below its key the read asks for. */
export interface Reaching {
  readonly def: Definition;
  readonly rest: readonly string[];
}

/**
 * The definition lists of one pass (A6 recomputes them after a rejection): per key its live definitions sorted in
 * dominator order with a lifting table, the nearest dominating definition over a key and its prefixes, the own-event
 * lists, X6's first event between two nodes, and R.
 */
export class DefinitionLists {
  readonly #sorted = new Map<Key, SortedDefinitions>();
  readonly #events = new Map<Key, number[]>();
  readonly #certain = new Map<Definition, boolean>();
  readonly #singleSite = new Map<number, boolean>();

  public constructor(
    readonly index: DefinitionIndex,
    /** Whether a store takes part: not rejected by admission (A6). */
    readonly live: (d: Definition) => boolean,
  ) {}

  get #program(): CoreProgram {
    return this.index.program;
  }

  /** The order of two definitions at one node: the later source position comes last. */
  static #sourceOrder(d: Definition): number {
    return d.site.start;
  }

  public definitionsOf(key: Key): SortedDefinitions {
    const known = this.#sorted.get(key);
    if (known !== undefined) return known;
    const program = this.#program;
    const work = program.work;
    const mine = [...(this.index.byKey.get(key) ?? []), ...(this.index.loopAdds.get(key) ?? [])];
    work.charge("defScan", mine.length);
    const list = mine.filter(
      (d) =>
        this.live(d.orig ?? d) &&
        program.live(d.node) &&
        (d.orig === undefined || this.certain(d.orig)),
    );
    list.sort(
      (a, b) =>
        program.position(a.node) - program.position(b.node) ||
        DefinitionLists.#sourceOrder(a) - DefinitionLists.#sourceOrder(b),
    );
    work.charge("defSortElements", sortCost(list.length));
    const parent = new Int32Array(list.length);
    const stack: number[] = [];
    list.forEach((d, index) => {
      while (stack.length > 0 && !program.dom.dominates(list[stack.at(-1)!]!.node, d.node)) {
        stack.pop();
        work.charge("parentStackSteps");
      }
      parent[index] = stack.length > 0 ? stack.at(-1)! : -1;
      stack.push(index);
    });
    const up: Int32Array[] = [parent];
    for (let level = 1; 1 << level <= list.length; level += 1) {
      const previous = up[level - 1]!;
      up.push(previous.map((index) => (index < 0 ? -1 : previous[index]!)));
      work.charge("parentStackSteps", list.length);
    }
    const sorted: SortedDefinitions = {
      list,
      positions: list.map((d) => program.position(d.node)),
      up,
      eventPositions: list
        .filter((d) => !program.inBlockCode(d.node) && d.orig === undefined)
        .map((d) => program.position(d.node)),
    };
    this.#sorted.set(key, sorted);
    return sorted;
  }

  /** The nearest definition of the list dominating `node`; `before`: one at `node` itself does not count. */
  #nearest(sorted: SortedDefinitions, node: FlowNode, before: boolean): Definition | null {
    const program = this.#program;
    const work = program.work;
    const target = program.position(node);
    let low = 0;
    let high = sorted.list.length;
    while (low < high) {
      const middle = (low + high) >> 1;
      work.charge("rdWalk");
      if (sorted.positions[middle]! <= target) low = middle + 1;
      else high = middle;
    }
    let index = low - 1;
    if (before)
      while (index >= 0 && sorted.list[index]!.node === node) {
        index = sorted.up[0]![index]!;
        work.charge("rdWalk");
      }
    let d = index >= 0 ? sorted.list[index] : undefined;
    if (d !== undefined && !program.dom.dominates(d.node, node)) {
      // climb to the first dominating ancestor by binary lifting
      for (let level = sorted.up.length - 1; level >= 0; level -= 1) {
        const ancestor = sorted.up[level]![index]!;
        work.charge("rdWalk");
        if (ancestor >= 0 && !program.dom.dominates(sorted.list[ancestor]!.node, node))
          index = ancestor;
      }
      const ancestor = sorted.up[0]![index]!;
      d = ancestor >= 0 ? sorted.list[ancestor] : undefined;
    }
    return d ?? null;
  }

  /** X2: the deepest nearest dominating definition over the key and each prefix; at one node the later in source. */
  public reachingDef(key: Key, node: FlowNode, before = false): Reaching | null {
    const program = this.#program;
    program.work.charge("rdQueries");
    const place = keyPlace(key);
    const path = keyPath(key);
    let best: Reaching | null = null;
    for (let length = path.length; length >= 0; length -= 1) {
      const d = this.#nearest(
        this.definitionsOf(keyOf(place, path.slice(0, length))),
        node,
        before,
      );
      if (
        d !== null &&
        (best === null ||
          program.position(d.node) > program.position(best.def.node) ||
          (d.node === best.def.node &&
            DefinitionLists.#sourceOrder(d) > DefinitionLists.#sourceOrder(best.def)))
      )
        best = { def: d, rest: path.slice(length) };
    }
    return best;
  }

  /** The own events of a key: its own and its descendants' live definitions outside block code, sorted (X6). */
  #eventList(key: Key): readonly number[] {
    const known = this.#events.get(key);
    if (known !== undefined) return known;
    const program = this.#program;
    const positions: number[] = [];
    for (const below of [key, ...this.index.keysBelow(key)])
      for (const d of this.index.byKey.get(below) ?? []) {
        program.work.charge("eventSteps");
        if (this.live(d) && program.live(d.node) && !program.inBlockCode(d.node))
          positions.push(program.position(d.node));
      }
    program.work.charge("eventSteps", sortCost(positions.length));
    positions.sort((a, b) => a - b);
    this.#events.set(key, positions);
    return positions;
  }

  /** X6's interval from a to b: strictly after a in dominator order, not at or after b. */
  public spanBetween(a: FlowNode, b: FlowNode): readonly PositionRange[] {
    const program = this.#program;
    if (a === b) return [];
    const inA = program.position(a);
    const outA = program.positionEnd(a);
    if (program.dom.dominates(a, b))
      return [
        [inA + 1, program.position(b) - 1],
        [program.positionEnd(b) + 1, outA],
      ];
    return [[inA + 1, outA]];
  }

  /** The first of the sorted positions in a span (its ranges in order), or `Infinity`. */
  #firstIn(positions: readonly number[], span: readonly PositionRange[]): number {
    for (const [low, high] of span) {
      if (low > high) continue;
      this.#program.work.charge("eventSteps", 2);
      const first = lowerBound(positions, low);
      if (first < lowerBound(positions, high + 1)) return positions[first]!;
    }
    return Infinity;
  }

  /**
   * X6: the first own event of a key in a span, by position (§3.4 r4.30: the first in evaluation order names the
   * word): a call site under the owner rule, `call`; a store of the key, a descendant or a prefix, `branch`.
   */
  public eventIn(key: Key, span: readonly PositionRange[]): ContextWord | null {
    let at = Infinity;
    let word: ContextWord | null = null;
    const see = (positions: readonly number[], found: ContextWord): void => {
      const position = this.#firstIn(positions, span);
      if (position < at) {
        at = position;
        word = found;
      }
    };
    if (this.index.ownedAway(key)) see(this.index.sitePositions, "call");
    see(this.#eventList(key), "branch");
    for (const prefix of prefixesOf(key)) see(this.definitionsOf(prefix).eventPositions, "branch");
    return word;
  }

  /** The word of the first own event of a key strictly after `a` and not after `b`, or `null`. */
  public eventBetween(key: Key, a: FlowNode, b: FlowNode): ContextWord | null {
    return this.eventIn(key, this.spanBetween(a, b));
  }

  /** R: a receiver is certain when no own event of its key lies between its preparation and the effect. */
  public certain(d: Definition): boolean {
    if (d.orig !== undefined) return this.certain(d.orig);
    if (d.recv === null || d.prep === null || !this.#program.reached(d.prep)) return true;
    let certain = this.#certain.get(d);
    if (certain === undefined) {
      certain =
        this.#program.dom.dominates(d.prep, d.node) &&
        this.eventBetween(d.recv, d.prep, d.node) === null;
      this.#certain.set(d, certain);
    }
    return certain;
  }

  /** F21: a function with one live call site and no recursion binds its parameters exactly. */
  public singleSite(fn: number | undefined): boolean {
    if (fn === undefined) return false;
    const known = this.#singleSite.get(fn);
    if (known !== undefined) return known;
    const program = this.#program;
    const region = program.functionRegion(fn);
    program.work.charge("indexSteps", (region?.sites.length ?? 0) + 1);
    const single =
      region !== undefined &&
      region.sites.filter((site) => program.live(site.callIn)).length === 1 &&
      !program.flow.recursive.has(region);
    this.#singleSite.set(fn, single);
    return single;
  }
}
