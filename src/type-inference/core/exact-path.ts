import type { PlaceId } from "../graph.js";
import type { CorePass } from "./answers.js";
import { keyOf, keyPlace, prefixesOf, type Definition, type Key } from "./definitions.js";
import type { FlowNode } from "./flow-graph.js";
import {
  alternatives,
  EMPTY,
  mergeItems,
  REASON,
  weaken,
  type ContextWord,
  type Item,
  type Writer,
} from "./items.js";
import type { Work } from "./solver.js";

/*
 * The exact path of the coarse core (checkpoint 9, TABLE §3.1): a read of key k at node n is answered from one
 * definition D when X1–X7 and the receiver rule R hold: n and D are live (X1), D is the nearest dominating definition
 * over k and its prefixes (X2), D is an exact definition (X3), D and n share their nearest boundary (X4) and their
 * loops (X5), no own event of k lies strictly after D and not after n (X6), and no block can have interfered (X7).
 * Otherwise the read takes the contract, and the first condition that failed is the warning's context word (§3.4).
 * D's value at the path below its key is evaluated at D's node, once per (D, path).
 */

/** The exact path's answer: D with the path below its key, or the first failing condition's word. */
export type ExactAnswer =
  { readonly def: Definition; readonly rest: readonly string[] } | { readonly fail: ContextWord };

/** A plain copy's origin (W34): the definition it copies, or the source the copy chain stops at with its word. */
type Origin =
  | { readonly def: Definition }
  | { readonly place: PlaceId; readonly node: FlowNode; readonly fail: ContextWord };

export class ExactPath {
  readonly #memo = new Map<string, ExactAnswer>();
  readonly #origins = new Map<number, Origin>();

  public constructor(readonly pass: CorePass) {}

  /** The exact path of a read of `key` at `node`; `before`: a definition at `node` itself does not count. */
  public exactPath(key: Key, node: FlowNode, before = false): ExactAnswer {
    const memoKey = `${key}|${node.id}|${before ? 1 : 0}`;
    let answer = this.#memo.get(memoKey);
    if (answer === undefined) {
      answer = this.#exactPath(key, node, before);
      this.#memo.set(memoKey, answer);
    }
    return answer;
  }

  #exactPath(key: Key, node: FlowNode, before: boolean): ExactAnswer {
    const { program, definitions, lists, handlers } = this.pass;
    program.work.charge("exactQueries");
    if (!program.live(node)) return { fail: "dead-code" }; // X1
    // F20: a function's result is never the exact path
    if (program.resultPlaces.has(keyPlace(key))) return { fail: "call" };
    const reaching = lists.reachingDef(key, node, before);
    // X2: no dominating definition; a key with stores is reached from another callable or file
    if (reaching === null)
      return {
        fail: [key, ...prefixesOf(key)].some(
          (prefix) => (definitions.byKey.get(prefix) ?? []).length > 0,
        )
          ? "call"
          : "unknown",
      };
    const d = reaching.def;
    // X3 with R: a declaration, a whole store, an add, a clear or a removal with a certain receiver, a loop
    // variable, the binding of a single-site non-recursive callee's parameter
    if (
      d.kind === "const"
        ? d.how !== "loop variable"
        : d.how === "return" ||
          d.weak ||
          (d.how === "argument" || d.how === "parameter default"
            ? !lists.singleSite(d.fn)
            : !lists.certain(d))
    )
      return { fail: "member" };
    // §3.4 (r4.11): D's value projected past an element step over a copy stops there (F12), X3's `member`, which
    // comes before any later condition's word
    const word = (found: ContextWord): ExactAnswer => ({
      fail: this.#overCopy(d, reaching.rest) ? "member" : found,
    });
    const boundary = program.dom.edom(node);
    // X4
    if (program.dom.edom(d.node) !== boundary)
      return word(boundary?.statement?.kind === "labelStatement" ? "label" : "call");
    // X5
    if (!node.loops.every((loop) => d.node.loops.includes(loop))) return word("loop");
    // X6
    const event = lists.eventBetween(key, d.node, node);
    if (event !== null) return word(event);
    // X7: a read in block code or code a block reaches takes the contract (O15); a handler store may have run
    if (program.blockReachable(node)) return word("handler");
    if (handlers.handlerTouches(key) && handlers.afterSomeCreation(node)) return word("handler");
    return reaching;
  }

  /** Whether a whole store's literal value, read at `rest`, passes an element step over a copy (`[seed, seed]`). */
  #overCopy(d: Definition, rest: readonly string[]): boolean {
    const { program, contract } = this.pass;
    if (
      d.kind !== "whole" ||
      d.value === undefined ||
      !(program.hasOf.has(d.value) || program.cellOwner.has(d.value))
    )
      return false;
    const index = contract.literalIndex(d.value);
    const inElement = program.cellOwner.get(d.value)?.kind === "cell";
    for (let length = 0; length < rest.length; length += 1) {
      program.work.charge("invSteps");
      const at = rest.slice(0, length);
      if ((inElement || at.includes("element")) && (index.reads.get(at.join("."))?.length ?? 0) > 0)
        return true;
    }
    return false;
  }

  /**
   * W34 (r4.33): a whole copy of a record place stored only whole and never tested has, at a property path, its
   * origin's value: the copy chain is resolved once per copy at the record level, then projected at the field.
   */
  #plainCopySource(d: Definition): PlaceId | null {
    const { program, definitions, guards } = this.pass;
    if (d.kind !== "whole" || d.weak || d.value === undefined) return null;
    const source = program.occurrenceOf.get(d.value);
    if (source === undefined || program.isHost(source)) return null;
    if (definitions.keysBelow(keyOf(source, [])).length > 0) return null;
    return guards.testedPlaces().has(source) ? null : source;
  }

  #copyOrigin(d: Definition): Origin {
    const { program } = this.pass;
    const seen: Definition[] = [];
    let current = d;
    let origin: Origin;
    for (;;) {
      program.work.charge("exactQueries");
      const known = this.#origins.get(current.uid);
      if (known !== undefined) {
        origin = known;
        break;
      }
      const source = this.#plainCopySource(current);
      const node =
        source === null
          ? null
          : (program.occNode.get(current.value!) ??
            program.projOf.get(current.value!)?.node ??
            null);
      if (source === null || node === null) {
        origin = { def: current };
        break;
      }
      seen.push(current);
      const answer = this.exactPath(keyOf(source, []), node);
      if (!("def" in answer)) {
        origin = { place: source, node, fail: answer.fail };
        break;
      }
      if (answer.def.kind !== "whole" || answer.rest.length > 0) {
        origin = { def: current };
        break;
      }
      current = answer.def;
    }
    for (const copy of seen) this.#origins.set(copy.uid, origin);
    return origin;
  }

  /** D's value at the path `rest` below its key, at D's node (§3.1's answer): once per (D, path). */
  public *defVal(d: Definition, rest: readonly string[]): Work<readonly Item[]> {
    return yield {
      key: `def|${d.uid}|${rest.join(".")}`,
      kind: "exact",
      file: d.site.file,
      offset: d.site.start,
      make: () => this.#defVal(d, rest),
    };
  }

  *#defVal(d: Definition, rest: readonly string[]): Work<readonly Item[]> {
    const { program, definitions, values, contract } = this.pass;
    const scope = program.scope;
    program.work.charge("exactValues");
    if (d.kind === "const") return rest.length === 0 ? (d.items ?? []) : [];
    const writer = definitions.writerOf(d);
    if (d.kind === "whole" && rest.length > 0 && !rest.includes("element")) {
      const origin = this.#copyOrigin(d);
      if (!("def" in origin) || origin.def !== d) {
        const place = "def" in origin ? origin.def.place : origin.place;
        if (!(yield* contract.refReceiver(keyOf(place, rest)))) {
          const items =
            "def" in origin
              ? yield* this.defVal(origin.def, rest)
              : yield* contract.contractRead(keyOf(origin.place, rest), origin.node, origin.fail);
          return mergeItems(withWriter(items, writer), scope);
        }
      }
    }
    if (d.kind === "whole")
      return mergeItems(
        withWriter(yield* values.valueItems(d.value!, d.node, rest), writer),
        scope,
      );
    const before = yield* values.keyItems(keyOf(d.place, [...d.path, ...rest]), d.node, true);
    // F5–F7: the collection's kind is unchanged
    if (rest.length === 0) return before;
    const element = rest.length === 1 && rest[0] === "element";
    // F6: no element
    if (d.kind === "clear") return element ? [EMPTY] : [];
    // F7: every element possible, maybe none
    if (d.kind === "weaken")
      return element
        ? [...weaken(withoutEmpty(before), "member"), EMPTY]
        : weaken(before, "member");
    if (rest[0] !== "element") return before;
    const own = withWriter(
      yield* values.valueItems(
        d.value!,
        (d.orig ?? d).node,
        d.how === "elements" ? rest : rest.slice(1),
      ),
      writer,
    );
    // F5: an `add` makes the collection hold an element; an `addAll` leaves its M unchanged, whatever its source
    if (rest.length > 1) return alternatives([...before, ...own], scope);
    const empty = d.how === "elements" && before.some((item) => item.tag === "empty");
    return alternatives(
      [...withoutEmpty(before), ...withoutEmpty(own), ...(empty ? [EMPTY] : [])],
      scope,
    );
  }
}

/** The items without the emptiness mark: the kinds a value has. */
export function withoutEmpty(items: readonly Item[]): Item[] {
  return items.filter((item) => item.tag !== "empty");
}

/**
 * F28: the store that put the kinds into the key explains them; a property's absence keeps the literal that lacks it
 * (F11), and the emptiness mark has no writer.
 */
export function withWriter(items: readonly Item[], writer: Writer | null): readonly Item[] {
  if (writer === null) return items;
  return items.map((item) =>
    item.tag === "empty" || (item.tag === "unknown" && item.reasons === REASON.missing)
      ? item
      : { ...item, writer },
  );
}
