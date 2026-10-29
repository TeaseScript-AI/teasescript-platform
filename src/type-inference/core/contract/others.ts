import type { PlaceId } from "../../graph.js";
import { keptParts } from "../budget.js";
import type { Contract } from "../contract.js";
import { firstWriter, type Writer } from "../items.js";
import type { ValueConstraint } from "../program.js";
import { sharing } from "../sharing.js";
import { boundOf, choiceMembers, NO_CLASS } from "./classes.js";
import { declaredBefore } from "./key-contract.js";
import { markFree } from "./levels.js";
import type {
  ChoiceGroup,
  OtherGroup,
  ReadClassGroup,
  ReadEntry,
  ValueClass,
  ValueEntry,
} from "./model.js";

// A literal's computed values and reads at a path as a gather reads them, a choice's options, a `+`'s repeat.

/**
 * TABLE r4.85: the members of a site its answer reads, by their role minima. Members of one class (`Contract.classOf`)
 * answer alike at every path apart from the writers of their roles (`classWriters`), each role's writer standing for
 * the kinds it gives, and a merged answer takes each kind's earliest writer: so per class the members whose writer is
 * earliest in some role, merged, answer as all of them, whatever order the writers come in. A member without a class,
 * or whose roles are not known, stands by itself. Per class in the order of its first member: the members read, each
 * once and in role order (the first member for a role no later one is earlier in), the others where the class is
 * mixed (`Contract.classMixed`: read where the read ones' answer holds a leaf or an operand's identity), and all.
 */
function roleMinima(
  members: readonly ValueClass[],
  charge: () => void,
): readonly {
  readonly read: readonly number[];
  readonly rest: readonly number[];
  readonly all: readonly number[];
  readonly mixed: number;
}[] {
  const classes: {
    readonly read: number[];
    readonly best: (Writer | null)[];
    readonly all: number[];
  }[] = [];
  const byClass = new Map<string, number>();
  for (const [index, { cls, writers }] of members.entries()) {
    charge();
    const at = cls === null || writers === null ? undefined : byClass.get(cls);
    if (at === undefined) {
      if (cls !== null && writers !== null) byClass.set(cls, classes.length);
      const roles = writers ?? [];
      classes.push({
        read: roles.length === 0 ? [index] : roles.map(() => index),
        best: [...roles],
        all: [index],
      });
      continue;
    }
    const into = classes[at]!;
    into.all.push(index);
    for (const [role, mine] of writers!.entries()) {
      charge();
      const best = into.best[role] ?? null;
      if (mine !== null && best !== null && firstWriter(best, mine) !== best) {
        into.best[role] = mine;
        into.read[role] = index;
      }
    }
  }
  return classes.map(({ read, all }) => {
    const chosen = new Set(read);
    const mixed = members[all[0]!]!.mixed;
    return {
      read: [...chosen],
      rest: mixed !== 0 ? all.filter((m) => !chosen.has(m)) : [],
      all,
      mixed,
    };
  });
}

/**
 * S6c (`LiteralIndex.others`, Astra's design review): a literal's computed values at a path as its answer reads them,
 * once per list and side: of values of one class (`classOf`) its role minima (`roleMinima`), the earliest cell writer
 * standing for its kinds (each value's kinds take its cell's writer, F28), and of a mixed class the others; any other
 * value by itself. In order, so the merged answer keeps its kinds' order; the count of the contributions (§3.4's
 * several elements) stays the list's.
 */
export function othersAt(
  contract: Contract,
  list: readonly ValueEntry[] | undefined,
  exact: boolean,
): readonly OtherGroup[] {
  if (list === undefined) return [];
  const memo = contract.otherGroups[exact ? 1 : 0]!;
  const known = memo.get(list);
  if (known !== undefined) return known;
  const { definitions, program } = contract.pass;
  const cellWriter = (entry: ValueEntry): Writer | null =>
    entry.g === null ? null : definitions.writerOf(entry.g);
  const members: ValueClass[] = [];
  for (const entry of list) {
    program.work.charge("invSteps");
    const cls = sharing() ? contract.classOf(entry.value, exact) : null;
    // (on the contract side a value without its cell's writer apart from one with it)
    const key =
      cls === null
        ? null
        : keptParts(contract.work, cls, exact || cellWriter(entry) !== null ? "w" : "");
    members.push({
      cls: key,
      writers: key === null ? null : contract.classWriters(entry.value, exact),
      mixed: key === null ? 0 : contract.classMixed(entry.value, exact),
    });
  }
  const groups: OtherGroup[] = [];
  const below: (OtherGroup | null)[] = [];
  let summarised = false;
  const charge = (): void => program.work.charge("invSteps");
  for (const { read, rest, all, mixed } of roleMinima(members, charge)) {
    let writer: Writer | null = null;
    // (F19's loads of a computed key with no receiver, whatever their defaults' class, which no read below their root
    // consults, and wherever they land: the loads of one path land alike; with the sharing off every value is read at
    // each path)
    let loads = sharing();
    for (const member of all) {
      writer = firstWriter(writer, cellWriter(list[member]!));
      const c = program.opOf.get(list[member]!.value);
      loads &&= c?.kind === "load" && c.key === null && c.receiver === null;
    }
    contract.keep(2 + read.length + rest.length);
    const group = {
      read: read.map((member) => list[member]!),
      rest: rest.map((member) => list[member]!),
      writer,
      mixed,
      loads,
    };
    groups.push(group);
    if (!loads) below.push(group);
    else if (!summarised) below.push(null);
    summarised ||= loads;
  }
  memo.set(list, groups);
  if (summarised) {
    contract.keep(1 + below.length);
    contract.othersBelowOf.set(groups, below);
  }
  return groups;
}

/**
 * #1313: a literal's reads at a path as a gather reads them (`gatherAt`), once per list and gather: of the reads of
 * bound bindings of one class (`boundOf`, `boundClass`), each unguarded or each guarded, none holding a mark, none
 * an ingress, its role minima (`roleMinima`), and of a mixed class the others (`groupItems`), with the contract's
 * earliest cell writer apart from none (`othersAt`'s), the value side's by where each read's declaration stands (its
 * contract read's P3 condition, `declaredBefore`); any other read by itself. In order, so a list of k bindings of
 * loads of one default, read at k properties, reads one binding at each.
 */
export function readGroupsAt(
  contract: Contract,
  list: readonly ReadEntry[] | undefined,
  value: boolean,
): readonly ReadClassGroup[] {
  if (list === undefined) return [];
  const memo = contract.readClassGroups[value ? 1 : 0]!;
  const known = memo.get(list);
  if (known !== undefined) return known;
  const { definitions, program } = contract.pass;
  const cellWriter = (entry: ReadEntry): Writer | null =>
    entry.g === null ? null : definitions.writerOf(entry.g);
  const members: ValueClass[] = [];
  for (const entry of list) {
    program.work.charge("invSteps");
    const read = entry.value;
    const bound =
      sharing() &&
      entry.ingress === undefined &&
      markFree(contract, entry.holder) &&
      boundOf(contract, read, value) !== null
        ? contract.boundClass(read, value)
        : NO_CLASS;
    // (where a read stands decides its contract read's certainty on the value side, its cell's writer on the contract)
    const node = value ? (program.occNode.get(read) ?? null) : null;
    const stands =
      node === null
        ? ""
        : `${program.live(node) ? "l" : ""}${declaredBefore(contract, program.occurrenceOf.get(read)!, node) ? "d" : ""}`;
    const key =
      bound.cls === null || (value && node === null)
        ? null
        : keptParts(
            contract.work,
            bound.cls,
            entry.guarded ? "g" : "",
            value ? stands : cellWriter(entry) !== null ? "w" : "",
          );
    members.push({
      cls: key,
      writers: key === null ? null : bound.writers,
      mixed: key === null ? 0 : bound.mixed,
    });
  }
  const groups: ReadClassGroup[] = [];
  for (const { read, rest, all, mixed } of roleMinima(members, () =>
    program.work.charge("invSteps"),
  )) {
    let writer: Writer | null = null;
    for (const member of all) writer = firstWriter(writer, cellWriter(list[member]!));
    contract.keep(2 + read.length + rest.length);
    groups.push({
      read: read.map((member) => list[member]!),
      rest: rest.map((member) => list[member]!),
      writer,
      mixed,
    });
  }
  memo.set(list, groups);
  return groups;
}

/**
 * S6c: the options of a choice its answer reads, by their index, once per choice and side: of options that answer
 * alike at every path apart from their roles' writers (a label of one kind; a choice object's selected value, or any
 * other option, of one class, `classOf`) the role minima (`roleMinima`), and of a mixed class the others, so a choice
 * of k options of one source read at k fields reads it once per field; a list's or a set's buttons by themselves.
 */
export function choiceOptions(
  contract: Contract,
  c: Extract<ValueConstraint, { readonly kind: "operation" }>,
  exact: boolean,
): readonly ChoiceGroup[] {
  const memo = contract.choiceOptionsBySide[exact ? 1 : 0]!;
  const known = memo.get(c.result);
  if (known !== undefined) return known;
  const { program } = contract.pass;
  const members: ValueClass[] = [];
  for (const member of choiceMembers(contract, c)) {
    let classed = NO_CLASS;
    if (sharing() && member !== null) {
      const cls = member.place === undefined ? null : contract.classOf(member.place, exact);
      if (member.place === undefined)
        classed = { cls: keptParts(contract.work, "l", member.label!), writers: [], mixed: 0 };
      else if (cls !== null)
        classed = {
          cls: keptParts(contract.work, member.object ? "o" : "c", cls),
          writers: contract.classWriters(member.place, exact),
          mixed: contract.classMixed(member.place, exact),
        };
    }
    members.push(classed);
  }
  const options: ChoiceGroup[] = [];
  const charge = (): void => program.work.charge("invSteps");
  for (const { read, rest, mixed } of roleMinima(members, charge)) {
    contract.keep(2 + read.length + rest.length);
    options.push({ read, rest, mixed });
  }
  memo.set(c.result, options);
  return options;
}

/**
 * TABLE r4.87: the `+` whose answer below its root a `+` over a run of terms gives (`plusElements`): the value itself,
 * or, where it stands fourth or later in a run, the run's third. In a run each `+`'s left operand is the `+` before
 * it, and its right operand is of one class with that one's (`classOf`, no mixed one), its roles' writers no earlier:
 * each answers below its root as the one before with that term's elements merged in once more, and the merge and the
 * `member` weakening settle on the second (the first `+` of a run may hold one operand's elements unweakened); the
 * earliest writer stands for each kind. So a sum of k terms of one source read at k fields reads at most three `+`
 * per field, never the sum. Once per value and side, on an explicit walk.
 */
export function plusRepeatOf(contract: Contract, value: PlaceId, exact: boolean): PlaceId {
  if (!sharing()) return value;
  const memo = contract.plusRuns[exact ? 1 : 0]!;
  const pending: PlaceId[] = [];
  let before: { readonly third: PlaceId | null; readonly at: number } | null = null;
  for (let sum: PlaceId | null = value; sum !== null; sum = plusBefore(contract, sum, exact)) {
    const known = memo.get(sum);
    if (known !== undefined) {
      before = known;
      break;
    }
    pending.push(sum);
  }
  for (let index = pending.length - 1; index >= 0; index -= 1) {
    const sum = pending[index]!;
    const at = before === null ? 1 : before.at + 1;
    contract.keep(2);
    before = { third: at === 3 ? sum : at > 3 ? before!.third : null, at };
    memo.set(sum, before);
  }
  const run = memo.get(value)!;
  return run.at > 3 ? run.third! : value;
}

/** The `+` a `+` repeats (`plusRepeatOf`), or `null`. */
function plusBefore(contract: Contract, value: PlaceId, exact: boolean): PlaceId | null {
  const { program } = contract.pass;
  program.work.charge("invSteps");
  const plus = (place: PlaceId): readonly PlaceId[] | null => {
    const c = program.opOf.get(place);
    return c?.kind === "operation" &&
      c.contract.family === "operator" &&
      c.contract.name === "+" &&
      c.arguments.length === 2 &&
      (!exact || program.exprAt(c.site) !== null)
      ? c.arguments
      : null;
  };
  const own = plus(value);
  const left = own === null ? null : plus(own[0]!);
  if (own === null || left === null) return null;
  const cls = contract.classOf(own[1]!, exact);
  if (
    cls === null ||
    cls !== contract.classOf(left[1]!, exact) ||
    contract.classMixed(own[1]!, exact) !== 0
  )
    return null;
  const [mine, earlier] = [
    contract.classWriters(own[1]!, exact),
    contract.classWriters(left[1]!, exact),
  ];
  if (mine === null || earlier === null) return null;
  for (const [role, writer] of mine.entries()) {
    const first = earlier[role] ?? null;
    if (writer !== null && first !== null && firstWriter(first, writer) !== first) return null;
  }
  return own[0]!;
}
