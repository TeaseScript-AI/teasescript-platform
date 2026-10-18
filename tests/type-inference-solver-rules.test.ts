import assert from "node:assert/strict";
import test from "node:test";

import type { ValueKind } from "../src/value-kinds.js";
import { Cells, type CellId, type Contribution } from "../src/type-inference/solver/cells.js";
import { interpret, type Member } from "../src/type-inference/solver/interpret.js";
import { CELL_RULES, type RuleItem } from "../src/type-inference/solver/rules.js";
import { TypeTable } from "../src/type-inference/solver/types.js";

/**
 * The cell table (O4 stage 3a, work note §3.2): every row of `rules.ts` built as a cell with its part cells and
 * interpreted; the view's kind, exported forms, families, optionality and held must be the row's.
 */

function memberKey(member: Member): string {
  return member.kind === "type"
    ? `t${member.type}`
    : member.kind === "collection"
      ? `${member.ctor}${member.element}`
      : `o${[...member.props].map(([name, cell]) => `${name}:${cell}`).join(",")}`;
}

test("every row of the cell table interprets as the row says", () => {
  for (const rule of CELL_RULES) {
    const table = new TypeTable();
    const cells = new Cells(table, 1);
    const partCells = new Map<string, CellId>();
    const partOf = (name: string): CellId => {
      let cell = partCells.get(name);
      if (cell === undefined) {
        cell = cells.derived(0, name);
        partCells.set(name, cell);
      }
      return cell;
    };
    const contribution = (item: RuleItem): Contribution => {
      const base = {
        tag: item.tag,
        pos: [item.pos, item.pos] as const,
        decl: item.decl,
        group: item.group,
        why: item.why,
      };
      if (item.ctor === "object")
        return {
          ...base,
          ctor: "object",
          parts: {
            props: new Map(
              Object.entries(item.props ?? {}).map(([name, part]) => [name, partOf(part)]),
            ),
            open: false,
          },
        };
      if (item.ctor !== undefined)
        return { ...base, ctor: item.ctor, parts: { element: partOf(item.part!) } };
      if (item.type === undefined) return base;
      // EVIDENCE: fixture: the rows name registry kinds and `null`, which the term interns as atoms.
      const name = item.type as ValueKind;
      return { ...base, type: table.internTerm({ kind: "atom", name }) };
    };
    const forms = new Map<string, string>();
    for (const [part, items] of Object.entries(rule.parts ?? {}))
      for (const item of items) cells.add(partOf(part), contribution(item));
    for (const item of rule.items) {
      const c = contribution(item);
      cells.add(0, c);
      const member: Member =
        c.ctor === "object"
          ? { kind: "object", props: c.parts!.props!, open: false }
          : c.ctor !== undefined
            ? { kind: "collection", ctor: c.ctor, element: c.parts!.element! }
            : { kind: "type", type: c.type! };
      forms.set(item.name, memberKey(member));
    }
    const view = interpret(cells, 0);
    assert.equal(view.kind, rule.expect.kind, `${rule.name}: kind`);
    assert.deepEqual(
      [...new Set(view.members.map(memberKey))].sort(),
      [...new Set(rule.expect.members.map((name) => forms.get(name)!))].sort(),
      `${rule.name}: exported forms`,
    );
    assert.deepEqual(view.families, rule.expect.families ?? [], `${rule.name}: families`);
    assert.equal(view.optional, rule.expect.optional ?? false, `${rule.name}: optional`);
    assert.equal(view.held, rule.expect.held ?? false, `${rule.name}: held`);
  }
});
