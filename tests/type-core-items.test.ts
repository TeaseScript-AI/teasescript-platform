import assert from "node:assert/strict";
import test from "node:test";

import {
  alternatives,
  CONTEXT_WORDS,
  EMPTY,
  ingressStores,
  itemsSignature,
  makeItem,
  mergeItems,
  REASON,
  weaken,
  writerKey,
  type ContextWord,
  type Item,
  type ItemScope,
  type ItemTag,
  type Writer,
} from "../src/type-inference/core/items.js";
import { operationItems } from "../src/type-inference/core/operator-table.js";
import { familyOf } from "../src/value-kinds.js";
import { ItemSource, itemScope } from "./helpers/type-core-items.js";

// The item algebra by its laws (the reference model's `algebra14.mjs`, restated for the port's items): random items,
// operand lists and orders from a fixed seed, so a failure reproduces.

const TRIALS = 1500;

const SITE = { file: 0, start: 100, end: 105 };

const writerRank = (writer: Writer | null): number =>
  writer === null ? Infinity : writer.file * 1e9 + writer.start;
const contextRank = (context: ContextWord | null): number =>
  context === null ? CONTEXT_WORDS.length : CONTEXT_WORDS.indexOf(context);
const storesOf = (item: Item): string[] =>
  item.ingress === undefined ? [] : ingressStores(item.ingress).map(writerKey);
const byTag = (items: readonly Item[], tag: ItemTag): Item | undefined =>
  items.find((item) => item.tag === tag);

/** Items as one text that order cannot change: the signature, and each kind's ingress stores, which it leaves out. */
function view(items: readonly Item[], scope: ItemScope): string {
  const stores = items.map((item) => `${item.tag}:${storesOf(item).join("+")}`).sort();
  return `${itemsSignature(items, scope)} / ${stores.join(",")}`;
}

/** External data that no ingress store brought, which keeps its own check at a consumer (C9). */
const loose = (item: Item): boolean =>
  (item.reasons & REASON.external) !== 0 && (item.ingress === undefined || item.loose === true);

test("the item algebra keeps its laws over random items from a fixed seed", () => {
  const scope = itemScope();
  const source = new ItemSource(12345, scope);
  const failures: { law: string; detail: unknown }[] = [];
  const checked = new Map<string, number>();
  const law = (name: string, holds: boolean, detail: unknown): void => {
    checked.set(name, (checked.get(name) ?? 0) + 1);
    if (!holds && failures.length < 10) failures.push({ law: name, detail });
  };
  const merge = (items: readonly Item[]): Item[] => mergeItems(items, scope);
  for (let trial = 0; trial < TRIALS; trial += 1) {
    const a = source.items(1 + source.below(4));
    const b = source.items(1 + source.below(4));
    const c = source.items(1 + source.below(3));

    // merging: order-free, one item per kind
    law(
      "merge.commutative",
      view(merge([...a, ...b]), scope) === view(merge([...b, ...a]), scope),
      { a, b },
    );
    law(
      "merge.associative",
      view(merge([...merge([...a, ...b]), ...c]), scope) ===
        view(merge([...a, ...merge([...b, ...c])]), scope),
      { a, b, c },
    );
    law(
      "merge.idempotent",
      view(merge([...merge(a), ...merge(a)]), scope) === view(merge(a), scope),
      { a },
    );
    law("merge.permutation", view(merge(source.shuffled(a)), scope) === view(merge(a), scope), {
      a,
    });
    const merged = merge([...a, ...b]);
    law("merge.one-per-kind", new Set(merged.map((item) => item.tag)).size === merged.length, {
      merged,
    });

    // nothing lost: definite stays definite unless guarded, every reason and ingress store kept (no boundary check is
    // erased), the earliest writer, the first context word, the mark, and external data without an ingress store
    for (const item of [...a, ...b]) {
      const kept = byTag(merged, item.tag);
      law(
        "merge.keeps",
        kept !== undefined &&
          (item.cert !== "def" || kept.cert === "def" || kept.guarded === true) &&
          (item.reasons & kept.reasons) === item.reasons &&
          writerRank(kept.writer) <= writerRank(item.writer) &&
          contextRank(kept.context) <= contextRank(item.context) &&
          (item.guarded !== true || kept.guarded === true) &&
          storesOf(item).every((store) => storesOf(kept).includes(store)) &&
          (!loose(item) || kept.ingress === undefined || kept.loose === true),
        { item, kept },
      );
    }
    // and nothing invented: each field comes from the operands of its kind
    for (const kept of merged) {
      const parts = [...a, ...b].filter((item) => item.tag === kept.tag);
      law(
        "merge.only-from-operands",
        parts.some((item) => item.writer === kept.writer) &&
          parts.some((item) => item.context === kept.context) &&
          kept.reasons === parts.reduce((all, item) => all | item.reasons, 0) &&
          (kept.cert === "def") ===
            (parts.some((item) => item.cert === "def") &&
              !parts.some((item) => item.guarded === true)) &&
          (kept.word !== undefined) === parts.every((item) => item.word !== undefined) &&
          (kept.fan !== undefined) ===
            parts.every((item) => item.fan !== undefined && item.fan === parts[0]!.fan),
        { kept, parts },
      );
      law("merge.guarded-never-def", kept.guarded !== true || kept.cert === "pos", { kept });
    }

    // alternatives: a merge, of whose definite families (a guarded item is none; nor is a null) none stays certain when
    // there are two; beside one family a definite null is a possibility only
    {
      const families = new Set(
        merged.flatMap((item) =>
          item.cert === "def" &&
          item.tag !== "unknown" &&
          item.tag !== "null" &&
          item.tag !== "empty"
            ? [familyOf(item.tag)]
            : [],
        ),
      );
      const expected =
        families.size > 1
          ? merged.map((item) => ({ ...item, cert: "pos" as const }))
          : families.size === 1
            ? merged.map((item) => (item.tag === "null" ? { ...item, cert: "pos" as const } : item))
            : merged;
      law(
        "alternatives",
        view(alternatives([...a, ...b], scope), scope) === view(expected, scope),
        { a, b },
      );
    }

    // weakening: every item a possibility, nothing else lost; the word added where none comes first, except for an
    // unknown, whose own word, its reason's, comes first (§3.4)
    {
      const weakened = weaken(a, "member");
      law(
        "weaken",
        weakened.every((item, index) => {
          const original = a[index]!;
          return (
            item.cert === "pos" &&
            item.tag === original.tag &&
            item.reasons === original.reasons &&
            item.writer === original.writer &&
            (original.tag === "unknown"
              ? item.context === original.context
              : contextRank(item.context) <=
                Math.min(contextRank(original.context), contextRank("member")))
          );
        }),
        { a, weakened },
      );
    }

    // arithmetic on numeric operands: `+` and `*` are order-free; division gives a number, definite unless an unknown
    // takes part; a number operand gives a number; an integer only when every operand has one; an unknown leaves only
    // possibilities; reasons come only from the operands; an operation with operands is never silent
    const numeric = [a, b]
      .map((operand) =>
        merge(operand).filter((item) => ["integer", "number", "unknown"].includes(item.tag)),
      )
      .filter((operand) => operand.length > 0);
    if (numeric.length === 2) {
      const flat = numeric.flat();
      const unknown = flat.some(
        (item) => item.tag === "unknown" && item.reasons !== REASON.deferred,
      );
      const anyUnknown = flat.some((item) => item.tag === "unknown");
      for (const operator of ["+", "*"] as const)
        law(
          "arith.permutation",
          view(operationItems(operator, source.shuffled(numeric), scope, SITE), scope) ===
            view(operationItems(operator, numeric, scope, SITE), scope),
          { operator, numeric },
        );
      const quotient = operationItems("/", numeric, scope, SITE);
      law(
        "arith.division-number",
        anyUnknown
          ? (byTag(quotient, "number") !== undefined ||
              quotient.every((item) => item.tag === "unknown")) &&
              quotient.every((item) => item.cert === "pos")
          : quotient.length === 1 &&
              quotient[0]!.tag === "number" &&
              quotient[0]!.cert === (flat.every((item) => item.cert === "def") ? "def" : "pos"),
        { numeric, quotient },
      );
      const sum = operationItems("+", numeric, scope, SITE);
      law(
        "arith.number-operand",
        !flat.some((item) => item.tag === "number") ||
          flat.some((item) => item.tag === "unknown" && item.reasons === REASON.deferred) ||
          byTag(sum, "number") !== undefined,
        { numeric, sum },
      );
      const allInteger = numeric.every((operand) => operand.some((item) => item.tag === "integer"));
      if (!anyUnknown)
        law("arith.integer-iff-all", (byTag(sum, "integer") !== undefined) === allInteger, {
          numeric,
          sum,
        });
      if (allInteger && !flat.some((item) => item.tag === "unknown" || item.tag === "number"))
        law(
          "arith.integer-definite-iff-operands-are",
          (byTag(sum, "integer")!.cert === "def") === flat.every((item) => item.cert === "def"),
          { numeric, sum },
        );
      if (allInteger && flat.some((item) => item.tag === "number"))
        law("arith.integer-possible-beside-number", byTag(sum, "integer")?.cert === "pos", {
          numeric,
          sum,
        });
      law("arith.unknown-possible", !unknown || sum.every((item) => item.cert === "pos"), {
        numeric,
        sum,
      });
      const reasons = flat.reduce((all, item) => all | item.reasons, 0);
      law(
        "arith.reasons-from-operands",
        sum.every((item) => (item.reasons & ~(reasons | REASON.deferred)) === 0),
        { numeric, sum },
      );
      law("arith.never-silent", sum.length > 0, { numeric, sum });
    }
  }
  assert.deepEqual(failures, []);
  // every law met cases
  for (const name of [
    "merge.commutative",
    "merge.keeps",
    "merge.only-from-operands",
    "alternatives",
    "weaken",
    "arith.permutation",
    "arith.division-number",
    "arith.integer-iff-all",
    "arith.integer-definite-iff-operands-are",
    "arith.integer-possible-beside-number",
    "arith.unknown-possible",
  ])
    assert.ok((checked.get(name) ?? 0) >= 20, `${name} checked ${checked.get(name) ?? 0} times`);
});

const writer = (kind: string, start: number): Writer => ({ kind, file: 0, start, end: start + 1 });

test("an external reason survives every merge, with the earliest writer", () => {
  const scope = itemScope();
  const external = makeItem("unknown", writer("argument", 1), {
    cert: "pos",
    reasons: REASON.external,
  });
  const opaque = makeItem("unknown", writer("argument", 2), {
    cert: "pos",
    reasons: REASON.opaque,
  });
  for (const order of [
    [external, opaque],
    [opaque, external],
  ]) {
    const [merged] = mergeItems(order, scope);
    assert.equal(merged?.reasons, REASON.external | REASON.opaque);
    assert.equal(merged?.writer?.start, 1);
  }
});

test("a fixpoint member's ingress cell shows the stores it gains to every value that holds it", () => {
  const scope = itemScope();
  const cell = scope.ingress.cell();
  const first = scope.ingress.leaf(writer("load", 3));
  const held = makeItem("unknown", null, {
    reasons: REASON.external,
    ingress: scope.ingress.union(first, cell)!,
  });
  assert.deepEqual(storesOf(held), ["load@0:3"]);
  cell.contents = scope.ingress.leaf(writer("assignment", 9));
  assert.deepEqual(storesOf(held), ["load@0:3", "assignment@0:9"]);
});

test("the empty mark stays itself beside two families, which become possibilities", () => {
  const scope = itemScope();
  const result = alternatives([makeItem("integer"), makeItem("string"), EMPTY], scope);
  assert.deepEqual(
    result.map((item) => `${item.tag} ${item.cert}`),
    ["integer pos", "string pos", "empty def"],
  );
});

test("an operation's result follows the runtime's rows (F16)", () => {
  const scope = itemScope();
  const kinds = (items: readonly Item[]): string[] =>
    items.map((item) => `${item.tag} ${item.cert}`);
  const integer = makeItem("integer", writer("literal", 1));
  // definite operands of one row: a definite result; `/` always a number (V30 §4)
  assert.deepEqual(kinds(operationItems("+", [[integer], [integer]], scope, SITE)), [
    "integer def",
  ]);
  assert.deepEqual(kinds(operationItems("/", [[integer], [integer]], scope, SITE)), ["number def"]);
  // a row the runtime takes by value gives a possibility, with the runtime's check (`2 * 1 calendar day`)
  const calendar = makeItem("calendarDuration", writer("literal", 5));
  assert.deepEqual(kinds(operationItems("*", [[integer], [calendar]], scope, SITE)), [
    "calendarDuration pos",
  ]);
  // kinds without a row give nothing, which C4 reports (`1 < "x"`)
  assert.deepEqual(kinds(operationItems("<", [[integer], [makeItem("string")]], scope, SITE)), []);
  // an unknown operand gives the results of every row the other operand allows: `x / 4`
  const host = makeItem("unknown", writer("assignment", 20), {
    cert: "pos",
    reasons: REASON.external,
  });
  const quotient = operationItems("/", [[host], [integer]], scope, SITE);
  assert.deepEqual(kinds(quotient), [
    "number pos",
    "duration pos",
    "calendarDuration pos",
    "angle pos",
  ]);
  // one unknown, one kind (§4 r4.14): the results stand for that operand, explained by its writer and reason
  assert.ok(
    quotient.every((item) => item.fan === "assignment@0:20" && item.writer === host.writer),
  );
  assert.ok(quotient.every((item) => item.reasons === REASON.external));
  // the unknown's reason word explains its rows, not a known operand's condition word: `hostValue / divisor()`
  const called = makeItem("integer", writer("literal", 25), { cert: "pos", context: "call" });
  assert.deepEqual(
    operationItems("/", [[host], [called]], scope, SITE).map((item) => item.context),
    ["unknown", "unknown", "unknown", "unknown"],
  );
  // `x + 2.5`: the rows with a number on the right give a number only
  assert.deepEqual(kinds(operationItems("+", [[host], [makeItem("number")]], scope, SITE)), [
    "number pos",
  ]);
  // two unknowns stay unknown, and so does an unknown beside a deferred parameter
  const deferred = makeItem("unknown", null, { cert: "pos", reasons: REASON.deferred });
  assert.deepEqual(kinds(operationItems("+", [[host], [host]], scope, SITE)), ["unknown pos"]);
  assert.deepEqual(kinds(operationItems("+", [[deferred], [integer]], scope, SITE)), [
    "unknown pos",
  ]);
  // the guard mark travels through arithmetic, and a marked result is never definite (§3.2)
  const guarded = makeItem("integer", writer("literal", 30), { cert: "pos", guarded: true });
  const marked = operationItems("+", [[guarded], [integer]], scope, SITE);
  assert.deepEqual(kinds(marked), ["integer pos"]);
  assert.equal(marked[0]?.guarded, true);
  // a context word survives arithmetic
  const late = makeItem("integer", null, { cert: "pos", context: "call" });
  assert.equal(operationItems("+", [[late], [integer]], scope, SITE)[0]?.context, "call");
});
