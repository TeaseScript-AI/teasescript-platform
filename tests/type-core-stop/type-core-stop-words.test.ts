// A stopped receiver's words, and the sentence table (#1708).

import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import test from "node:test";

import { ts } from "ts-morph";
import { analyseCore, type Answers } from "../../src/type-inference/core/answers.js";
import type { Obligation } from "../../src/type-inference/core/result.js";
import { coreRequest } from "../helpers/type-core-analysis.js";
import {
  combinedMarkProblems,
  combinedStopRule,
  heldProblems,
  heldRun,
  heldStops,
  HELD_MODES,
  labelIdentities,
  withLabels,
  provenRewording,
  SENTENCE_VARIANTS,
  type HeldCase,
} from "../helpers/type-core-held-host.js";

/**
 * #1708, A′: after a stop, a method receiver's words may follow a proven type (the declaration to the
 * leaf, `xs: integer dict` → `integer`: `xs.entry has .clear()`) where the demand-only reference spells the method
 * table's kinds (`xs.element is a list, a set, or a dict with .clear()`), and the stopped record stands as the proven
 * kinds and the proof's route derive it. At every settled stop of the witness, at demands 1 and 3 in the four modes, the
 * stop oracle accepts the pair on both sides of the inventory, and some stop pairs them.
 */
test("a stopped receiver's words may follow the declaration to its leaf, the pair one check on both sides (#1708)", () => {
  const witness: HeldCase = {
    name: "receiver-words",
    source:
      'let xs: integer dict = dict {a: hostValue}\nsay "BEFORE"\nxs["a"].clear()\nsay "AFTER"\nexit\n',
    slice: true,
    values: [],
  };
  const natural = (mode: (typeof HELD_MODES)[number]): Answers =>
    mode.run(() =>
      analyseCore(
        coreRequest([{ path: "main.tease", source: witness.source }], ["hostValue", "hostOther"])!,
      ),
    );
  let paired = 0;
  for (const mode of HELD_MODES)
    for (const demand of [1, 3]) {
      const reference = heldRun(witness, mode, undefined, demand);
      for (const { allowance } of heldStops(witness, mode, 4, demand)) {
        assert.deepEqual(
          heldProblems(witness, mode, allowance, reference, demand),
          [],
          `${mode.name} ${demand} @${allowance}`,
        );
        const stopped = heldRun(witness, mode, allowance, demand).answers;
        paired += combinedStopRule(witness, mode, reference, stopped).reworded.pairs.size;
        assert.deepEqual(
          combinedMarkProblems(reference.answers, natural(mode), stopped),
          [],
          `${mode.name} ${demand} @${allowance}: the inventory`,
        );
      }
    }
  assert.ok(paired > 0, "no stop paired the receiver's words");
});

/**
 * Refusals (#1708): the witness's own pair, each condition broken in turn, is refused: (1) kinds the
 * declaration does not prove; (2) another `against`; (3) a record field the proven kinds do not imply (a `present` after
 * the stop, an extra fitting type, a context neither route explains, another rule field) or a sentence its kinds do not
 * select; and a variant missing from the table.
 */
test("a stopped receiver's words are refused where a condition of r4.363 breaks (#1708)", () => {
  const witness: HeldCase = {
    name: "receiver-words",
    source:
      'let xs: integer dict = dict {a: hostValue}\nsay "BEFORE"\nxs["a"].clear()\nsay "AFTER"\nexit\n',
    slice: true,
    values: [],
  };
  const mode = HELD_MODES[0]!;
  const reference = heldRun(witness, mode, undefined, 3).answers;
  const found = heldStops(witness, mode, 1, 3)
    .map(({ allowance }) => heldRun(witness, mode, allowance, 3).answers)
    .find((answers) =>
      answers.budget.deferred.some((mark) => mark.obligation.on.includes(" has .clear()")),
    );
  assert.ok(found !== undefined, "no stop of the witness spells the leaf's words");
  const stopped = found;
  const u = reference.checks.find((check) => check.on.includes(".clear()"))!;
  const mark = stopped.budget.deferred.find((each) =>
    each.obligation.on.includes(" has .clear()"),
  )!;
  const x = mark.obligation;
  const [from, to] = [labelIdentities(reference), labelIdentities(stopped)];
  const owed = (answers: Answers) => [
    ...answers.checks,
    ...answers.budget.deferred.map((m) => m.obligation),
  ];
  assert.equal(provenRewording(u, owed(stopped), reference, stopped, from, to, []), x);
  // (the stopped mark replaced by a changed copy: its check `changed`, its record `record`)
  const tampered = (record: Partial<typeof mark>, changed: Obligation = x): Answers => ({
    ...stopped,
    budget: {
      ...stopped.budget,
      deferred: stopped.budget.deferred.map((each) =>
        each === mark ? { ...mark, ...record, obligation: changed } : each,
      ),
    },
  });
  // (the changed check keeps the recorded label of the one it replaces, so only the condition under test can refuse it)
  const refused = (record: Partial<typeof mark>, why: string, changed: Obligation = x): void => {
    const answers = tampered(record, changed);
    const labels = to === null ? null : withLabels(to, [[changed, to.of(x)!]]);
    assert.equal(
      provenRewording(u, owed(answers), reference, answers, from, labels, []),
      undefined,
      why,
    );
  };
  refused({ kinds: ["number"] }, "(1) kinds the declaration does not prove");
  refused({}, "(2) another against", { ...x, against: ["integer"] });
  refused({ present: "unproved" }, "(3) a present the stop does not ask");
  refused({ fits: ["integer"] }, "(3) a fitting type the kinds do not have");
  refused(
    { provenance: { ...mark.provenance, context: "loop" } },
    "(3) a context neither route explains",
  );
  refused(
    { rule: mark.rule.rule === "member" ? { ...mark.rule, use: "read" } : mark.rule },
    "(3) another rule field",
  );
  refused({}, "(3) a sentence its kinds do not select", {
    ...x,
    on: `check that ${x.target} is a list, a set, or a dict with .clear() before the call`,
  });
  // (Codex r1's B3 on #1759: an unknown's words are the method table's own takers, never any)
  const banana = { ...u, on: `check that ${u.target} is a banana with .clear() before the call` };
  const swapped: Answers = {
    ...reference,
    checks: reference.checks.map((each) => (each === u ? banana : each)),
    diagnostics: reference.diagnostics.map((d) =>
      "obligation" in d && d.obligation === u ? { ...d, obligation: banana } : d,
    ),
  };
  assert.equal(
    provenRewording(
      banana,
      owed(stopped),
      swapped,
      stopped,
      from === null ? null : withLabels(from, [[banana, from.of(u)!]]),
      to,
      [],
    ),
    undefined,
    "(3) an unknown's words not the method table's",
  );
  // (Codex r1's B2 on #1759: a label the declaration does not make, an `entry` of a list, is refused)
  assert.equal(
    provenRewording(
      u,
      owed(stopped),
      reference,
      stopped,
      from,
      to === null ? null : withLabels(to, [[x, { ...to.of(x)!, steps: ["entry", "entry"] }]]),
      [],
    ),
    undefined,
    "(1) a label the declaration does not make",
  );
  assert.equal(SENTENCE_VARIANTS["member"], "memberChecks");
  assert.equal(Object.keys(SENTENCE_VARIANTS).length, 17);
});

/**
 * Refusal controls (#1708, Sol's): a stop that changes the check itself is no wording: an operand's
 * `against` narrowed beside the receiver (`xs["a"] + hostOther`) or a fallback's expected domain (`xs["a"] otherwise
 * hostOther`) is never paired, whatever its words.
 */
test("a stop that changes an operand's or a fallback's expected domain is never paired as words (#1708)", () => {
  for (const source of [
    'let xs: integer dict = dict {a: hostValue}\nsay "BEFORE"\nsay xs["a"] + hostOther\nsay "AFTER"\nexit\n',
    'let xs: integer dict = dict {a: hostValue}\nsay "BEFORE"\nsay xs["a"] otherwise hostOther\nsay "AFTER"\nexit\n',
  ]) {
    const c: HeldCase = { name: "refused", source, slice: true, values: [] };
    const mode = HELD_MODES[0]!;
    const reference = heldRun(c, mode, undefined, 3);
    let changed = 0;
    for (const { allowance } of heldStops(c, mode, 2, 3)) {
      const stopped = heldRun(c, mode, allowance, 3).answers;
      const owed = [...stopped.checks, ...stopped.budget.deferred.map((m) => m.obligation)];
      // (the reference's checks whose site and kind the stop keeps with another expected domain: a changed check)
      const narrowed = new Set(
        reference.answers.checks
          .filter((u) =>
            owed.some(
              (x) =>
                x.kind === u.kind &&
                JSON.stringify(x.site) === JSON.stringify(u.site) &&
                JSON.stringify(x.against) !== JSON.stringify(u.against),
            ),
          )
          .map((u) => JSON.stringify(u)),
      );
      changed += narrowed.size;
      const pairs = combinedStopRule(c, mode, reference, stopped).reworded.pairs;
      for (const u of narrowed) assert.ok(!pairs.has(u), `${source} @${allowance}: ${u}`);
    }
    assert.ok(changed > 0, `${source}: no stop changes an expected domain`);
  }
});

/**
 * The drift guard (#1708, the lead's ruling on its HEAD 0): the sentence table and the derived record follow
 * the consumers as they are. The obligation sites whose words read kinds (a consumer's call of a word maker from the
 * messages, codes and paths apart) are the table's kind-reading entries, today `memberChecks`'s alone; and the sites
 * that set a record's read-derived fields (`fits`, `besides`, `present`, `keeps`, `provenance`) are the ones the derived
 * record mirrors or reads. A new one fails until the table or `derivedRecord` takes it.
 */
test("the sentence table and the derived record name every site that words or derives a record from kinds (#1708)", () => {
  const files = (dir: string): string[] =>
    readdirSync(dir).flatMap((name) => {
      const path = join(dir, name);
      return statSync(path).isDirectory() ? files(path) : path.endsWith(".ts") ? [path] : [];
    });
  const enclosing = (node: ts.Node): string => {
    for (let at = node.parent; at !== undefined; at = at.parent)
      if ((ts.isFunctionDeclaration(at) || ts.isMethodDeclaration(at)) && at.name !== undefined)
        return at.name.getText();
    return "(module)";
  };
  const READ_FIELDS = new Set(["fits", "besides", "present", "keeps", "provenance"]);
  // (one file's sites: its words read from kinds, and its read-derived record fields)
  const sitesOf = (file: string, text: string, words: Set<string>, fields: Set<string>): void => {
    const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
    // (the word makers a file imports from the messages, by their own names however it binds them: named, renamed,
    // the module's namespace or its default; codes and paths are no kind's words)
    const NOT_WORDS = new Set(["codeOf", "pathPhrase"]);
    const named = new Map<string, string>();
    const spaces = new Set<string>();
    for (const statement of source.statements)
      if (
        ts.isImportDeclaration(statement) &&
        ts.isStringLiteral(statement.moduleSpecifier) &&
        /\/messages(\/[\w-]+)?\.js$/.test(statement.moduleSpecifier.text) &&
        statement.importClause !== undefined &&
        !statement.importClause.isTypeOnly
      ) {
        const clause = statement.importClause;
        if (clause.name !== undefined) spaces.add(clause.name.text);
        if (clause.namedBindings !== undefined && ts.isNamespaceImport(clause.namedBindings))
          spaces.add(clause.namedBindings.name.text);
        if (clause.namedBindings !== undefined && ts.isNamedImports(clause.namedBindings))
          for (const each of clause.namedBindings.elements)
            if (!each.isTypeOnly) named.set(each.name.text, (each.propertyName ?? each.name).text);
      }
    // (and `check-result/otherwise.ts`: a consumer whose decision lies with the result it reads)
    const consumer =
      file.includes(join("core", "consumers")) ||
      file.endsWith(join("core", "check-result", "otherwise.ts"));
    const visit = (node: ts.Node): void => {
      if (consumer && ts.isCallExpression(node)) {
        const callee = node.expression;
        const word = ts.isIdentifier(callee)
          ? (named.get(callee.text) ?? (spaces.has(callee.text) ? "default" : undefined))
          : ts.isPropertyAccessExpression(callee) &&
              ts.isIdentifier(callee.expression) &&
              spaces.has(callee.expression.text)
            ? callee.name.text
            : undefined;
        if (word !== undefined && !NOT_WORDS.has(word))
          words.add(`${basename(file)}:${enclosing(node)}`);
      }
      // (a sentence that spells a kind itself: a template interpolating an item's tag)
      if (consumer && ts.isTemplateExpression(node)) {
        let reads = false;
        const look = (each: ts.Node): void => {
          if (ts.isPropertyAccessExpression(each) && each.name.text === "tag") reads = true;
          ts.forEachChild(each, look);
        };
        for (const span of node.templateSpans) look(span.expression);
        if (reads) words.add(`${basename(file)}:${enclosing(node)}`);
      }
      // (a read-derived field set in an object, by an identifier, a quoted or a shorthand key)
      if (
        (ts.isPropertyAssignment(node) || ts.isShorthandPropertyAssignment(node)) &&
        (ts.isIdentifier(node.name) || ts.isStringLiteral(node.name)) &&
        READ_FIELDS.has(node.name.text) &&
        ts.isObjectLiteralExpression(node.parent)
      )
        fields.add(`${basename(file)}:${enclosing(node)}:${node.name.text}`);
      ts.forEachChild(node, visit);
    };
    visit(source);
  };
  const words = new Set<string>();
  const fields = new Set<string>();
  for (const file of files(join(process.cwd(), "src/type-inference/core")))
    sitesOf(file, readFileSync(file, "utf8"), words, fields);
  // (Codex r1's B5 on #1759: each way a new site could hide, written as a consumer would, is found)
  const consumerFile = join(process.cwd(), "src/type-inference/core/consumers/control.ts");
  const controls: readonly (readonly [string, string, "words" | "fields"])[] = [
    [
      "renamed",
      'import { described as codeOf } from "../messages.js";\nfunction a(k) { return `is ${codeOf(k)}`; }',
      "words",
    ],
    [
      "namespace",
      'import * as m from "../messages.js";\nfunction a(k) { return `is ${m.described(k)}`; }',
      "words",
    ],
    [
      "default",
      'import words from "../messages/words.js";\nfunction a(k) { return `is ${words(k)}`; }',
      "words",
    ],
    [
      "inline",
      'function a(items) { return `saw ${items.map((item) => item.tag).join(" or ")}`; }',
      "words",
    ],
    ["quoted", 'function a(d) { return { ...d, "fits": [] }; }', "fields"],
  ];
  for (const [name, text, kind] of controls) {
    const [found, set] = [new Set<string>(), new Set<string>()];
    sitesOf(consumerFile, text, found, set);
    assert.ok((kind === "words" ? found : set).size > 0, `the guard misses a ${name} site`);
  }
  const tabled = Object.values(SENTENCE_VARIANTS).filter((site) => site !== null);
  assert.deepEqual([...words].sort(), tabled.map((site) => `receivers.ts:${site}`).sort());
  assert.deepEqual([...fields].sort(), [
    // (a published warning's `besides`, which `derivedRecord` recomputes from the stopped answers)
    "answers.ts:withBesides:besides",
    // (a kept value's types, asked only where an analysis ran to its end, as `present`)
    "diagnostics.ts:withFacts:keeps",
    "diagnostics.ts:withFacts:present",
    // (the messages read them; a record carries what they read)
    "messages.ts:coreMessage:keeps",
    "messages.ts:coreMessage:present",
    // (the record's serialized form)
    "result.ts:coreRecord:provenance",
    // (a kept value's types, as `diagnostics.ts`'s: the store contracts')
    "store-contracts.ts:#answerTask:keeps",
    "store-contracts.ts:expected:keeps",
    "warnings.ts:memberWarningFix:present",
    // (the warning's own: `fits` by the kinds that fit, `besides` none, `provenance` by the item read)
    // (the route rule's error: the fix of the warning it stands in for, its `fits` and `provenance` as `warning`'s)
    "warnings.ts:required:fits",
    "warnings.ts:required:provenance",
    "warnings.ts:warning:besides",
    "warnings.ts:warning:fits",
    "warnings.ts:warning:provenance",
  ]);
});

/**
 * #1708, Codex r1's B2 and B3 on #1759: each member form's words follow the proven leaf as its consumer
 * makes them: an element store (`has an element store`), a property store (`has a store of .p`), and a list's element
 * receiver, whose `element` label the list's own declaration proves (never an `entry`). Every 8th settled stop, four
 * modes, demand 3: the stop oracle clean.
 */
test("a store's and a list receiver's words follow the proven leaf at every member form (#1708)", () => {
  for (const source of [
    'let xs: integer dict = dict {a: hostValue}\nsay "BEFORE"\nxs["a"][0] = hostOther\nsay "AFTER"\nexit\n',
    'let xs: integer dict = dict {a: hostValue}\nsay "BEFORE"\nxs["a"].p = hostOther\nsay "AFTER"\nexit\n',
    'let xs: integer[] = [hostValue]\nsay "BEFORE"\nxs[0].clear()\nsay "AFTER"\nexit\n',
  ]) {
    const c: HeldCase = { name: "member-forms", source, slice: true, values: [] };
    for (const mode of HELD_MODES) {
      const reference = heldRun(c, mode, undefined, 3);
      for (const { allowance } of heldStops(c, mode, 8, 3)) {
        assert.deepEqual(
          heldProblems(c, mode, allowance, reference, 3),
          [],
          `${source} ${mode.name} @${allowance}`,
        );
        const stopped = heldRun(c, mode, allowance, 3).answers;
        for (const [, x] of combinedStopRule(c, mode, reference, stopped).reworded.pairs)
          if (source.includes("integer[]")) assert.ok(!x.includes(".entry"), x);
      }
    }
  }
});

/**
 * #1708, Codex r1's B2 on #1759: a list's element proves no dictionary entry. At a stop where the list
 * receiver's words follow its leaf, the stopped check relabelled `xs.entry` (its record and recorded label with it) is
 * refused: the label's own proof and the leaf's `entry` step both fail.
 */
test("a list receiver's check relabelled as a dictionary's entry is refused (#1708)", () => {
  const c: HeldCase = {
    name: "list-entry",
    source: 'let xs: integer[] = [hostValue]\nsay "BEFORE"\nxs[0].clear()\nsay "AFTER"\nexit\n',
    slice: true,
    values: [],
  };
  const mode = HELD_MODES[0]!;
  const reference = heldRun(c, mode, undefined, 3);
  const owed = (answers: Answers) => [
    ...answers.checks,
    ...answers.budget.deferred.map((m) => m.obligation),
  ];
  let tried = 0;
  for (const { allowance } of heldStops(c, mode, 1, 3)) {
    const stopped = heldRun(c, mode, allowance, 3).answers;
    const [from, to] = [labelIdentities(reference.answers), labelIdentities(stopped)];
    const pairs = combinedStopRule(c, mode, reference, stopped).reworded.pairs;
    const u = reference.answers.checks.find((each) => pairs.has(JSON.stringify(each)));
    const mark = stopped.budget.deferred.find(
      (each) => JSON.stringify(each.obligation) === pairs.get(JSON.stringify(u)),
    );
    if (u === undefined || mark === undefined || to === null) continue;
    tried += 1;
    const x = mark.obligation;
    const entry = { ...x, target: "xs.entry", on: x.on.split(x.target).join("xs.entry") };
    const answers: Answers = {
      ...stopped,
      budget: {
        ...stopped.budget,
        deferred: stopped.budget.deferred.map((each) =>
          each === mark ? { ...mark, obligation: entry } : each,
        ),
      },
    };
    const labels = withLabels(to, [[entry, { ...to.of(x)!, steps: ["entry"] }]]);
    assert.equal(
      provenRewording(u, owed(answers), reference.answers, answers, from, labels, []),
      undefined,
      `@${allowance}`,
    );
  }
  assert.ok(tried > 0, "no stop pairs the list receiver's words");
});
