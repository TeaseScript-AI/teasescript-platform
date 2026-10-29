import type { PlaceId } from "../../graph.js";
import type { Admission } from "../admission.js";
import { withoutEmpty } from "../exact-path.js";
import { getProof } from "../values.js";
import type { Via } from "./model.js";

// The rules a decider reads of one operation and one value, shared by the stop scan (`scan.ts`) and the carriers'
// transfers (`transfers.ts`): whether an operation gives an operand, whether a value runs, what snapshot it reads.

/** Whether one operation gives the operand the walk took (`chosen`'s rule for a link), or `surely` gives it. */
export function chooses(
  admission: Admission,
  level: Pick<Via, "value" | "node" | "operand">,
  surely: boolean,
): boolean {
  const { program, values } = admission.pass;
  const c = program.opOf.get(level.value);
  const at = c === undefined ? level.node : (program.exprAt(c.site) ?? level.node);
  // (`otherwise` gives its own operand only where that may be a value, and its fallback only where the operand may
  // be null, an unknown either: F17a)
  if (c?.kind === "fallback") {
    const left = withoutEmpty(admission.run(values.valueItems(c.left, at, [])));
    const value = left.some((item) => item.tag !== "null");
    const absent = left.some((item) => item.tag === "null" || item.tag === "unknown");
    if (level.operand === c.left) return value && !(surely && absent);
    return level.operand !== c.right || (absent && !(surely && value));
  }
  if (c?.kind !== "get") return !surely;
  const { reached, only } = getProof(program, c, at);
  if (level.operand === c.receiver) return surely ? !reached : !only;
  return level.operand !== c.fallback || (surely ? only : reached);
}

/** Whether a value's own expression runs: its flow node is live (an operand an operation never selects is not). */
export function live(admission: Admission, value: PlaceId): boolean {
  const { program } = admission.pass;
  const site = program.places[value]?.site ?? null;
  const node = site === null ? null : program.exprAt(site);
  return node === null || program.live(node);
}

/** The snapshot a value reads (`Contract.readSnapshot`), or a call's by its identity (r4.15); `null` for any other. */
export function snapshotOf(admission: Admission, value: PlaceId): string | null {
  const { contract } = admission.pass;
  return (
    contract.readSnapshot(value) ??
    (contract.resultKey(value) === null ? null : `c${contract.identityOf(value).id}`)
  );
}
