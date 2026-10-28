import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

import { FINISHING_READERS, questionSourceDiagnostics } from "./check-question-sources.mjs";
import { repositoryRoot } from "./files.mjs";

const ANSWERS = "src/type-inference/core/answers.ts";
const CONSUMERS = "src/type-inference/core/consumers.ts";
const COMPOSED = "for (const item of this.#items(child.value, child.node, rest)) items.push(item);";

/**
 * The check's messages for answers.ts and consumers.ts, each changed in memory by its `edit` (a scratch copy). The files
 * as they are pass the check in `npm run lint` (`run.mjs`); these are its negative pair (TABLE r4.165).
 */
function messagesWith(edits) {
  return questionSourceDiagnostics(
    [ANSWERS, CONSUMERS].map((file) => {
      const text = readFileSync(resolve(repositoryRoot, file), "utf8");
      const changed = edits[file]?.(text) ?? text;
      if (edits[file] !== undefined)
        assert.notEqual(changed, text, `the scratch copy of ${file} changes`);
      return { file, text: changed };
    }),
    FINISHING_READERS,
  ).map((diagnostic) => `${diagnostic.fileName}: ${diagnostic.message}`);
}

test("a composed child's call of finishedItems by name fails (Astra r7 B1's site)", () => {
  const messages = messagesWith({
    [ANSWERS]: (text) =>
      text.replace(
        COMPOSED,
        "for (const item of this.#consumers.finishedItems(child.value, child.node, rest)) items.push(item);",
      ),
  });
  assert.ok(
    messages.some((message) => message.startsWith(`${ANSWERS}: finishedItems is named only in`)),
    messages.join("\n"),
  );
});

test("a new wrapper of the finishing read fails by the name it references, however it is read (Codex r28 B1)", () => {
  // (Codex r28's reproduction: the wrapper read through a structural type and a thunk in the composed child)
  const messages = messagesWith({
    [CONSUMERS]: (text) =>
      text.replace(
        "  public finishedItems(",
        "  public settledItems(value: PlaceId, node: FlowNode | null, path: readonly string[]): readonly Item[] {\n    return this.#finishingRead(value, node, path);\n  }\n\n  public finishedItems(",
      ),
    [ANSWERS]: (text) =>
      text
        .replace(
          COMPOSED,
          "const get = () => this.#consumers;\n      for (const item of readThunk(get, child.value, child.node, rest)) items.push(item);",
        )
        .concat(
          "\ntype Reader = {\n  settledItems(value: PlaceId, node: FlowNode | null, path: readonly string[]): readonly Item[];\n};\nfunction readThunk(get: () => Reader, value: PlaceId, node: FlowNode | null, path: readonly string[]): readonly Item[] {\n  return get().settledItems(value, node, path);\n}\n",
        ),
  });
  assert.ok(
    messages.some((message) => message.startsWith(`${CONSUMERS}: #finishingRead is named only in`)),
    messages.join("\n"),
  );
});
