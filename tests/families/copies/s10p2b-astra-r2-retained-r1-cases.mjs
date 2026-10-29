// store/holding, store/call and related fixed cases; Astra review, r2 (R/astra-m4-s10p2b-review-r2/r1-cases.mjs).
export const cases = (() => {
  const cases = [];
  const add = (name, source, note) => cases.push({ name, source: source + "\nexit\n", note });
  const intro = 'let source: integer? = load("review", default: null)';
  const mutator = "function clearSource { source = null }";
  const positions = {
    store: "let sink: integer = source",
    assignment: "let sink: integer = 0\nsink = source",
    add: "let sink: integer[] = []\nsink.add(source)",
    argument: "accept(source)",
    return: "return source",
  };
  for (const [position, body] of Object.entries(positions)) {
    for (const mode of ["holding", "call", "after-null", "after-integer", "leaving", "sibling"]) {
      let middle =
        mode === "call"
          ? "clearSource()\n"
          : mode === "after-null"
            ? "source = null\n"
            : mode === "after-integer"
              ? "source = 19\n"
              : "";
      let guarded =
        mode === "leaving"
          ? `if source == null { return 0 }\n${body}`
          : mode === "sibling"
            ? `if source != null {} else { ${body} }`
            : `if source != null { ${middle}${body} }`;
      let source =
        position === "return" || mode === "leaving"
          ? `${intro}\n${mutator}\nfunction accept(x: integer) { say x }\nfunction produce: integer { ${guarded}\nreturn 0 }\nlet actual = produce()`
          : `${intro}\n${mutator}\nfunction accept(x: integer) { say x }\n${guarded}`;
      add(
        `${position}/${mode}`,
        source,
        "Stored transfer: live holding G versus invalidation/nearest definition/branch boundary",
      );
    }
  }
  add(
    "default/own-test",
    "function produce(v = hostValue) { if v is integer { let sink: integer = v } }\nproduce()",
    "Omitted argument uses parameter default, then local G",
  );
  add(
    "default/caller-not-inherited",
    `${intro}\nfunction produce(v: integer = source) { say v }\nif source != null { produce() }`,
    "Caller G cannot reach callee default evaluation",
  );
  add(
    "default/local-tested-expression",
    "function produce(v: boolean = (hostValue is integer and hostValue > 0)) { say v }\nproduce()",
    "Stored default contains operand-local G",
  );
  add(
    "argument/earlier-call",
    `${intro}\n${mutator}\nfunction combine(a, b: integer) { say b }\nif source != null { combine(clearSource(), source) }`,
    "Earlier argument call drops G before second argument",
  );
  add(
    "argument/later-call",
    `${intro}\n${mutator}\nfunction combine(a: integer, b) { say a }\nif source != null { combine(source, clearSource()) }`,
    "Later argument call cannot drop earlier evaluated argument",
  );
  add(
    "path/sibling",
    "let box = {left: hostValue, right: hostValue}\nif box.left is integer { let sink: integer = box.right }",
    "Refined text, not shared root",
  );
  add(
    "path/index-change",
    "let xs: integer?[] = [1, null]\nlet i = 0\nif xs[i] != null { i = 1\nlet sink: integer = xs[i] }",
    "Index binding store invalidates path",
  );
  add(
    "path/reorder",
    "let xs: integer?[] = [1, null]\nif xs[0] != null { xs.reverse()\nlet sink: integer = xs[0] }",
    "Collection invalidation retains check",
  );
  add(
    "path/root-replace",
    "let box = {n: 1}\nif hostValue { box = {n: null} }\nif box.n != null { box = {n: null}\nlet sink: integer = box.n }",
    "Replacing prefix drops G",
  );
  add(
    "path/positive-element",
    "let xs = hostValue\nif xs is integer[] { let sink: integer = xs[2] }",
    "Element scope kinds only; empty obligation remains",
  );
  add(
    "path/root-not-child",
    "let box = hostValue\nif box is object { let sink: integer = box.n }",
    "Root kind does not prove child kind",
  );
  add(
    "nearer/before-filter",
    "let source: number | string | null = 2.5\nif source is integer { let sink: integer = source }",
    "Definition before G is filtered",
  );
  add(
    "nearer/after-preserving-object",
    'let source: object | string | null = "abc"\nif hostValue { source = null }\nif source != null { source = {length: "kept"}\nlet sink: string = source.length }',
    "Nearer definition supplies object property rather than G kind substitution",
  );
  add(
    "loop/local-direct",
    "let source: integer | string | null = null\nrepeat 2 { source = 7\nif source != null { let sink: integer = source } }",
    "Loop-local def still reaching read retains integer",
  );
  add(
    "loop/local-join",
    "let source: integer | string | null = null\nrepeat 2 { source = 7\nif source != null { if hostValue { source = 9 }\nlet sink: integer = source } }",
    "Contract input precision: join loses original exact def",
  );
  add(
    "loop/outside-join",
    "let source: integer | string | null = null\nsource = 7\nif source != null { if hostValue { source = 9 }\nlet sink: integer = source }",
    "Corresponding no-loop precision control",
  );
  add(
    "loop/retest",
    "let source: integer? = 1\nrepeat 2 { if source != null { let sink: integer = source }\nsource = null }",
    "G re-established each iteration before invalidation",
  );
  const common =
    'let a: integer? = load("a", default: null)\nlet b: integer? = load("b", default: null)\nlet c: integer? = load("c", default: null)';
  for (const [name, last] of [
    ["preserve", "c = s"],
    ["break", "c = null"],
    ["mixed", "if hostValue { c = null } else { c = s }"],
    ["fallback", "c = s otherwise null"],
  ]) {
    add(
      `component/${name}`,
      `${common}\nif a != null and b != null and c != null { repeat 3 { let s = a\na = b\nb = c\n${last}\nlet sink: integer = a\n} }`,
      "Three dependent locations with saved old value, stable result",
    );
  }
  add(
    "component/loop-local",
    `${common}\nif a != null and b != null and c != null { repeat 3 { let local = b\nif local != null { repeat 2 { c = local\nlocal = a + 1\na = c\nlet sink: integer = a } } } }`,
    "Loop-local input in a nested dependent component",
  );
  add(
    "order/same-literal",
    `${intro}\n${mutator}\nif source != null { let box = {beforeRead: source, middle: clearSource(), afterRead: source}\nlet good: integer = box.beforeRead\nlet bad: integer = box.afterRead }`,
    "One literal takes its first read before the call and last read after it",
  );
  add(
    "order/same-call",
    `${intro}\n${mutator}\nfunction collect(a: integer, unused, b: integer) { say a\nsay b }\nif source != null { collect(source, clearSource(), source) }`,
    "Two aliases must not share across intervening argument evaluation",
  );
  for (const shape of ["direct", "join", "outside"]) {
    const inside =
      "source = 7\nif source != null { " +
      (shape === "direct" ? "" : "if choice { source = 9 }\n") +
      "let sink: integer = source }";
    add(
      "precision/" + shape,
      'let choice = askBoolean "change?"\nlet source: integer | string | null = null\n' +
        (shape === "outside" ? inside : "repeat 2 { " + inside + " }"),
      "Loop-local contract input precision control",
    );
  }
  return cases.map((c, i) => [c.name ?? c.id ?? String(i), c.source]);
})();
export const checks = ["publication"];

// the globals the recorded run passed
export const globals = ["hostValue"];

/** The evidence run this generator reproduces, checked by `tests/families/check.mjs`. */
export const recorded = {
  commands: [
    [
      "node evidence/scale.mjs <root> <tree> <family> <k> <reverse> <route>, every wheel family at 64 to 1,024, both orders and both routes",
      "R/astra-m4-s10p2b-review-r2/queue-checks.sh, queue-quick.sh",
    ],
    [
      "node evidence/semantics.mjs <root> <shard> (shards 0 to 3), components.mjs <root> <family> and stops.mjs <root> <family>",
      "R/astra-m4-s10p2b-review-r2/REPRODUCE.md",
    ],
  ],
  sources: 57,
  sha256: "630646ee84bb61fc3997cdf8319994741ece299a474d853c4fa13e9a0b9de77a",
};
