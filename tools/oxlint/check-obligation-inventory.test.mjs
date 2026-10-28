import assert from "node:assert/strict";
import { resolve } from "node:path";
import test from "node:test";
import { Project } from "ts-morph";

import {
  admissionFiles,
  consumersFiles,
  HOST_READS,
  obligationInventoryDiagnostics,
  READS,
} from "./check-obligation-inventory.mjs";
import { repositoryRoot } from "./files.mjs";

// Where the scratch copies are edited, in this layout (the #1071 splits repoint them): the class's entry and where its
// members are inserted; the file holding `OBLIGATION_SITES`; the fresh pass, its first line, its instance and its label,
// the path from it to admission's folder, and what it imports to name `Admission`.
const ADMISSION = "src/type-inference/core/admission.ts";
const MEMBERS = "  public valueAt(";
const INVENTORY = ADMISSION;
const CONSUMERS = "src/type-inference/core/consumers.ts";
const FRESH = CONSUMERS;
const FRESH_START = "  #freshStores(): void {\n";
const SELF = "this";
const FRESH_LABEL = "Consumers.#freshStores";
const FRESH_TO_ADMISSION = "./admission";
const FRESH_IMPORTS = "";
// A part of admission's the split layout adds in memory, beside the files the layout already has.
const PART = "src/type-inference/core/admission/probe.ts";
const PART_HEAD = 'import type { Admission } from "../admission.js";\n';

/**
 * The check's messages for the repository's admission and consumers files, each changed in memory by its `edit` (a
 * scratch copy), and the files `added` in memory. The files as they are pass the check in `npm run lint` (`run.mjs`);
 * these are its negative checks (TABLE r4.143).
 */
function messagesWith(edits, added = {}) {
  const project = new Project({
    tsConfigFilePath: resolve(repositoryRoot, "tsconfig.json"),
    skipAddingFilesFromTsConfig: true,
  });
  const admission = [...admissionFiles(repositoryRoot)];
  const consumers = [...consumersFiles(repositoryRoot)];
  for (const file of [...admission, ...consumers]) {
    const source = project.addSourceFileAtPath(resolve(repositoryRoot, file));
    const edit = edits[file];
    if (edit !== undefined) {
      const text = source.getFullText();
      const changed = edit(text);
      assert.notEqual(changed, text, `the scratch copy of ${file} changes`);
      source.replaceWithText(changed);
    }
  }
  for (const [file, text] of Object.entries(added)) {
    project.createSourceFile(resolve(repositoryRoot, file), text, { overwrite: true });
    (file.includes("/admission/") ? admission : consumers).push(file);
  }
  project.resolveSourceFileDependencies();
  return obligationInventoryDiagnostics(project.getProgram().compilerObject, repositoryRoot, {
    admission,
    consumers,
    reads: READS,
    hostReads: HOST_READS,
  }).map((diagnostic) => diagnostic.message);
}

/** Edits by file, composed where two land in one file (`INVENTORY` is `ADMISSION` in the single-file layout). */
const edits = (...pairs) => {
  const out = {};
  for (const [file, edit] of pairs) {
    const before = out[file];
    out[file] = before === undefined ? edit : (text) => edit(before(text));
  }
  return out;
};

/** Whether a message starts so, else the messages, for the assertion. */
const expectStart = (messages, start, present = true) =>
  assert.equal(
    messages.some((message) => message.startsWith(start)),
    present,
    `${present ? "missing" : "unexpected"} "${start}":\n${messages.join("\n")}`,
  );

test("a call from an obligation-creating consumer method into an unlisted Admission method fails, whatever its name", () => {
  const messages = messagesWith({
    [ADMISSION]: (text) =>
      text.replace(MEMBERS, "  public newDecision(): number {\n    return 0;\n  }\n\n" + MEMBERS),
    [FRESH]: (text) =>
      text.replace(FRESH_START, `${FRESH_START}    ${SELF}.admission.newDecision();\n`),
  });
  assert.ok(
    messages.some((message) => message.includes("calls Admission.newDecision")),
    messages.join("\n"),
  );
});

test("a fresh-pass derivation left in a block comment, or an entry left out of the list, fails", () => {
  const commented = messagesWith({
    [FRESH]: (text) =>
      text.replace(/\n( +)([^\n]*\.admission\.ingressStores\(\(site\)[^\n]*;)/, "\n$1/* $2 */"),
  });
  assert.ok(
    commented.some((message) => message.includes("does not call ingressStores")),
    commented.join("\n"),
  );
  const unlisted = messagesWith({
    [INVENTORY]: (text) => text.replace('method: "decide",', 'method: "decided",'),
  });
  assert.ok(
    unlisted.some((message) => message.includes("calls Admission.decide:")),
    unlisted.join("\n"),
  );
});

test("an Admission method that creates an obligation itself must be listed", () => {
  const messages = messagesWith({
    [ADMISSION]: (text) =>
      text.replace(
        MEMBERS,
        '  public extraBoundary(site: SourceSite): void {\n    this.readChecks.push(boundaryCheck(site, "x", ["unknown"], "validate x"));\n  }\n\n' +
          MEMBERS,
      ),
  });
  assert.ok(
    messages.some((message) => message.includes("Admission.extraBoundary creates an obligation")),
    messages.join("\n"),
  );
});

test("a host member that is no listed host read fails, whatever its consumer wiring", () => {
  const messages = messagesWith({
    [ADMISSION]: (text) =>
      text
        .replace(
          "export interface AdmissionHost {\n",
          "export interface AdmissionHost {\n  undecidedIngress?(site: SourceSite, label: string): void;\n",
        )
        .replace(
          MEMBERS,
          '  public openIngress(): void {\n    this.host.undecidedIngress?.({ file: 0, start: 0, end: 0 }, "x");\n  }\n\n' +
            MEMBERS,
        ),
  });
  assert.ok(
    messages.some((message) =>
      message.includes("AdmissionHost.undecidedIngress is no listed host read"),
    ),
    messages.join("\n"),
  );
});

test("an inherited host member that is no listed host read fails too", () => {
  const messages = messagesWith({
    [ADMISSION]: (text) =>
      text.replace(
        "export interface AdmissionHost {\n",
        "interface OpenHost {\n  undecidedIngress?(site: SourceSite, label: string): void;\n}\n\nexport interface AdmissionHost extends OpenHost {\n",
      ),
  });
  assert.ok(
    messages.some((message) =>
      message.includes("AdmissionHost.undecidedIngress is no listed host read"),
    ),
    messages.join("\n"),
  );
});

/*
 * The derivation model's family (Codex r1–r3 on #1360, r4 on #1369): each form of declaration, of creation, of recording
 * and of use, by what it does. A creating form must be listed; a form the model cannot name, or a creation or a use
 * outside every form, is reported as unproved; a name two derivations share is reported; an exact forwarder, with or
 * without wrappers, is its function's (the quiet controls).
 */
const CREATES = "(error: () => void): void {\n    error();\n  }";
const KEPT = "this.readChecks[0]!";
/** Members of the class, the single-file layout: [the name the report gives, the member]. */
const MEMBER_FORMS = [
  ["probeMethod", `public probeMethod${CREATES}`],
  [
    "probeGetter",
    `get probeGetter(): number {\n    this.readChecks.push(${KEPT});\n    return 0;\n  }`,
  ],
  ["probeArrow", "probeArrow = (error: () => void): void => {\n    error();\n  };"],
  [
    "probeWrapped",
    "probeWrapped = ((error: () => void): void => {\n    error();\n  }) satisfies unknown;",
  ],
  ["probeQuoted", `"probeQuoted"${CREATES}`],
  ["probeComputed", `["probeComputed"]${CREATES}`],
  // (the creation by its other spellings)
  [
    "probeQuotedArray",
    `public probeQuotedArray(): void {\n    this["readChecks"].push(${KEPT});\n  }`,
  ],
  [
    "probeQuotedPush",
    `public probeQuotedPush(): void {\n    this.readChecks["push"](${KEPT});\n  }`,
  ],
  [
    "probeAliasArray",
    `public probeAliasArray(): void {\n    const checks = this.readChecks;\n    checks.push(${KEPT});\n  }`,
  ],
  [
    "probeErrorCall",
    "public probeErrorCall(error: () => void): void {\n    error.call(undefined);\n  }",
  ],
  [
    "probeErrorApply",
    "public probeErrorApply(error: () => void): void {\n    error.apply(undefined, []);\n  }",
  ],
];
/** Top-level forms of the entry: a function taking the instance under a member's name; creations outside every form. */
const OUTSIDE = "An obligation is created outside";
const ENTRY_FORMS = [
  [
    "Admission.reject names 2 derivations",
    "function reject(admission: Admission): void {\n  void admission;\n}",
  ],
  [OUTSIDE, "function probeOutside(error: () => void): void {\n  error();\n}"],
  [OUTSIDE, "function probeOutsideCall(error: () => void): void {\n  error.call(undefined);\n}"],
  [OUTSIDE, "class ProbeNested {\n  run(error: () => void): void {\n    error();\n  }\n}"],
];
/** Functions of a part, the split layout: [the report, the declaration]. */
const PART_FORMS = [
  [
    "Admission.probePart creates",
    "export function probePart(admission: Admission, error: () => void): void {\n  void admission;\n  error();\n}",
  ],
  [
    "Admission.probeConst creates",
    "export const probeConst = ((admission: Admission, error: () => void): void => {\n  void admission;\n  error();\n}) satisfies unknown;",
  ],
  [
    "Admission.probeUnion creates",
    "export function probeUnion(admission: Admission | undefined, error: () => void): void {\n  void admission;\n  error();\n}",
  ],
  [
    "Admission.probeGeneric creates",
    "export function probeGeneric<T extends Admission>(admission: T, error: () => void): void {\n  void admission;\n  error();\n}",
  ],
  [
    "Admission.probeSecond creates",
    "export function probeSecond(error: () => void, admission: Admission): void {\n  void admission;\n  error();\n}",
  ],
  [
    "Admission.decide names 2 derivations",
    "export function decide(admission: Admission): void {\n  void admission;\n}",
  ],
  [
    OUTSIDE,
    "export function probeStructural(admission: { readChecks: unknown[] }, error: () => void): void {\n  void admission;\n  error();\n}",
  ],
  [
    OUTSIDE,
    "export function probeOuter(): void {\n  const inner = (error: () => void): void => error();\n  void inner;\n}",
  ],
];
/** Forwarders in the class to a part's function of their name: [the name, the method, whether reported]. */
const FORWARDERS = [
  // (exact: plain, past wrappers, under a quoted name)
  [
    "probeExact",
    "public probeExact(value: number): number {\n    return probeExact(this, value);\n  }",
    false,
  ],
  [
    "probeParens",
    "public probeParens(value: number): number {\n    return (probeParens)(this, value);\n  }",
    false,
  ],
  [
    "probeWrappedCall",
    "public probeWrappedCall(value: number): number {\n    return (probeWrappedCall(this, value));\n  }",
    false,
  ],
  [
    "probeQuotedName",
    'public "probeQuotedName"(value: number): number {\n    return probeQuotedName(this, value);\n  }',
    false,
  ],
  // (each wrong in one way)
  [
    "probeExtra",
    "public probeExtra(value: number): number {\n    return probeExtra(this, (Math.random(), value));\n  }",
    true,
  ],
  [
    "probeInit",
    "public probeInit(value = 0): number {\n    return probeInit(this, value);\n  }",
    true,
  ],
  [
    "probeDecorated",
    "@trace\n  public probeDecorated(value: number): number {\n    return probeDecorated(this, value);\n  }",
    true,
  ],
  [
    "probeAsync",
    "public async probeAsync(value: number): Promise<number> {\n    return probeAsync(this, value);\n  }",
    true,
  ],
  [
    "probeReorder",
    "public probeReorder(a: number, b: number): number {\n    return probeReorder(this, b, a);\n  }",
    true,
  ],
];
const forwarded = (name) =>
  `export function ${name}(admission: Admission, a: number, b = 0): number {\n  void admission;\n  return a + b;\n}`;
const importing = (names, from) => `import { ${names.join(", ")} } from "${from}";\n`;

test("each member form of the single-file layout is a derivation, each creation by any spelling; a creation outside every form is reported", () => {
  const messages = messagesWith({
    [ADMISSION]: (text) =>
      `${text.replace(MEMBERS, MEMBER_FORMS.map(([, member]) => `  ${member}\n\n`).join("") + MEMBERS)}\n${ENTRY_FORMS.map(([, form]) => form).join("\n\n")}\n`,
  });
  for (const [name] of MEMBER_FORMS) expectStart(messages, `Admission.${name} creates`);
  for (const [start] of ENTRY_FORMS) expectStart(messages, start);
  assert.equal(messages.filter((message) => message.startsWith(OUTSIDE)).length, 3);
});

test("each function form of the split layout is a derivation; only an exact forwarder, wrappers seen through, is its function's", () => {
  const messages = messagesWith(
    {
      [ADMISSION]: (text) =>
        importing(
          FORWARDERS.map(([name]) => name),
          "./admission/probe.js",
        ) +
        text.replace(MEMBERS, FORWARDERS.map(([, member]) => `  ${member}\n\n`).join("") + MEMBERS),
    },
    {
      [PART]: `${PART_HEAD}\n${[...PART_FORMS.map(([, form]) => form), ...FORWARDERS.map(([name]) => forwarded(name))].join("\n\n")}\n`,
    },
  );
  for (const [start] of PART_FORMS) expectStart(messages, start);
  assert.equal(messages.filter((message) => message.startsWith(OUTSIDE)).length, 2);
  for (const [name, , reported] of FORWARDERS)
    expectStart(messages, `Admission.${name} names 2 derivations`, reported);
});

/** Unlisted derivations a creating consumer calls, by route: [the name, the call in the fresh pass]. */
const ROUTES = [
  ["routeMethod", `${SELF}.admission.routeMethod();`],
  ["routeQuoted", `${SELF}.admission["routeQuoted"]();`],
  ["routeDirect", `routeDirect(${SELF}.admission);`],
  ["routeAlias", `aliased(${SELF}.admission);`],
  ["routeNamespace", `probe.routeNamespace(${SELF}.admission);`],
  ["routeParens", `(routeParens)(${SELF}.admission);`],
  ["routeCall", `routeCall.call(undefined, ${SELF}.admission);`],
  ["routeApply", `routeApply.apply(undefined, [${SELF}.admission]);`],
];
/** What the model cannot follow from a creating consumer: [the report, the statement]. */
const UNPROVED = [
  [
    "reads Admission.routeMethod as a value",
    `const stored = ${SELF}.admission.routeMethod;\n    void stored;`,
  ],
  [
    "reads Admission.routeQuoted as a value",
    `const quoted = ${SELF}.admission["routeQuoted"];\n    void quoted;`,
  ],
  ["reads Admission.reject as a value", `const { reject } = ${SELF}.admission;\n    void reject;`],
  [
    "reads Admission.sourceOrder as a value",
    `const { ["sourceOrder"]: order } = ${SELF}.admission;\n    void order;`,
  ],
  ["hands the Admission instance", `probeHelper(${SELF}.admission);`],
  ["calls Admission.[a computed key]", `${SELF}.admission[probeKey]();`],
  ["calls Admission.probeOpaque", `${SELF}.admission.probeOpaque();`],
];
/** Consumers that record by a spelling, each calling its own unlisted derivation: [the consumer, the derivation, the body]. */
const RECORDING = [
  ["probeSelf", "routeSelf", "const self = walk;\n  self.diagnostics.push(self.diagnostics[0]!);"],
  ["probeQuotedRecord", "routeQuotedRecord", 'walk["diagnostics"].push(walk.diagnostics[0]!);'],
  [
    "probeBindingRecord",
    "routeBindingRecord",
    'const { "diagnostics": found } = walk;\n  found.push(found[0]!);',
  ],
  [
    "probeAliasRecord",
    "routeAliasRecord",
    "const list = walk.diagnostics;\n  list.push(list[0]!);",
  ],
];
/** Consumers that record nothing, calling their own unlisted derivation: quiet (a nested class's `this`; a read alone). */
const QUIET = [
  [
    "probeQuiet",
    "routeQuiet",
    "class Inner {\n    diagnostics: unknown[] = [];\n    run(): void {\n      this.diagnostics.push(0);\n    }\n  }\n  new Inner().run();",
  ],
  ["probeReadOnly", "routeReadOnly", "const { diagnostics } = walk;\n  void diagnostics.length;"],
];

test("a creating consumer's call reaches its derivation by any route; what the model cannot follow is unproved; the fresh pass runs one derivation by identity", () => {
  const forwarded = [
    "routeMethod",
    "routeQuoted",
    ...[...RECORDING, ...QUIET].map(([, route]) => route),
  ];
  const unlisted = (name) =>
    `export function ${name}(admission: Admission): number {\n  void admission;\n  return 0;\n}`;
  const consumerFunction = ([name, route, body]) =>
    `export function ${name}(walk: Consumers): void {\n  ${body}\n  walk.admission.${route}();\n}\n`;
  const messages = messagesWith(
    edits(
      [
        ADMISSION,
        (text) =>
          importing(forwarded, "./admission/probe.js") +
          text.replace(
            MEMBERS,
            [
              ...forwarded.map(
                (name) => `  public ${name}(): number {\n    return ${name}(this);\n  }\n\n`,
              ),
              // (a callable no derivation is: unproved where it is called)
              "  probeOpaque = (() => () => 0)();\n\n",
            ].join("") + MEMBERS,
          ),
      ],
      [
        INVENTORY,
        (text) =>
          text.replace(
            "OBLIGATION_SITES = [\n",
            'OBLIGATION_SITES = [\n  { method: "freshAliased", runs: "freshAliased" },\n  { method: "freshDecoy", runs: "freshDecoy" },\n  { method: "freshShared", runs: "freshShared" },\n',
          ),
      ],
      [
        FRESH,
        (text) =>
          FRESH_IMPORTS +
          importing(
            [
              "routeDirect",
              "routeAlias as aliased",
              "routeParens",
              "routeCall",
              "routeApply",
              "freshAliased as runAliased",
            ],
            `${FRESH_TO_ADMISSION}/probe.js`,
          ) +
          `import * as probe from "${FRESH_TO_ADMISSION}/probe.js";\n` +
          text.replace(
            FRESH_START,
            `${FRESH_START}${[...ROUTES, ...UNPROVED].map(([, statement]) => `    ${statement}\n`).join("")}    runAliased(${SELF}.admission);\n    freshDecoy();\n    freshShared(${SELF});\n`,
          ) +
          // (an unrecognised decoy; a recognised one of a derivation's name; a helper the model does not follow)
          "\nfunction freshDecoy(): void {}\nfunction freshShared(walk: Consumers): void {\n  void walk;\n}\nfunction probeHelper(admission: unknown): void {\n  void admission;\n}\ndeclare const probeKey: string;\n" +
          [...RECORDING, ...QUIET].map(consumerFunction).join("") +
          // (functions the model cannot name as a consumer's, calling or reading admission's: unproved)
          "interface ProbeView {\n  admission: Admission;\n}\n" +
          "export function probeOutside(view: ProbeView): void {\n  view.admission.routeSelf();\n}\n" +
          "export function probeOutsideRead(view: ProbeView): void {\n  const read = view.admission.routeSelf;\n  void read;\n}\n",
      ],
    ),
    {
      [PART]: `${PART_HEAD}\n${[...ROUTES.map(([name]) => name), ...forwarded.slice(2), "freshAliased", "freshDecoy", "freshShared"].map(unlisted).join("\n\n")}\n`,
    },
  );
  for (const [name] of ROUTES) expectStart(messages, `${FRESH_LABEL} calls Admission.${name}:`);
  for (const [report] of UNPROVED) expectStart(messages, `${FRESH_LABEL} ${report}`);
  for (const [name, route] of RECORDING)
    expectStart(messages, `Consumers.${name} calls Admission.${route}:`);
  for (const [name, route] of QUIET)
    expectStart(messages, `Consumers.${name} calls Admission.${route}:`, false);
  assert.equal(
    messages.filter((message) => message.startsWith("An Admission call or read is made outside"))
      .length,
    2,
  );
  expectStart(messages, "The fresh pass does not call freshDecoy");
  expectStart(messages, "The fresh pass does not call freshAliased", false);
  expectStart(
    messages,
    "OBLIGATION_SITES lists freshShared for freshShared, which names 2 derivations",
  );
});
