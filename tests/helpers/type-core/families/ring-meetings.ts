import { type WorkFamily, rows, lines, fields, main } from "./builders.js";

/**
 * A merge place's k dormant meetings in a record that also holds a fitting whole-copy ring (#1338): `exact` and
 * `fraction` meet at each of k properties in `container`, and k aliases of it each store one property and stand beside
 * it in a list or a place. A containment over a node holding a ring owes the meetings below the ring, and only where
 * the two differ below the rest. The ring stands at a property of the record (`side`) or one deeper (`side.inner`);
 * the k properties stand at the record's top or below `data`. Each at size k, linear.
 */
export const RING_MEETING_FAMILIES: readonly WorkFamily[] = (
  [
    ["literal", "side", "", "a list with it, the ring at a property"],
    ["place", "side", "", "a place with it, the ring at a property"],
    ["literal", "nested", "", "a list with it, the ring one property deeper"],
    ["place", "side", "data", "a place with it, the meetings below `data`"],
  ] as const
).map(([form, ring, under, where]): WorkFamily => ({
  name: `ring-dormant-meetings-${form}${ring === "nested" ? "-nested-ring" : ""}${under === "" ? "" : "-under-data"}`,
  measures: `a merge place's k meetings beside a whole-copy ring, k copies each storing its own, in ${where}`,
  program: (k) => {
    const side = ring === "nested" ? "side: {inner: r0}" : "side: r0";
    const record = (value: string): string =>
      under === ""
        ? `{${side}, ${fields(k, () => value)}}`
        : `{${side}, ${under}: {${fields(k, () => value)}}}`;
    const at = under === "" ? "" : `${under}.`;
    return main(
      lines(
        "let typed: integer = 17",
        "let r0 = {v: typed}",
        "let r1 = {v: typed}",
        "r0 = r1",
        "r1 = r0",
        `let exact = ${record("typed")}`,
        `let fraction = ${record("1.5")}`,
        "let container = fraction",
        "container = exact",
        rows(k, (i) =>
          lines(
            `let alias${i} = container`,
            `alias${i}.${at}f${i} = typed`,
            form === "literal"
              ? `let final${i} = [container, alias${i}]`
              : lines(`let final${i} = container`, `final${i} = alias${i}`),
          ),
        ),
        "exit",
      ),
    );
  },
}));
