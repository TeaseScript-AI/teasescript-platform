import assert from "node:assert/strict";
import { resolve } from "node:path";
import test from "node:test";
import { Project } from "ts-morph";

import { QUESTION_READS, questionSourceDiagnostics } from "./check-question-sources.mjs";
import { repositoryRoot } from "./files.mjs";

const ANSWERS = "src/type-inference/core/answers.ts";
const CONSUMERS = "src/type-inference/core/consumers.ts";
const ADMISSION = "src/type-inference/core/admission.ts";
const OTHER = "src/type-inference/core/question-scratch.ts";

const project = new Project({
  tsConfigFilePath: resolve(repositoryRoot, "tsconfig.json"),
  skipAddingFilesFromTsConfig: true,
});
const originals = new Map(
  [ANSWERS, CONSUMERS, ADMISSION].map((file) => {
    const source = project.addSourceFileAtPath(resolve(repositoryRoot, file));
    return [file, source.getFullText()];
  }),
);
project.resolveSourceFileDependencies();

/**
 * The check's messages for the repository's three files, each changed in memory by its `edit` (a scratch copy), and an
 * `other` source file beside them when given; with `full`, its diagnostics. The files as they are pass the check in
 * `npm run lint` (`run.mjs`); these are its negative checks (TABLE r4.158).
 */
function messagesWith(edits, other, full = false) {
  for (const [file, text] of originals) {
    const edit = edits[file];
    const changed = edit === undefined ? text : edit(text);
    if (edit !== undefined) assert.notEqual(changed, text, `the scratch copy of ${file} changes`);
    project.getSourceFileOrThrow(resolve(repositoryRoot, file)).replaceWithText(changed);
  }
  const scratch =
    other === undefined
      ? null
      : project.createSourceFile(resolve(repositoryRoot, OTHER), other, { overwrite: true });
  try {
    const diagnostics = questionSourceDiagnostics(
      project.getProgram().compilerObject,
      repositoryRoot,
      {
        answers: ANSWERS,
        consumers: CONSUMERS,
        admission: ADMISSION,
        others: scratch === null ? [] : [OTHER],
        reads: QUESTION_READS,
      },
    );
    return full ? diagnostics : diagnostics.map((diagnostic) => diagnostic.message);
  } finally {
    if (scratch !== null) project.removeSourceFile(scratch);
  }
}

const ITEMS_CALL = "const finished = this.#consumers.finishedItems(value, node, path);";
const COMPOSED = "for (const item of this.#items(child.value, child.node, rest)) items.push(item);";
const READ = "(value: PlaceId, node: FlowNode | null, path: readonly string[]): readonly Item[]";
const SOURCE = "this.#finishingRead(value, node, path)";

test("a source #items alone reads, called anywhere else, fails: a composed child's direct read, a direct question's", () => {
  // (the composed child's read before TABLE r4.158, Astra r7 B1's site)
  const composed = messagesWith({
    [ANSWERS]: (text) =>
      text.replace(
        COMPOSED,
        "for (const item of this.#consumers.finishedItems(child.value, child.node, rest)) items.push(item);",
      ),
  });
  assert.ok(
    composed.some((message) =>
      message.startsWith("finishedItems is read by CoreAnswers.#items alone"),
    ),
    composed.join("\n"),
  );
  const lazy = messagesWith({
    [ANSWERS]: (text) =>
      text.replace(
        "    const items = this.#items(value, node, []);\n",
        "    const items = this.#lazilyDecided(value, []) ?? this.#items(value, node, []);\n",
      ),
  });
  assert.ok(
    lazy.some((message) =>
      message.startsWith("#lazilyDecided is read by CoreAnswers.#items alone"),
    ),
    lazy.join("\n"),
  );
  const other = messagesWith(
    {},
    'import type { Consumers } from "./consumers.js";\nexport const read = (c: Consumers) => c.finishedItems(0 as never, null, []);\n',
  );
  assert.ok(
    other.some((message) =>
      message.startsWith("finishedItems is read by CoreAnswers.#items alone"),
    ),
    other.join("\n"),
  );
});

test("a source's reference kept inside #items, or its name destructured, fails; #items without it fails too", () => {
  const kept = messagesWith({
    [ANSWERS]: (text) =>
      text.replace(
        ITEMS_CALL,
        "const read = (): readonly Item[] => this.#consumers.finishedItems(value, node, path);\n    const finished = read();",
      ),
  });
  assert.ok(
    kept.some((message) => message.startsWith("finishedItems is read by CoreAnswers.#items alone")),
    kept.join("\n"),
  );
  assert.ok(kept.includes("CoreAnswers.#items does not call finishedItems."), kept.join("\n"));
  const destructured = messagesWith({
    [ANSWERS]: (text) =>
      text.replace(
        "  public valueAt(",
        "  #reader(): unknown {\n    const { finishedItems } = this.#consumers;\n    return finishedItems;\n  }\n\n  public valueAt(",
      ),
  });
  assert.ok(
    destructured.some((message) =>
      message.startsWith("finishedItems is read by CoreAnswers.#items alone"),
    ),
    destructured.join("\n"),
  );
});

test("a wrapper of the finishing read fails wherever and however it is read (Codex r26 B1)", () => {
  // (a method and a function-valued field, each read once: an alias in the composed child, Codex r26's witness; `.bind`;
  // a destructured and a quoted name; a helper outside the class; another module; and admission's own store read)
  const names = ["aliased", "bound", "destructured", "quoted", "helped", "field", "moduleRead"];
  const messages = messagesWith(
    {
      [CONSUMERS]: (text) =>
        text.replace(
          "  public finishedItems(",
          [
            ...names
              .filter((name) => name !== "field")
              .map((name) => `  public ${name}${READ} {\n    return ${SOURCE};\n  }\n\n`),
            `  public field = ${READ} => ${SOURCE};\n\n`,
            "  public finishedItems(",
          ].join(""),
        ),
      [ANSWERS]: (text) =>
        text
          .replace(
            COMPOSED,
            "const read = this.#consumers.aliased;\n      for (const item of read.call(this.#consumers, child.value, child.node, rest)) items.push(item);",
          )
          .replace(
            "  public valueAt(",
            [
              "  #bypasses(value: PlaceId, node: FlowNode): unknown[] {",
              "    const { destructured } = this.#consumers;",
              "    return [",
              "      this.#consumers.bound.bind(this.#consumers)(value, node, []),",
              "      destructured.call(this.#consumers, value, node, []),",
              '      this.#consumers["quoted"](value, node, []),',
              "      helper(this.#consumers, value, node),",
              "      this.#consumers.field(value, node, []),",
              "      this.#consumers.admission.valueAt(this.#storeAt(node)!, []),",
              "    ];",
              "  }",
              "",
              "  public valueAt(",
            ].join("\n"),
          )
          .concat(
            "\nfunction helper(c: Consumers, value: PlaceId, node: FlowNode): readonly Item[] {\n  return c.helped(value, node, []);\n}\n",
          ),
    },
    'import type { Consumers } from "./consumers.js";\nexport const read = (c: Consumers) => c.moduleRead(0 as never, null, []);\n',
  );
  for (const member of [...names.map((name) => `Consumers.${name}`), "Admission.valueAt"])
    assert.ok(
      messages.some((message) => message.startsWith(`${member} is no listed question read`)),
      `${member}:\n${messages.join("\n")}`,
    );
});

test("a Consumers or Admission value used whole as another type fails, however it gets there (Codex r27 B1)", () => {
  // (each form on a line of its own: a structural parameter, a cast, a copy, a container's element; Codex r27's witness
  // in the composed child)
  const structural = `{ settle${READ} }`;
  // (each failing form on a line of its own: a structural parameter, a cast, a container's element, a copy by
  // `Object.assign`, a spread or a rest element, an intersection's value, a shorthand property; Codex r27's witness in
  // the composed child)
  const statements = [
    "void helper(this.#consumers, value, node, []);",
    `void (this.#consumers.admission as unknown as ${structural}).settle(value, node, []);`,
    'void helper(new Map([["c", this.#consumers]]).get("c")!, value, node, []);',
    "void helper(Object.assign({}, this.#consumers), value, node, []);",
    "const copy = { ...this.#consumers };",
    "const { ...rest } = this.#consumers;",
    "const both: Consumers & { readonly tag?: string } = this.#consumers;",
    "void helper(both, value, node, []);",
    "const c = this.#consumers;",
    `const held: { readonly c: ${structural} } = { c };`,
  ];
  const witness = "helper([this.#consumers][0]!, child.value, child.node, rest)";
  const forms = [
    ...statements.filter(
      (statement) => !statement.startsWith("const both") && !statement.startsWith("const c ="),
    ),
    witness,
  ];
  let mutated = "";
  const diagnostics = messagesWith(
    {
      [ANSWERS]: (text) =>
        (mutated = text
          .replace(COMPOSED, `for (const item of ${witness}) items.push(item);`)
          .replace(
            "  public valueAt(",
            [
              "  #bypasses(value: PlaceId, node: FlowNode): unknown[] {",
              ...statements.map((statement) => `    ${statement}`),
              "    return [copy, rest, held];",
              "  }",
              "",
              "  public valueAt(",
            ].join("\n"),
          )
          .concat(
            `\nfunction helper(c: ${structural}, ...[value, node, path]: Parameters<${structural}["settle"]>): readonly Item[] {\n  return c.settle(value, node, path);\n}\n`,
          )),
    },
    undefined,
    true,
  );
  const lines = new Set(
    diagnostics
      .filter((diagnostic) =>
        diagnostic.message.startsWith("A Consumers or Admission value is used"),
      )
      .map((diagnostic) => diagnostic.line),
  );
  for (const form of forms) {
    const line = mutated.slice(0, mutated.indexOf(form)).split("\n").length;
    assert.ok(
      lines.has(line),
      `${form} (line ${line}):\n${diagnostics.map((d) => `${d.line}: ${d.message}`).join("\n")}`,
    );
  }
});
