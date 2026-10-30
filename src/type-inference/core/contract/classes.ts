import type { PlaceId } from "../../graph.js";
import { keptParts } from "../budget.js";
import type { Contract } from "../contract.js";
import { keyOf, type Definition } from "../definitions.js";
import { MIXED_FAN, MIXED_LEAF, type Writer } from "../items.js";
import { conversionCategory, interactionCategory } from "../method-categories.js";
import type { ValueConstraint } from "../program.js";
import { choiceLabels } from "./choices.js";
import { guardsBelow } from "./identity.js";
import { isKeyId, keyIdPlace } from "./key-ids.js";
import { markFree } from "./levels.js";
import { emptyIds, heldBelow, kindsPart, namesPart, pathOrder } from "./literal-index.js";
import type { KeptClass, ReadClass, ValueClass } from "./model.js";
import { operatorOf } from "./operations.js";
import { defaultOf, writtenOf } from "./terms.js";

// The classes the value side keys a value by (S6c): a read's, a bound binding's, a literal's, from their parts.

export const NO_CLASS: ValueClass = { cls: null, writers: () => [], mixed: 0 };

export const NO_KEPT_CLASS: KeptClass = { cls: null, mixed: 0, own: [], parts: [] };

/** Whether an operation is a choice (`askChoice`, V30 §19). */
function isChoice(c: Extract<ValueConstraint, { readonly kind: "operation" }>): boolean {
  return (
    c.contract.family === "interaction" && interactionCategory(c.contract.name)?.kind === "options"
  );
}

/**
 * A read's snapshot (TABLE §8, r4.68 (1)): the key it copies, its guard bit, that key's exact-path signature at the
 * read's own node (`readSignature`, where the value side reads it: X1–X6, X7's block reach, P3) and the handlers' fact
 * the signature leaves to its caller (X7: whether a handler that may store the key has been created there, H9), so
 * reads of one key in one literal are one key read only where they read the same: a guard, a call storing to the key,
 * or one registering a handler between them keeps them apart (Codex r25 F1). Once per read; `null` for no read.
 */
export function readSnapshot(contract: Contract, value: PlaceId): string | null {
  const known = contract.snapshots.get(value);
  if (known !== undefined) return known;
  const copied = contract.copiedKey(value);
  if (copied === null) return null;
  const { program, lists, guards, handlers } = contract.pass;
  let root = value;
  for (let projection = program.projOf.get(root); projection !== undefined;) {
    root = projection.owner;
    projection = program.projOf.get(root);
  }
  const node = program.occNode.get(root) ?? null;
  // (a read that takes its narrowing joins its G's environment, S10 part 2b)
  const read = `${guards.guardedRead(value) ? "g" : ""}${contract.pass.values.narrowingMark(value)}${copied}`;
  const snapshot =
    node === null
      ? keptParts(contract.work, read, "-")
      : keptParts(
          contract.work,
          read,
          // (a cursor's signature by its place's own key, as its family's one definition stands there and none below
          // it: the read's reaching definition and events are that key's, its path apart, no text made, G3 stage 1)
          lists.readSignature(isKeyId(copied) ? keyOf(keyIdPlace(copied), []) : copied, node),
          handlers.afterSomeCreation(node) ? "h" : "",
        );
  contract.snapshots.set(value, snapshot);
  return snapshot;
}

/**
 * S6c: what a read's answer at every path below it rests on, as one text, so reads of one class answer alike at every
 * path: its place and projection steps, and its guards there and below (`guardedRead`, `guardedBelowRead`: the
 * outermost tested paths below it whose regions hold it decide its mark at any path, §3.2); on the value side
 * (`exact`) its snapshot too (`readSnapshot`: the exact path's signature at its node, r4.68 (1)). A read of a stable
 * alias (`aliasOf`: an unwritten binding whose one definition is a whole copy of a read, on the value side the
 * read's exact answer) is that copy's read's class with its own steps and guards instead (S6-CARRIERS §4: a whole copy
 * of a stable source is an alias, never a contribution of its own), so k aliases of one source are one class; their
 * answers differ only by the alias's writer, the earliest standing for each kind where they merge (`aliasWriter`).
 * Never coarser than the answer: `null` for a value that is no read, a loop's visit, or a read an ingress stands in
 * (its leaf is its own, S6-CARRIERS §3.1). Once per read and side, a chain of aliases on an explicit walk.
 */
export function readClass(contract: Contract, value: PlaceId, exact: boolean): string | null {
  const memo = contract.readClasses[exact ? 1 : 0]!;
  const known = memo.get(value);
  if (known !== undefined) return known.cls;
  // (the reads along a chain of aliases, outermost first, to one whose class is known or that is no alias)
  const chain: PlaceId[] = [];
  let below: PlaceId | null = value;
  while (below !== null && !memo.has(below)) {
    chain.push(below);
    below = aliasOf(contract, below, exact)?.source ?? null;
  }
  for (let index = chain.length - 1; index >= 0; index -= 1) {
    const read = chain[index]!;
    const alias = aliasOf(contract, read, exact);
    memo.set(read, ownClass(contract, read, exact, alias));
  }
  return memo.get(value)!.cls;
}

/**
 * The writer a read's answer takes from the alias it reads (`readClass`): the alias's one definition's, standing for
 * every kind of the alias's answer but its emptiness and a missing property's (F28); `null` for a read of no alias.
 */
export function aliasWriter(contract: Contract, value: PlaceId, exact: boolean): Writer | null {
  contract.readClass(value, exact);
  return contract.readClasses[exact ? 1 : 0]!.get(value)?.writer ?? null;
}

/** A read's class (`readClass`), its alias's (`aliasOf`) known. */
function ownClass(
  contract: Contract,
  value: PlaceId,
  exact: boolean,
  alias: { readonly source: PlaceId; readonly writer: Writer | null } | null,
): ReadClass {
  const { program, guards, definitions } = contract.pass;
  const steps: string[] = [];
  let current = value;
  let fresh = definitions.ingress.has(current);
  for (let projection = program.projOf.get(current); projection !== undefined && !fresh;) {
    program.work.charge("invSteps");
    if (projection.step === "iteration") fresh = true;
    steps.push(projection.step);
    current = projection.owner;
    fresh ||= definitions.ingress.has(current);
    projection = program.projOf.get(current);
  }
  const binding = program.occurrenceOf.get(current);
  if (fresh || binding === undefined) return { cls: null, writer: null, base: null };
  const read = [
    steps.reverse().join(" "),
    guards.guardedRead(value) ? "g" : "",
    guards.guardedBelowRead(value).join(" "),
    // (on the value side, what its narrowing makes of its answer, S10 part 2b)
    exact ? contract.pass.values.narrowingMark(value) : "",
  ] as const;
  // (an alias of an alias read with no steps and no guard reads what that one reads: one class for the chain)
  const source =
    alias === null ? undefined : contract.readClasses[exact ? 1 : 0]!.get(alias.source);
  const base = source?.base ?? source?.cls ?? null;
  if (alias !== null && base !== null) {
    const plain = read.every((part) => part === "");
    return {
      cls: keptParts(contract.work, "a", base, ...read),
      writer: alias.writer,
      base: plain ? base : null,
    };
  }
  const snapshot = exact ? contract.readSnapshot(value) : "";
  return {
    cls: snapshot === null ? null : keptParts(contract.work, binding, ...read, snapshot),
    writer: null,
    base: null,
  };
}

/**
 * The read a read of a stable alias copies, with the alias's writer, or `null` (`readClass`): the binding read has one
 * stable definition (`stableDefinition`), a whole copy of a read.
 */
function aliasOf(
  contract: Contract,
  value: PlaceId,
  exact: boolean,
): { readonly source: PlaceId; readonly writer: Writer | null } | null {
  const { program, definitions } = contract.pass;
  let base = value;
  for (let projection = program.projOf.get(base); projection !== undefined;) {
    base = projection.owner;
    projection = program.projOf.get(base);
  }
  const d = stableDefinition(contract, base, exact);
  if (d === null || contract.copiedKey(d.value!) === null) return null;
  return { source: d.value!, writer: definitions.writerOf(d) };
}

/**
 * The one definition of the binding a read reads, where every path below the binding is that definition's value's
 * below it: an unwritten `let` or `global` with one definition, a whole store (none below it, in it or into it from
 * another callable: each would be a second definition), and on the value side the read's exact answer (`exactPath` at
 * its node, no rest: an event below the binding is one of its own, X6); once per read and side, `null` for any other.
 */
function stableDefinition(contract: Contract, read: PlaceId, exact: boolean): Definition | null {
  const memo = contract.stableDefinitions[exact ? 1 : 0]!;
  const known = memo.get(read);
  if (known !== undefined) return known;
  const { program, definitions } = contract.pass;
  const binding = program.occurrenceOf.get(read);
  let found: Definition | null = null;
  if (binding !== undefined && !definitions.ingress.has(read) && !program.isHost(binding)) {
    program.work.charge("invSteps");
    const kind = program.place(binding).kind;
    const key = keyOf(binding, []);
    const defs = definitions.byKey.get(key) ?? [];
    const d = defs[0];
    if (
      kind.kind === "binding" &&
      writtenOf(kind) === null &&
      defs.length === 1 &&
      d !== undefined &&
      d.kind === "whole" &&
      !d.weak &&
      d.value !== undefined &&
      definitions.keysBelow(key).length === 0 &&
      (definitions.loopAdds.get(key)?.length ?? 0) === 0
    )
      found = d;
    if (found !== null && exact) {
      const node = program.occNode.get(read) ?? null;
      const answer = node === null ? null : contract.pass.exact.exactPath(key, node);
      if (answer === null || !("def" in answer) || answer.def !== d || answer.rest.length > 0)
        found = null;
    }
  }
  memo.set(read, found);
  return found;
}

/**
 * #1313: the definition whose value a read of a stable binding (`stableDefinition`) answers as at every path, where
 * that value is no read or a read of no read class (a host global's, its leaf its own); `null` for any other read, an
 * alias's included (`aliasOf`).
 */
export function boundOf(contract: Contract, value: PlaceId, exact: boolean): Definition | null {
  if (!contract.pass.program.occurrenceOf.has(value)) return null;
  const d = stableDefinition(contract, value, exact);
  return d === null ||
    (contract.copiedKey(d.value!) !== null && contract.readClass(d.value!, exact) !== null)
    ? null
    : d;
}

/**
 * #1313: the class a value shares with the values whose answers differ from its own only by their roles' writers and,
 * where it is mixed, by their leaves or operands (`classOf`'s promise), across bindings: a read of a binding whose value
 * it answers as (`boundOf`) by that value's class (`classOf`), with the binding's writer, which stands for every kind
 * but an emptiness and a missing property, and its own guards and narrowing (`readClass`'s), so k bindings of loads of
 * one default, of host reads or of alike objects are one class; any other value its own class. Kept apart from
 * `classOf`, where reads of one binding stay one class unmixed, their leaves one: a site that shares a bound class
 * reads each member's leaves (`readGroupsAt`, `leafRoles`) or decides by kinds alone. Once per read and side.
 */
export function boundClass(contract: Contract, value: PlaceId, exact: boolean): KeptClass {
  const d = boundOf(contract, value, exact);
  if (d === null) return classed(contract, value, exact);
  const memo = contract.boundClasses[exact ? 1 : 0]!;
  const known = memo.get(value);
  if (known !== undefined) return known;
  const { definitions, guards, values } = contract.pass;
  const source = classed(contract, d.value!, exact);
  const bound: KeptClass =
    source.cls === null
      ? classed(contract, value, exact)
      : {
          cls: keptParts(
            contract.work,
            "b",
            source.cls,
            guards.guardedRead(value) ? "g" : "",
            guards.guardedBelowRead(value).join(" "),
            exact ? values.narrowingMark(value) : "",
          ),
          mixed: source.mixed,
          own: [definitions.writerOf(d)],
          parts: roleParts(contract, [d.value!], exact),
        };
  contract.keep(3);
  memo.set(value, bound);
  return bound;
}

/**
 * S6c (TABLE r4.85, r4.87): the class every discovery of the value side keys a value by, so that values of one class
 * answer alike at every path apart from the writers of their roles (`classWriters`) and, for a mixed class
 * (`classMixed`), an ingress's leaf or an operand's identity. A read by `readClass`; a read of a host global, whose
 * leaf is its own (`readClass`'s `null`), by the global and its guards, mixed (#1196); a projection (a property, an
 * element selection, a length) by its step and its owner's class; a call's result by the callee's result key (F20; on
 * the value side with the key's exact-path signature where the call returns); a literal by its structure (its own
 * kinds, objects, empty collections and absences per path, its cells' classes and guards, whether it is a cell); a
 * choice by its options (a label's kind, a choice object's selected value, any other option's value); a `load` or a
 * parse landing in no written type by its kind and its default's class and guards; any other operation by its family,
 * its name and its operands' classes (a `get`'s receiver and default, never its key, §4.6). On the value side
 * (`exact`) an operation only at its own node, a `get` or an `otherwise` with whether its default or fallback runs
 * (`Values.proofOf`). `null` for a loop's visit, a speaker, a literal holding a reference or a read its holder marks,
 * a choice holding a list's or a set's buttons, and a value any part of which has none. Once per value and side, on
 * an explicit walk.
 */
export function classOf(contract: Contract, value: PlaceId, exact: boolean): string | null {
  return classed(contract, value, exact).cls;
}

/**
 * The writers of a class's roles (`classOf`), in its parts' order: a read's alias's (`aliasWriter`), an operation's
 * operands' in turn, a literal's own place's (every kind, object and absence it gives itself lies in its own text, so
 * the earlier of two literals gives each of them first) and then its cells'; none for a call's result, whose stores
 * are the callee's. Each role's writer stands for the kinds that role gives, the rest of a class's answer being alike
 * (`roleMinima`).
 */
export function classWriters(
  contract: Contract,
  value: PlaceId,
  exact: boolean,
): readonly (Writer | null)[] | null {
  const memo = contract.classWritersBySide[exact ? 1 : 0]!;
  if (!memo.has(value))
    memo.set(value, writersOf(contract, classed(contract, value, exact), exact));
  return memo.get(value)!;
}

/**
 * A kept class's roles' writers (`classWriters`, `boundClass`): its own, then each part's in turn, read from the parts'
 * kept classes on an explicit walk; `null` for no class. The walk meets a part only where it gives a writer or
 * branches (`roleParts`), so it costs what it returns.
 */
export function writersOf(
  contract: Contract,
  kept: KeptClass,
  exact: boolean,
): readonly (Writer | null)[] | null {
  if (kept.cls === null) return null;
  const memo = contract.valueClasses[exact ? 1 : 0]!;
  const out = [...kept.own];
  // (pre-order: a part's own writer, then its parts', the first part's first)
  const pending = [...kept.parts].reverse();
  while (pending.length > 0) {
    contract.pass.program.work.charge("invSteps");
    const part = memo.get(pending.pop()!)!;
    for (const writer of part.own) out.push(writer);
    for (let index = part.parts.length - 1; index >= 0; index -= 1)
      pending.push(part.parts[index]!);
  }
  contract.keep(1 + out.length);
  return out;
}

/**
 * Whether a class (`classOf`) holds an ingress, whose external data names its own leaf (C9), or an operator's result,
 * which names its unknown operand by that operand's writer or by its own site (`fan`, F16): values of such a class
 * differ by those where their answer holds them (`differsIn`), so a site that shares them reads each where it does.
 */
export function classMixed(contract: Contract, value: PlaceId, exact: boolean): number {
  return classed(contract, value, exact).mixed;
}

/** A value's class (`classOf`), its parts' first, on an explicit stack. */
function classed(contract: Contract, value: PlaceId, exact: boolean): KeptClass {
  const memo = contract.valueClasses[exact ? 1 : 0]!;
  const known = memo.get(value);
  if (known !== undefined) return known;
  // (post-order: a value's parts, then the value; a part met again on its own walk has no class)
  const parts = new Map<PlaceId, readonly PlaceId[]>();
  const stack: PlaceId[] = [value];
  while (stack.length > 0) {
    const top = stack.at(-1)!;
    if (memo.has(top)) {
      stack.pop();
      continue;
    }
    const own = parts.get(top);
    if (own === undefined) {
      const found = classParts(contract, top, exact);
      parts.set(top, found);
      for (const part of found)
        if (!memo.has(part)) {
          if (parts.has(part)) memo.set(part, NO_KEPT_CLASS);
          else stack.push(part);
        }
      continue;
    }
    stack.pop();
    const joined = joinedClass(contract, top, exact, own);
    const kept: KeptClass =
      joined.cls === null
        ? joined
        : {
            ...joined,
            cls: classId(contract, joined.cls),
            parts: roleParts(contract, joined.parts, exact),
          };
    contract.keep(1 + kept.own.length + kept.parts.length);
    memo.set(top, kept);
  }
  return memo.get(value)!;
}

/**
 * The parts a kept class's walk reads (`writersOf`), in order: each part that holds a role, where a part with no writer
 * of its own and only one such part stands for that part. A walk then never enters an operand without writers, such as
 * a call's result, nor follows a chain of single operands (#1357, Codex r1 on #1417).
 */
function roleParts(
  contract: Contract,
  parts: readonly PlaceId[],
  exact: boolean,
): readonly PlaceId[] {
  const memo = contract.valueClasses[exact ? 1 : 0]!;
  const out: PlaceId[] = [];
  for (const part of parts) {
    const kept = memo.get(part)!;
    if (kept.own.length > 0 || kept.parts.length > 1) out.push(part);
    else if (kept.parts.length === 1) out.push(kept.parts[0]!);
  }
  return out;
}

/**
 * A class's text by its short name (`classOf`), interned: a class names its parts by their names, never by their
 * expansions, so the k operations of a run keep k texts of their own size, not of the run's (#1357).
 */
function classId(contract: Contract, text: string): string {
  let id = contract.classIds.get(text);
  if (id === undefined) {
    contract.keep(1);
    contract.classIds.set(text, (id = `C${contract.classIds.size}`));
  }
  return id;
}

/** The values a class rests on (`classOf`), in its roles' order: a projection's owner, a literal's cells, operands. */
export function classParts(contract: Contract, value: PlaceId, exact: boolean): readonly PlaceId[] {
  const { program } = contract.pass;
  program.work.charge("invSteps");
  if (program.occurrenceOf.has(value) || contract.readClass(value, exact) !== null) return [];
  const projection = program.projOf.get(value);
  if (projection !== undefined) return projection.step === "iteration" ? [] : [projection.owner];
  if (program.callOutOf.has(value)) return [];
  if (program.hasOf.has(value)) {
    const index = contract.literalIndex(value);
    const out: PlaceId[] = [];
    for (const [, node] of pathOrder(contract, index)) {
      for (const entry of node.reads) out.push(entry.value);
      for (const entry of node.others) out.push(entry.value);
    }
    contract.keep(out.length);
    return out;
  }
  const c = program.opOf.get(value);
  if (c?.kind === "get") return [c.receiver, c.fallback];
  if (c?.kind === "fallback") return [c.left, c.right];
  if (c?.kind === "load") return c.fallback === null ? [] : [c.fallback];
  if (c?.kind !== "operation") return [];
  if (isChoice(c)) {
    const out: PlaceId[] = [];
    for (const member of choiceMembers(contract, c))
      if (member?.place !== undefined) out.push(member.place);
    return out;
  }
  // (its receiver, its arguments, then its named ones: a parse's or a conversion's default)
  const out = c.receiver === null ? [...c.arguments] : [c.receiver, ...c.arguments];
  if ("named" in c) for (const argument of c.named) out.push(argument.value);
  return out;
}

/** A value's class (`classOf`), its parts' known, before its text is interned (`classId`). */
function joinedClass(
  contract: Contract,
  value: PlaceId,
  exact: boolean,
  parts: readonly PlaceId[],
): KeptClass {
  const { program, definitions, values, lists, handlers, guards } = contract.pass;
  const read = contract.readClass(value, exact);
  if (read !== null)
    return { cls: read, mixed: 0, own: [contract.aliasWriter(value, exact)], parts };
  // #1196: a host global's read answers external data at every path, on either side, named by its own leaf (C9) and
  // marked where its guards mark it, so a value over it (a projection, a literal, a parse) is classed by its other parts
  if (program.occurrenceOf.has(value)) {
    if (!definitions.ingress.has(value)) return NO_KEPT_CLASS;
    const cls = keptParts(
      contract.work,
      "host",
      program.occurrenceOf.get(value)!,
      guards.guardedRead(value) ? "g" : "",
      guards.guardedBelowRead(value).join(" "),
    );
    return { cls, mixed: MIXED_LEAF, own: [], parts };
  }
  const memo = contract.valueClasses[exact ? 1 : 0]!;
  const of = parts.map((part) => memo.get(part)!);
  if (of.some(({ cls }) => cls === null)) return NO_KEPT_CLASS;
  const classes = of.map(({ cls }) => cls!);
  const projection = program.projOf.get(value);
  if (projection !== undefined) {
    if (projection.step === "iteration" || (exact && projection.node === null))
      return NO_KEPT_CLASS;
    const cls = keptParts(
      contract.work,
      "p",
      projection.step,
      classes[0]!,
      guards.guardedRead(value) ? "g" : "",
      guards.guardedBelowRead(value).join(" "),
    );
    return { cls, mixed: of[0]!.mixed, own: [], parts };
  }
  // (a call's result stands for its callee's stores, no role of its own)
  if (program.callOutOf.has(value)) {
    const call = program.opOf.get(value);
    if (call?.kind !== "call") return NO_KEPT_CLASS;
    const key = keyOf(program.functionOf(call.fn).result, []);
    const node = program.callOutOf.get(value) ?? null;
    if (!exact) return { cls: keptParts(contract.work, "call", key), mixed: 0, own: [], parts: [] };
    if (node === null) return NO_KEPT_CLASS;
    const signature = lists.readSignature(key, node);
    const after = handlers.afterSomeCreation(node) ? "h" : "";
    const cls = keptParts(contract.work, "call", key, signature, after);
    return { cls, mixed: 0, own: [], parts: [] };
  }
  if (program.hasOf.has(value)) return literalClass(contract, value, parts, of);
  const c = program.opOf.get(value);
  if (c === undefined || c.kind === "call" || (exact && program.exprAt(c.site) === null))
    return NO_KEPT_CLASS;
  let mixed = of.reduce((all, part) => all | part.mixed, 0);
  if (definitions.ingress.has(value)) mixed |= MIXED_LEAF;
  if (c.kind === "operation" && operatorOf(c) !== null) mixed |= MIXED_FAN;
  let cls: string;
  if (c.kind === "get" || c.kind === "fallback") {
    const proof = exact ? values.proofOf(value) : "";
    if (proof === null) return NO_KEPT_CLASS;
    cls = keptParts(contract.work, c.kind, ...classes, proof);
  } else if (c.kind === "load") {
    if (c.receiver !== null || contract.landsIn(value, []) !== null) return NO_KEPT_CLASS;
    const below = c.fallback === null ? "" : guardsBelow(contract, c.fallback);
    cls = keptParts(contract.work, c.key === null ? "load?" : "load", ...classes, below);
  } else if (c.kind === "operation" && isChoice(c)) {
    const options: string[] = [];
    let next = 0;
    for (const member of choiceMembers(contract, c)) {
      if (member === null) return NO_KEPT_CLASS;
      options.push(
        member.place === undefined
          ? contract.kept(`l${member.label}`)
          : contract.kept(`${member.object ? "o" : "c"}${classes[next++]!}`),
      );
    }
    // (its options joined first: a choice may hold more of them than one call takes arguments)
    cls = keptParts(contract.work, "choice", contract.joined(options, "|"));
  } else if (c.kind === "operation") {
    const { family, name } = c.contract;
    const fallback = defaultOf(c);
    const parses = family === "conversion" && conversionCategory(name)?.kind === "parses";
    if (parses && contract.landsIn(value, []) !== null) return NO_KEPT_CLASS;
    const below = parses && fallback !== undefined ? guardsBelow(contract, fallback) : "";
    const named = "named" in c ? c.named.map((argument) => argument.name).join(",") : "";
    const own = c.receiver === null ? "" : "r";
    // (its operands' classes joined first: an operation may take more of them than one call does)
    cls = keptParts(contract.work, family, name, own, named, contract.joined(classes, "|"), below);
  } else return NO_KEPT_CLASS;
  return { cls, mixed, own: [], parts };
}

/**
 * A choice's options as its answer reads them (`choiceItems`), per argument: a label by its kind, a choice object by
 * the value it selects, any other option by its value; `null` for a list's or a set's buttons, and for a choice object
 * without a selected key.
 */
export function choiceMembers(
  contract: Contract,
  c: Extract<ValueConstraint, { readonly kind: "operation" }>,
): readonly ({
  readonly label?: string;
  readonly place?: PlaceId;
  readonly object?: true;
} | null)[] {
  const evidence = "evidence" in c && c.evidence?.kind === "choice" ? c.evidence.options : [];
  const labels = choiceLabels(c);
  return c.arguments.map((argument, index) => {
    contract.pass.program.work.charge("invSteps");
    const label = labels[index];
    const content = evidence[index]?.content;
    if (content?.kind === "list" || content?.kind === "set") return null;
    if (label !== undefined) return { label: label ?? "" };
    if (content?.kind !== "object") return { place: argument };
    const selected = content.object === null ? null : (content.object.value ?? content.object.text);
    return selected === null ? null : { place: selected, object: true };
  });
}

/** A literal's class (`classOf`), its cells' known, in `classParts`' order. */
function literalClass(
  contract: Contract,
  literal: PlaceId,
  cells: readonly PlaceId[],
  of: readonly KeptClass[],
): KeptClass {
  const { program } = contract.pass;
  const index = contract.literalIndex(literal);
  const site = program.places[literal]?.site;
  if (heldBelow(contract, index.root).reference || !site) return NO_KEPT_CLASS;
  const parts: string[] = [program.cellOwner.get(literal)?.kind === "cell" ? "c" : ""];
  let mixed = 0;
  let next = 0;
  for (const [at, node] of pathOrder(contract, index)) {
    program.work.charge("structureSteps");
    parts.push(kindsPart(contract, at, node.terms));
    for (const [mark, entries] of [
      ["r", node.reads],
      ["o", node.others],
    ] as const)
      for (const entry of entries) {
        const part = of[next++]!;
        const read = "holder" in entry ? entry : null;
        // (a read of host data is mixed by its class: its leaves, unioned here, are what literals of it differ by)
        if (part.cls === null || (read !== null && !markFree(contract, read.holder)))
          return NO_KEPT_CLASS;
        parts.push(contract.kept(`${mark}${read?.guarded === true ? "g" : ""}${part.cls}`));
        mixed |= part.mixed;
      }
    for (const object of node.objects?.list ?? []) parts.push(namesPart(contract, object.names));
  }
  // (its objects' names give its absences: a class never counts the absences asked of it so far, #1392)
  parts.push(`empty:${emptyIds(contract, index)}`);
  return {
    cls: contract.internStructure(`lit(${contract.joined(parts, ";")})`),
    mixed,
    own: [{ kind: "literal", file: site.file, start: site.start, end: site.end }],
    parts: cells,
  };
}
