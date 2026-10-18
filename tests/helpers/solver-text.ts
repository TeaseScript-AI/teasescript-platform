import { typeKey } from "../../src/storage-types.js";
import type { CellId } from "../../src/type-inference/solver/cells.js";
import type { Member } from "../../src/type-inference/solver/interpret.js";
import type { Solution } from "../../src/type-inference/solver/solve.js";

/**
 * The text of a solved cell as the reference model prints it (`model/solver-model.mjs` of the research folder), so
 * that the solver's regression fixture compares as data: `never`, `unknown`, `(?|null)`, a bound, the working members
 * (`(a|b)`, with `|null` inside when optional, `!` when held), or `CONFLICT{families}~working`.
 */
function cellText(solution: Solution, cell: CellId, path: ReadonlySet<CellId> = new Set()): string {
  return groupText(solution, [cell], path);
}

/** The text of several part cells read together: a merged property or element (O1). */
function groupText(
  solution: Solution,
  group: readonly CellId[],
  path: ReadonlySet<CellId>,
): string {
  const items = group.flatMap((cell) => solution.cells.items(cell));
  if (items.length > 0 && items.every((item) => item.tag === "e")) return "never";
  const view = solution.viewOf(group);
  const inner = new Set([...path, ...group]);
  // the view's members as they are: the interpretation already drops a witness collection over an empty part beside
  // another member of its constructor, and a permitted or bound member stays its own (r5-S1, Sol r5-S2)
  const texts = (members: readonly Member[]): string[] =>
    [...new Set(members.map((member) => memberText(solution, member, inner)))].sort();
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

/** A structural cycle (a part on the way back to its owner) renders as the legacy's back-edge widening, `?`. */
function memberText(solution: Solution, member: Member, path: ReadonlySet<CellId>): string {
  if (member.kind === "type") return typeKey(solution.table.toStatic(member.type), true, true);
  const onPath = (group: readonly CellId[]): boolean => group.some((cell) => path.has(cell));
  if (member.kind === "collection")
    return `${member.ctor}<${onPath(member.element) ? "?" : groupText(solution, member.element, path)}>`;
  if (member.open) return "object";
  return `{${[...member.props]
    .filter(
      ([, group]) =>
        !group.every((cell) => solution.cells.items(cell).every((item) => item.tag === "e")),
    )
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(
      ([name, group]) =>
        `${JSON.stringify(name)}:${onPath(group) ? "?" : groupText(solution, group, path)}`,
    )
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
