import type { SourceSite } from "../../graph.js";
import type { Consumers } from "../consumers.js";
import { makeItem, REASON } from "../items.js";
import { siteKey } from "../program.js";
import { BOOLEAN, TEXT } from "./kinds.js";
import { indexProjection } from "./names.js";
import { consume, indexUse, integerOnly } from "./operands.js";
import { nullWarning, obligation, warning } from "./warnings.js";

// The graph's uses (counts, indexes, conditions, dict keys: C2, C3, C12), and every access to a speaker's field (F19a).

/** The counts, indexes, conditions and dict keys of the graph (C2, C3, C12). */
export function uses(walk: Consumers): void {
  const { program } = walk.pass;
  const flow = program.flow;
  const uses = walk.order([
    ...flow.indexUses.map((use) => ({ use, what: "index" })),
    ...flow.countUses.map((use) => ({ use, what: "repeat count" })),
    ...flow.conditionUses.map((use) => ({ use, what: "condition" })),
    ...flow.keyUses.map((use) => ({ use, what: "dict key" })),
  ]);
  walk.enter(1);
  for (const { use, what } of uses) {
    if (!walk.runs({ file: use.file, start: use.span.start.offset, end: use.span.end.offset }))
      continue;
    const operandSite: SourceSite = {
      file: use.file,
      start: use.operand.span.start.offset,
      end: use.operand.span.end.offset,
    };
    const node = program.exprAt(operandSite);
    if (node === null) continue;
    walk.reading = node;
    const place = program.placeBySite.get(siteKey(operandSite));
    const site: SourceSite = {
      file: use.file,
      start: use.span.start.offset,
      end: use.span.end.offset,
    };
    // never silent: an operand the core has no place for keeps its check
    if (place === undefined) {
      program.work.charge("checks");
      if (what === "condition" || what === "dict key") continue;
      warning(
        walk,
        "integer-use",
        site,
        makeItem("unknown", null, { reasons: REASON.opaque, context: "unmodelled", cert: "pos" }),
        obligation(
          "integer-check",
          site,
          program.textAt(operandSite),
          ["integer"],
          `check that the ${what} is a whole number when it runs`,
        ),
        { rule: "count", use: what === "index" ? "index" : "repeat" },
        [],
      );
      continue;
    }
    if (what === "condition")
      consume(
        walk,
        place,
        node,
        site,
        BOOLEAN,
        "a condition",
        { rule: "boolean", operator: null },
        ["boolean"],
      );
    else if (what === "dict key")
      consume(walk, place, node, site, TEXT, "a dict key", { rule: "key" }, ["string"]);
    else if (what === "index") {
      const projection = indexProjection(walk, use.span, use.file);
      if (projection !== undefined) indexUse(walk, projection, place, node, site, what);
      else integerOnly(walk, place, node, site, what, "index");
    } else integerOnly(walk, place, node, site, what, "repeat");
  }
}

/** F19a: every access to a speaker's field by its name asks its member; a declaration's start values are not accesses. */
export function speakers(walk: Consumers): void {
  const { program } = walk.pass;
  const speakers = program.constraints
    .filter((c) => c.kind === "has" && c.type.kind === "atom" && c.type.name === "speaker")
    .map((c) => c.site)
    .sort((a, b) => a.file - b.file || a.start - b.start);
  const accesses = program.constraints.filter(
    (c) => c.kind === "speakerRead" || (c.kind === "speakerStore" && c.role !== "start value"),
  );
  walk.enter(3);
  for (const c of walk.order(accesses)) {
    if (c.kind !== "speakerRead" && c.kind !== "speakerStore") continue;
    if (!walk.runs(c.site)) continue;
    program.work.charge("checks");
    // a store's receiver: the nearest speaker site before it in its file, by binary search
    let low = 0;
    let high = speakers.length;
    while (low < high) {
      const middle = (low + high) >> 1;
      program.work.charge("eventSteps");
      const found = speakers[middle]!;
      if (found.file < c.site.file || (found.file === c.site.file && found.start < c.site.start))
        low = middle + 1;
      else high = middle;
    }
    const before = low > 0 && speakers[low - 1]!.file === c.site.file ? speakers[low - 1]! : null;
    const target = c.kind === "speakerStore" ? program.effectNode(c.site)?.statement : undefined;
    const site =
      target?.kind === "assignmentStatement"
        ? {
            file: c.site.file,
            start: target.target.span.start.offset,
            end: target.target.span.end.offset,
          }
        : c.kind === "speakerRead"
          ? c.site
          : (before ?? c.site);
    const speaker = c.speaker ?? "the speaker";
    nullWarning(
      walk,
      "member-read",
      site,
      makeItem("unknown", null, { reasons: REASON.opaque, context: "unmodelled", cert: "pos" }),
      c.kind === "speakerRead"
        ? `check that ${speaker} is not null and has .${c.property}`
        : `check that ${speaker} is not null and has writable .${c.property}`,
      speaker,
      {
        rule: "member",
        receiver: speaker,
        member: `.${c.property}`,
        use: c.kind === "speakerRead" ? "read" : "store",
      },
      [],
      ["non-null"],
      { text: speaker, kinds: ["speaker"], member: c.property },
    );
  }
}
