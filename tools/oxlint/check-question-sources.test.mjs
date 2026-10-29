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
 * The check's messages for answers.ts and consumers.ts, each changed in memory by its `edit` (a scratch copy), or
 * replaced by its text in `replaced`, and the files `added`. The files as they are pass the check in `npm run lint`
 * (`run.mjs`); these are its negative checks (TABLE r4.165).
 */
function messagesWith(edits, replaced = {}, added = {}) {
  return questionSourceDiagnostics(
    [
      ...[ANSWERS, CONSUMERS].map((file) => {
        const text = replaced[file] ?? readFileSync(resolve(repositoryRoot, file), "utf8");
        const changed = edits[file]?.(text) ?? text;
        if (edits[file] !== undefined)
          assert.notEqual(changed, text, `the scratch copy of ${file} changes`);
        return { file, text: changed };
      }),
      ...Object.entries(added).map(([file, text]) => ({ file, text })),
    ],
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

/*
 * The split layout (#1071): the consumers' methods moved to functions in `consumers/`, each taking the instance first,
 * a public method keeping its forwarder. Its clean control reports nothing; each negative, planted in a file of its own,
 * is reported there.
 */
const PART = "src/type-inference/core/consumers/finishing.ts";
const SPLIT_CLASS = [
  'import { finishedItems, finishingRead } from "./consumers/finishing.js";',
  "export class Consumers {",
  "  constructor() {",
  "    void ((value: number) => finishingRead(this, value));",
  "  }",
  "  public valueItems(value: number): number {",
  "    return finishingRead(this, value);",
  "  }",
  "  public finishedItems(value: number): number {",
  "    return finishedItems(this, value);",
  "  }",
  "}",
].join("\n");
const SPLIT_PART = [
  'import type { Consumers } from "../consumers.js";',
  "export function finishingRead(walk: Consumers, value: number): number {",
  "  return value > 0 ? finishingRead(walk, value - 1) : 0;",
  "}",
  "export function typedRead(walk: Consumers): number {",
  "  return finishingRead(walk, 0);",
  "}",
  "export function finishedItems(walk: Consumers, value: number): number {",
  "  return finishingRead(walk, value);",
  "}",
].join("\n");
const part = (name) => `src/type-inference/core/consumers/${name}.ts`;
const IMPORT = 'import type { Consumers } from "../consumers.js";\n';
/** Negatives of the split layout, each in its own file: [its file, its text]. */
const SPLIT_NEGATIVES = [
  // a function the class owns that is no listed reader
  [
    part("settled"),
    `${IMPORT}import { finishingRead } from "./finishing.js";\nexport function settledItems(walk: Consumers): number {\n  return finishingRead(walk, 0);\n}\n`,
  ],
  // the finishing read imported under another name
  [
    part("aliased"),
    `${IMPORT}import { finishingRead as read } from "./finishing.js";\nexport const aliased = read;\n`,
  ],
  // a function of the finishing read's name another class owns
  [
    part("decoy"),
    'import type { CoreAnswers } from "../answers.js";\nexport function finishingRead(answers: CoreAnswers): number {\n  void answers;\n  return 0;\n}\n',
  ],
  // a second declaration of a listed reader's site
  [
    part("forgery"),
    `${IMPORT}import { finishingRead } from "./finishing.js";\nexport function typedRead(walk: Consumers): number {\n  return finishingRead(walk, 1);\n}\n`,
  ],
  // a function the class owns, a method of its moved to it, re-exported
  [part("reexport"), 'export { finishingRead } from "./finishing.js";\n'],
];

test("the split layout's members are its functions: clean, and each negative reported in its own file", () => {
  const clean = messagesWith({}, { [CONSUMERS]: SPLIT_CLASS }, { [PART]: SPLIT_PART });
  assert.deepEqual(clean, []);
  const messages = messagesWith(
    {},
    { [CONSUMERS]: SPLIT_CLASS },
    { [PART]: SPLIT_PART, ...Object.fromEntries(SPLIT_NEGATIVES) },
  );
  for (const [file] of SPLIT_NEGATIVES)
    assert.ok(
      messages.some((message) => message.startsWith(`${file}: `)),
      `${file}:\n${messages.join("\n")}`,
    );
  assert.ok(
    messages.some((message) => message.includes("Consumers.typedRead has 2 declarations")),
    messages.join("\n"),
  );
});

test("a forwarder that is not exact names its function as a reference (the split layout)", () => {
  const messages = messagesWith(
    {
      [CONSUMERS]: (text) =>
        text.replace(
          "return finishedItems(this, value);",
          "return finishedItems(this, value + 1);",
        ),
    },
    { [CONSUMERS]: SPLIT_CLASS },
    { [PART]: SPLIT_PART },
  );
  assert.ok(
    messages.some((message) => message.startsWith(`${CONSUMERS}: finishedItems is named only in`)),
    messages.join("\n"),
  );
  assert.ok(
    messages.some((message) => message.includes("Consumers.finishedItems has 2 declarations")),
    messages.join("\n"),
  );
});

/*
 * Identity (Codex r1 B1, N1 on #1371): a function's owner and a forwarder's target are the declarations their names
 * bind to, read lexically. Each case changes the clean split layout on one axis: the reports it must give (a file, or
 * a message's start), or none.
 */
const withoutTypedRead = SPLIT_PART.replace(
  "export function typedRead(walk: Consumers): number {\n  return finishingRead(walk, 0);\n}\n",
  "",
);
const reader = (head) =>
  `${head}import { finishingRead } from "./finishing.js";\nexport function typedRead(walk: Consumers): number {\n  return finishingRead(walk, 0);\n}\n`;
const IDENTITY = [
  // [what changes, the entry's text, the part's text, the files added, the reports, or [] for none]
  ["the clean layout", SPLIT_CLASS, SPLIT_PART, {}, []],
  [
    "the owner imported as `{ type Consumers }`",
    SPLIT_CLASS,
    SPLIT_PART.replace(
      'import type { Consumers } from "../consumers.js";',
      'import { type Consumers } from "../consumers.js";',
    ),
    {},
    [],
  ],
  [
    "the facade's function imported from outside the sources",
    SPLIT_CLASS.replace(
      'import { finishedItems, finishingRead } from "./consumers/finishing.js";',
      'import { finishingRead } from "./consumers/finishing.js";\nimport { finishedItems } from "../review-helper.js";',
    ),
    SPLIT_PART,
    {},
    [`${CONSUMERS}: finishedItems is named only in`],
  ],
  // (aliases, Codex r2 B1: a renamed import binds to nothing proved; each specifier by its own local name)
  [
    "the facade's function an alias of another function of its class",
    SPLIT_CLASS.replace(
      'import { finishedItems, finishingRead } from "./consumers/finishing.js";',
      'import { finishingRead, read as finishedItems } from "./consumers/finishing.js";',
    ),
    `${SPLIT_PART}\nexport function read(walk: Consumers, value: number): number {\n  void walk;\n  return value;\n}\n`,
    {},
    [`${CONSUMERS}: finishedItems is named only in`],
  ],
  [
    "the facade's function an alias of the finishing read",
    SPLIT_CLASS.replace(
      'import { finishedItems, finishingRead } from "./consumers/finishing.js";',
      'import { finishingRead, finishingRead as finishedItems } from "./consumers/finishing.js";',
    ),
    SPLIT_PART,
    {},
    [`${CONSUMERS}: finishedItems is named only in`],
  ],
  [
    "an alias beside a genuine unaliased import",
    SPLIT_CLASS,
    SPLIT_PART,
    {
      [part("escaped")]:
        'import { finishingRead, finishingRead as escaped } from "./finishing.js";\nexport const leaked = escaped;\n',
    },
    [`${part("escaped")}: finishingRead is named only in`],
  ],
  [
    "an alias of the guarded name for another function",
    SPLIT_CLASS,
    `${SPLIT_PART}\nexport function read(walk: Consumers, value: number): number {\n  void walk;\n  return value;\n}\n`,
    {
      [part("renamed")]:
        'import { read as finishedItems } from "./finishing.js";\nexport const items = finishedItems;\n',
    },
    [`${part("renamed")}: finishedItems is named only in`],
  ],
  [
    "the facade's function bound to nothing (not imported)",
    SPLIT_CLASS.replace(
      'import { finishedItems, finishingRead } from "./consumers/finishing.js";',
      'import { finishingRead } from "./consumers/finishing.js";',
    ),
    SPLIT_PART,
    {},
    [`${CONSUMERS}: finishedItems is named only in`],
  ],
  [
    "the facade's function bound to a same-file decoy",
    `${SPLIT_CLASS.replace(
      'import { finishedItems, finishingRead } from "./consumers/finishing.js";',
      'import { finishingRead } from "./consumers/finishing.js";',
    )}\nfunction finishedItems(walk: unknown, value: number): number {\n  void walk;\n  return value;\n}\n`,
    SPLIT_PART,
    {},
    [`${CONSUMERS}: finishedItems is named only in`],
  ],
  [
    "a reader whose `Consumers` comes from outside the sources",
    SPLIT_CLASS,
    withoutTypedRead,
    { [part("foreign")]: reader('import type { Consumers } from "../../elsewhere.js";\n') },
    [
      `${part("foreign")}: finishingRead is named only in`,
      "FINISHING_READERS lists Consumers.typedRead",
    ],
  ],
  [
    "a reader whose `Consumers` is a type parameter",
    SPLIT_CLASS,
    withoutTypedRead,
    {
      [part("generic")]:
        'import type { Consumers } from "../consumers.js";\nimport { finishingRead } from "./finishing.js";\nexport function typedRead<Consumers>(walk: Consumers): number {\n  return finishingRead(walk as never, 0);\n}\n',
    },
    [
      `${part("generic")}: finishingRead is named only in`,
      "FINISHING_READERS lists Consumers.typedRead",
    ],
  ],
  [
    "a second class named `Consumers`, nested",
    SPLIT_CLASS,
    SPLIT_PART,
    {
      [part("nested")]:
        "export function wrap(): void {\n  class Consumers {\n    typedRead(): number {\n      return 0;\n    }\n  }\n  void Consumers;\n}\n",
    },
    ["class Consumers is declared 2 times"],
  ],
  [
    "the finishing read imported from outside the sources",
    SPLIT_CLASS,
    withoutTypedRead,
    {
      [part("imported")]:
        'import type { Consumers } from "../consumers.js";\nimport { finishingRead } from "../../elsewhere.js";\nexport function typedRead(walk: Consumers): number {\n  return finishingRead(walk, 0);\n}\n',
    },
    [`${part("imported")}: finishingRead is named only in`],
  ],
];

test("a function's owner and a forwarder's target are what their names bind to; unproved bindings are reported", () => {
  for (const [label, entry, finishing, added, reports] of IDENTITY)
    for (const reversed of [false, true]) {
      const sources = [
        { file: ANSWERS, text: readFileSync(resolve(repositoryRoot, ANSWERS), "utf8") },
        { file: CONSUMERS, text: entry },
        { file: PART, text: finishing },
        ...Object.entries(added).map(([file, text]) => ({ file, text })),
      ];
      const messages = questionSourceDiagnostics(
        reversed ? sources.reverse() : sources,
        FINISHING_READERS,
      ).map((diagnostic) => `${diagnostic.fileName}: ${diagnostic.message}`);
      const where = `${label}${reversed ? ", reversed" : ""}:\n${messages.join("\n")}`;
      if (reports.length === 0) assert.deepEqual(messages, [], where);
      for (const report of reports)
        assert.ok(
          messages.some((message) => message.startsWith(report) || message.includes(`: ${report}`)),
          `${report} — ${where}`,
        );
    }
});
