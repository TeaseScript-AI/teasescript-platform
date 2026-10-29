import { unwrap } from "../../../expression-children.js";
import type { PlaceId } from "../../graph.js";
import type { Admission } from "../admission.js";
import type { CorePass } from "../answers.js";
import { joinSteps, keepText, keptParts, keptSplit, keptText, pathText } from "../budget.js";
import {
  keptKey,
  keptKeyBelow,
  keyBelow,
  prefixesOf,
  recordKey,
  type Definition,
  type Key,
} from "../definitions.js";
import type { FlowNode } from "../flow-graph.js";
import { dictList, measuresLength } from "../method-categories.js";
import { stepName } from "../program.js";
import { sharing } from "../sharing.js";
import type { Alias, ChainEnd } from "./model.js";
import { permittedAt } from "./permitted.js";
import { writtenSource } from "./walk.js";

// Alias classes (S6-CARRIERS §4.1): the class of a whole store or an add, by its stable source path and chain end.

/**
 * For the tests: while `withoutChains` runs, no chain of copies is resolved (§4.1), so a class is a read's own; the
 * published records, their F28 writers included, are the same either way (the oracle sets a link's writer aside).
 */
let chainsOff = false;

export function withoutChains<T>(callback: () => T): T {
  const before = chainsOff;
  chainsOff = true;
  try {
    return callback();
  } finally {
    chainsOff = before;
  }
}

/** The path below an add's added value for a path below its list (an `addAll`'s value stands for the list's elements). */
export function addRest(d: Definition, rest: readonly string[]): readonly string[] {
  return d.how === "elements" ? rest : rest.slice(1);
}

/** The key an alias's read stands for at `rest` below its store; `null` beside or above its cell, where no read is. */
export function aliasKeyAt(alias: Alias, rest: readonly string[]): Key | null {
  if (rest.length < alias.at.length || alias.at.some((step, index) => rest[index] !== step))
    return null;
  return keyBelow(alias.source, rest.slice(alias.at.length));
}

/**
 * §8, S6-CARRIERS §4.1, §4.5: a key's whole stores, or its adds, by alias class (`aliasKey`), once per pass, in the
 * key's own list (`wholeOf`): their earliest as the representative, the later ones its members (`members`); a scan
 * or a check reads the representative, and a member only where it owes something.
 */
export function grouped(admission: Admission, list: readonly Definition[]): Definition[] {
  const out: Definition[] = [];
  const first = new Map<string, Definition>();
  for (const d of list) {
    admission.pass.program.work.charge("indexSteps");
    const key = aliasKey(admission, d);
    const representative = key === null ? undefined : first.get(key);
    if (representative === undefined) {
      if (key !== null) {
        keepText(admission.work, key.length);
        first.set(key, d);
      }
      out.push(d);
      continue;
    }
    admission.representative.set(d, representative);
    const members = admission.members.get(representative);
    if (members === undefined) admission.members.set(representative, [d]);
    else members.push(d);
  }
  return out;
}

/**
 * S6-CARRIERS §4.1: the class a whole store's value, or an add's added value (§4.5: its class by its mode, an element
 * or an `addAll`'s elements), is an alias in: where it is a stable source path (`stablePath`), or a literal whose one
 * read cell is one and whose other cells are terms, at that cell's path, the literal's identity beside it (r4.17: no
 * guard in it). The path, with the read's exact-path signature (`aliasSignature`), the handlers' facts at its node and
 * the written type A4 decides the copy by: stores of one class bring equal answers below the path, their own guards
 * apart (a literal's only below its cell, `covers`); `null` for any other store (an own entry).
 */
function aliasKey(admission: Admission, d: Definition): string | null {
  const { program, lists, handlers, contract } = admission.pass;
  if ((d.kind !== "whole" && d.kind !== "add") || d.value === undefined || !sharing()) return null;
  program.work.charge("aliasSteps");
  let alias: Alias | null = null;
  let shape = "";
  let written = "";
  const whole = stablePath(admission, d.value, d.node);
  if (whole !== null) {
    alias = { source: whole.source, read: whole.read, at: [], value: d.value };
    written = whole.written;
  } else if (program.hasOf.has(d.value)) {
    // (one read, one guard: equal reads of one source in one literal are one entry, alike guarded or not; and the
    // read the only contribution at and below its path, no term, object or empty collection of the literal's own
    // there beside it, Codex r22 F5, nor an object on the way to it without its next step, whose `missing` stands
    // there too, Codex r23 F2: `Contract.loneRead`)
    const cell = contract.loneRead(d.value);
    if (cell === null) return null;
    const path = pathText(cell.steps);
    const read = stablePath(admission, cell.value, d.node);
    if (read === null) return null;
    alias = {
      source: read.source,
      read: read.read,
      at: keptSplit(admission.work, path),
      value: cell.value,
    };
    written = read.written;
    shape = `${contract.identityOf(d.value).id}@${path}`;
  }
  if (alias === null) return null;
  admission.aliases.set(d, alias);
  // (§4.1's chains: the class of the read its clean copy's source is, to the chain's end; a member whose own source a
  // test touches keeps that source in its class, so one key's tests guard each class's members, §4.3)
  const end = chainEnd(admission, alias.source, alias.read);
  if (end !== null) alias.chained = true;
  const read = end ?? { ...alias, written };
  return [
    // (an add's class stands below its added value, element by element or as its elements, §4.5)
    d.kind === "add" ? `add:${d.how === "elements" ? "elements" : "element"}` : "",
    shape,
    end === null || untested(admission, alias.source) ? "" : alias.source,
    read.source,
    read.written,
    lists.aliasSignature(read.source, read.read),
    handlers.afterSomeCreation(read.read) ? "h" : "",
    // (the member's own copied binding's written type at its read, A4's decider, whatever its chain resolves to:
    // `let b: integer[] = raw` is no `let a = raw`, TABLE r4.72)
    writtenDomainKey(admission, alias),
    // (what its read's narrowing makes of its answer, S10 part 2b)
    admission.pass.values.narrowingMark(alias.value),
  ].join("|");
}

/**
 * The written type an alias's read copies at its path (A4: a copy of a written binding is decided by it), as the class
 * key holds it: the name of the type's spelling, or the unwritten place whose own decision it copies with the path
 * into it (`inheritedAt`), `null` where the copied binding has none; the member's own, never its chain's end's
 * (TABLE r4.72, Astra r5 B1).
 */
function writtenDomainKey(admission: Admission, alias: Alias): string {
  const written = writtenSource(admission, alias.value, []);
  if (written === null) return "null";
  if (written.from !== null)
    return `inherits ${written.from} ${keptText(admission.work, written.strip)}`;
  // (by its spelling's interned name, spelled once per written type and path: k copies of one long written type keep
  // k short names, never k spellings, #1255)
  let byPath = admission.writtenNames.get(written.term!);
  if (byPath === undefined) admission.writtenNames.set(written.term!, (byPath = new Map()));
  const path = keptText(admission.work, written.strip);
  let name = byPath.get(path);
  if (name === undefined) {
    const spelling = JSON.stringify(permittedAt(written.term!, written.strip));
    name = admission.spellings.get(spelling);
    if (name === undefined) {
      keepText(admission.work, spelling.length);
      name = `w${admission.spellings.size}`;
      admission.spellings.set(spelling, name);
    }
    byPath.set(path, name);
  }
  return name;
}

/**
 * §4.1's identity and chains: where a read's exact path is clean (X1–X7 pass: its reaching definition reaches every
 * path below it, with no event between) and that definition's value is itself a stable source path, read where no
 * test of its keys holds it, the read stands for that read, its rest after it; followed to the chain's end, once per
 * read and pass, each link charged once. `null` where the read is its own end.
 */
function chainEnd(admission: Admission, source: Key, read: FlowNode): ChainEnd | null {
  if (chainsOff) return null;
  const first = keptParts(admission.work, source, read.id);
  const known = admission.chains.get(first);
  if (known !== undefined) return known;
  const { program, exact, guards } = admission.pass;
  const links = new Set<string>([first]);
  let end: ChainEnd | null = null;
  let current = { source, read };
  for (;;) {
    program.work.charge("aliasSteps");
    const answer = exact.exactPath(current.source, current.read);
    if ("fail" in answer || answer.def.kind !== "whole" || answer.def.value === undefined) break;
    const value = answer.def.value;
    const next = stablePath(admission, value, answer.def.node);
    if (next === null || guards.guardedRead(value) || guards.guardedBelowRead(value).length > 0)
      break;
    current = { source: keptKeyBelow(admission.work, next.source, answer.rest), read: next.read };
    end = {
      ...current,
      written: keptText(
        admission.work,
        joinSteps([next.written], answer.rest).filter((x) => x !== ""),
      ),
    };
    const key = keptParts(admission.work, current.source, current.read.id);
    const known = admission.chains.get(key);
    if (known !== undefined) {
      end = known ?? end;
      break;
    }
    // (a cycle of copies ends where it closes)
    if (links.has(key)) break;
    links.add(key);
  }
  for (const key of links) admission.chains.set(key, end);
  return end;
}

/** Whether no test touches a source key: none of it, of a prefix of it, or of a key below it (§3.2). */
function untested(admission: Admission, source: Key): boolean {
  const { guards, program } = admission.pass;
  const key = recordKey(source);
  if (guards.belowTested.has(key)) return false;
  for (const each of [key, ...prefixesOf(key)]) {
    program.work.charge("aliasSteps");
    if (tested(guards, each)) return false;
  }
  return true;
}

/**
 * Whether a class answers as one at `rest` below its stores (§4.1): a copy's everywhere, a literal's below its alias
 * cell only (beside or above it each literal's own terms stand, with their own writers).
 */
export function covers(
  admission: Admission,
  representative: Definition,
  rest: readonly string[],
): boolean {
  const at = admission.aliases.get(representative)?.at ?? [];
  return rest.length >= at.length && at.every((step, index) => rest[index] === step);
}

/**
 * §4.1's stable source path a value reads: a binding (no host global) and property steps or literal indexes, the node
 * it is read at, and the path as written (distinct literal indexes are distinct paths, one key's `element`).
 */
function stablePath(
  admission: Admission,
  value: PlaceId,
  node: FlowNode,
): { readonly source: Key; readonly read: FlowNode; readonly written: string } | null {
  const { program } = admission.pass;
  const steps: string[] = [];
  const written: string[] = [];
  let at = value;
  let reading = node;
  for (let projection = program.projOf.get(at); projection !== undefined;) {
    program.work.charge("aliasSteps");
    const index = projection.step === "index" ? literalIndex(projection.node) : null;
    if (!propertyOnly(projection.step) && index === null) return null;
    steps.push(stepName(projection.step));
    written.push(index === null ? stepName(projection.step) : `[${index}]`);
    reading = projection.node ?? reading;
    at = projection.owner;
    projection = program.projOf.get(at);
  }
  const binding = program.occurrenceOf.get(at);
  if (binding === undefined || program.isHost(binding)) return null;
  return {
    source: keptKey(admission.work, binding, steps.reverse()),
    read: program.occNode.get(at) ?? reading,
    written: keptText(admission.work, written.reverse()),
  };
}

/** Whether a test of exactly `key` guards a branch or an operand region anywhere (§3.2). */
export function tested(guards: CorePass["guards"], key: Key): boolean {
  return guards.branchCallables(key) !== undefined || guards.operandCallables(key) !== undefined;
}

/** The integer literal an index projection's expression selects by (`root.items[0]`), else `null`. */
function literalIndex(node: FlowNode | null): string | null {
  const expression = node?.expression;
  if (expression?.kind !== "indexExpression") return null;
  const index = unwrap(expression.index);
  return index.kind === "numberLiteral" && index.numericType === "integer" ? index.raw : null;
}

/** Whether a projection's step is a plain property step, a stable source path's (S6-CARRIERS §4.1). */
function propertyOnly(step: string): boolean {
  return (
    step !== "iteration" &&
    step !== "index" &&
    step !== "entry" &&
    stepName(step) === step &&
    !measuresLength(step) &&
    dictList(step) === undefined
  );
}
