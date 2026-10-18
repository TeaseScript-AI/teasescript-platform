import { typeKey } from "../../src/storage-types.js";
import type { CellId } from "../../src/type-inference/solver/cells.js";
import type { Member } from "../../src/type-inference/solver/interpret.js";
import type { Solution } from "../../src/type-inference/solver/solve.js";

/**
 * The text of a solved cell as the reference model prints it (`model/solver-model.mjs` of the research folder), so
 * that the solver's regression fixture compares as data: `never`, `unknown`, `(?|null)`, a bound, the working members
 * (`(a|b)`, with `|null` inside when optional, `!` when held), or `CONFLICT{families}~working`.
 */
function cellText(solution: Solution, cell: CellId, depth = 0): string {
  const view = solution.view(cell);
  const texts = (members: readonly Member[]): string[] =>
    [...new Set(members.map((member) => memberText(solution, member, depth)))].sort();
  switch (view.kind) {
    case "never":
      return "never";
    case "unknown":
      return "unknown";
    case "nullOnly":
      return "(?|null)";
    case "bound": {
      const bound = texts(view.members);
      return `${bound.length === 1 ? bound[0]! : `(${bound.join("|")})`}${view.held ? "!" : ""}`;
    }
    case "conflict": {
      const working = texts(view.members);
      return `CONFLICT{${view.families.join(",")}}~${working.join("|")}${view.held ? "!" : ""}${view.optional ? "|null" : ""}`;
    }
    case "known": {
      const members = texts(view.members);
      const body = members.length === 1 ? members[0]! : `(${members.join("|")})`;
      return `${view.optional ? `(${members.join("|")}|null)` : body}${view.held ? "!" : ""}`;
    }
  }
}

function memberText(solution: Solution, member: Member, depth: number): string {
  if (member.kind === "type") return typeKey(solution.table.toStatic(member.type), true, true);
  if (depth > 3) return "…";
  if (member.kind === "collection")
    return `${member.ctor}<${cellText(solution, member.element, depth + 1)}>`;
  return `{${[...member.props]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([name, cell]) => `${JSON.stringify(name)}:${cellText(solution, cell, depth + 1)}`)
    .join(",")}}`;
}

/** The summary the model prints for a case: every author binding and every function result. */
export function solutionSummary(solution: Solution): string {
  const bindings = solution.graph.places
    .filter((place) => place.kind.kind === "binding" && place.kind.declared !== "host")
    .map(
      (place) =>
        `${place.kind.kind === "binding" ? place.kind.name : ""}=${cellText(solution, place.id)}`,
    );
  const functions = solution.graph.functions.map(
    (fn) => `${fn.name}()=${cellText(solution, fn.result)}`,
  );
  return [...bindings, ...functions].join(" ");
}
