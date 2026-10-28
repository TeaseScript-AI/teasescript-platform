import assert from "node:assert/strict";
import { resolve } from "node:path";
import test from "node:test";
import { Project } from "ts-morph";

import { questionSourceDiagnostics } from "./check-question-sources.mjs";
import { repositoryRoot } from "./files.mjs";

const ANSWERS = "src/type-inference/core/answers.ts";
const CONSUMERS = "src/type-inference/core/consumers.ts";
const OTHER = "src/type-inference/core/question-scratch.ts";

const project = new Project({
  tsConfigFilePath: resolve(repositoryRoot, "tsconfig.json"),
  skipAddingFilesFromTsConfig: true,
});
const originals = new Map(
  [ANSWERS, CONSUMERS].map((file) => {
    const source = project.addSourceFileAtPath(resolve(repositoryRoot, file));
    return [file, source.getFullText()];
  }),
);
project.resolveSourceFileDependencies();

/**
 * The check's messages for the repository's two files, each changed in memory by its `edit` (a scratch copy), and an
 * `other` source file beside them when given. The files as they are pass the check in `npm run lint` (`run.mjs`); these
 * are its negative checks (TABLE r4.158).
 */
function messagesWith(edits, other) {
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
    return questionSourceDiagnostics(project.getProgram().compilerObject, repositoryRoot, {
      answers: ANSWERS,
      consumers: CONSUMERS,
      others: scratch === null ? [] : [OTHER],
    }).map((diagnostic) => diagnostic.message);
  } finally {
    if (scratch !== null) project.removeSourceFile(scratch);
  }
}

const ITEMS_CALL = "const finished = this.#consumers.finishedItems(value, node, path);";
const COMPOSED = "for (const item of this.#items(child.value, child.node, rest)) items.push(item);";

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

test("a CoreAnswers call into another Consumers method fails, whatever its name", () => {
  const messages = messagesWith({
    [CONSUMERS]: (text) =>
      text.replace(
        "  public finishedItems(",
        "  public settledItems(value: PlaceId): readonly Item[] {\n    return this.#finishingRead(value, null, []);\n  }\n\n  public finishedItems(",
      ),
    [ANSWERS]: (text) =>
      text.replace(
        "    const items = this.#items(value, node, []);\n",
        "    const items = this.#consumers.settledItems(value);\n",
      ),
  });
  assert.ok(
    messages.some((message) => message.startsWith("CoreAnswers calls Consumers.settledItems")),
    messages.join("\n"),
  );
});
