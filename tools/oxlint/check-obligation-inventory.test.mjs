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

// Where the scratch copies are edited: the class's entry, the file holding `OBLIGATION_SITES`, and the fresh pass.
const ADMISSION = "src/type-inference/core/admission.ts";
const INVENTORY = ADMISSION;
const CONSUMERS = "src/type-inference/core/consumers.ts";
const FRESH = CONSUMERS;
const FRESH_START = "  #freshStores(): void {\n";
const MEMBERS = "  public valueAt(";
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
      text.replace(FRESH_START, `${FRESH_START}    this.admission.newDecision();\n`),
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
 * The derivation model's family (Codex r1–r3 on #1360): each form of declaration, in each layout, by what it does. A
 * creating form must be listed; a form the model cannot name, or a creation outside every form, is reported as unproved;
 * a name two derivations share is reported; an exact forwarder is its function's (the quiet control).
 */
const CREATES = "(error: () => void): void {\n    error();\n  }";
/** Members of the class, the single-file layout: [the name the report gives, the member]. */
const MEMBER_FORMS = [
  ["probeMethod", `public probeMethod${CREATES}`],
  [
    "probeGetter",
    "get probeGetter(): number {\n    this.readChecks.push(this.readChecks[0]!);\n    return 0;\n  }",
  ],
  ["probeArrow", "probeArrow = (error: () => void): void => {\n    error();\n  };"],
  [
    "probeWrapped",
    "probeWrapped = ((error: () => void): void => {\n    error();\n  }) satisfies unknown;",
  ],
  ["probeQuoted", `"probeQuoted"${CREATES}`],
  ["probeComputed", `["probeComputed"]${CREATES}`],
];
/** Top-level forms of the entry: a function taking the instance under a member's name; creations outside every form. */
const ENTRY_FORMS = [
  [
    "Admission.reject names 2 derivations",
    "function reject(admission: Admission): void {\n  void admission;\n}",
  ],
  [
    "An obligation is created outside",
    "function probeOutside(error: () => void): void {\n  error();\n}",
  ],
  [
    "An obligation is created outside",
    "class ProbeNested {\n  run(error: () => void): void {\n    error();\n  }\n}",
  ],
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
    "An obligation is created outside",
    "export function probeStructural(admission: { readChecks: unknown[] }, error: () => void): void {\n  void admission;\n  error();\n}",
  ],
  [
    "An obligation is created outside",
    "export function probeOuter(): void {\n  const inner = (error: () => void): void => error();\n  void inner;\n}",
  ],
];
/** Forwarders in the class to a part's function of their name: each wrong in one way but the first (quiet). */
const FORWARDERS = [
  [
    "probeExact",
    "public probeExact(value: number): number {\n    return probeExact(this, value);\n  }",
    false,
  ],
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

test("each member form of the single-file layout is a derivation; a creation outside every form is reported", () => {
  const messages = messagesWith({
    [ADMISSION]: (text) =>
      `${text.replace(MEMBERS, MEMBER_FORMS.map(([, member]) => `  ${member}\n\n`).join("") + MEMBERS)}\n${ENTRY_FORMS.map(([, form]) => form).join("\n\n")}\n`,
  });
  for (const [name] of MEMBER_FORMS) expectStart(messages, `Admission.${name} creates`);
  for (const [start] of ENTRY_FORMS) expectStart(messages, start);
  assert.equal(
    messages.filter((message) => message.startsWith("An obligation is created outside")).length,
    2,
  );
});

test("each function form of the split layout is a derivation; only an exact forwarder is its function's", () => {
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
  assert.equal(
    messages.filter((message) => message.startsWith("An obligation is created outside")).length,
    2,
  );
  for (const [name, , reported] of FORWARDERS)
    expectStart(messages, `Admission.${name} names 2 derivations`, reported);
});

/** Unlisted derivations a creating consumer calls, by route: [the name, the call in the fresh pass]. */
const ROUTES = [
  ["routeMethod", "this.admission.routeMethod();"],
  ["routeQuoted", 'this.admission["routeQuoted"]();'],
  ["routeDirect", "routeDirect(this.admission);"],
  ["routeAlias", "aliased(this.admission);"],
  ["routeNamespace", "probe.routeNamespace(this.admission);"],
  ["routeParens", "(routeParens)(this.admission);"],
  ["routeCall", "routeCall.call(undefined, this.admission);"],
  ["routeApply", "routeApply.apply(undefined, [this.admission]);"],
];
/** What the model cannot follow from a creating consumer: [the report, the statement]. */
const UNPROVED = [
  [
    "reads Admission.routeMethod as a value",
    "const stored = this.admission.routeMethod;\n    void stored;",
  ],
  ["reads Admission.reject as a value", "const { reject } = this.admission;\n    void reject;"],
  ["hands the Admission instance", "probeHelper(this.admission);"],
  ["calls the Admission instance in a way", "this.admission[probeKey]();"],
];

test("a creating consumer's call reaches its derivation by any route; what the model cannot follow is unproved; the fresh pass runs a derivation by identity", () => {
  const unlisted = (name) =>
    `export function ${name}(admission: Admission): number {\n  void admission;\n  return 0;\n}`;
  const messages = messagesWith(
    edits(
      [
        ADMISSION,
        (text) =>
          importing(
            ["routeMethod", "routeQuoted", "routeQuiet", "routeSelf"],
            "./admission/probe.js",
          ) +
          text.replace(
            MEMBERS,
            ["routeMethod", "routeQuoted", "routeQuiet", "routeSelf"]
              .map((name) => `  public ${name}(): number {\n    return ${name}(this);\n  }\n\n`)
              .join("") + MEMBERS,
          ),
      ],
      [
        INVENTORY,
        (text) =>
          text.replace(
            "OBLIGATION_SITES = [\n",
            'OBLIGATION_SITES = [\n  { method: "freshAliased", runs: "freshAliased" },\n  { method: "freshDecoy", runs: "freshDecoy" },\n',
          ),
      ],
      [
        FRESH,
        (text) =>
          importing(
            [
              "routeDirect",
              "routeAlias as aliased",
              "routeParens",
              "routeCall",
              "routeApply",
              "freshAliased as runAliased",
            ],
            "./admission/probe.js",
          ) +
          'import * as probe from "./admission/probe.js";\n' +
          text.replace(
            FRESH_START,
            `${FRESH_START}${[...ROUTES, ...UNPROVED].map(([, statement]) => `    ${statement}\n`).join("")}    runAliased(this.admission);\n    freshDecoy();\n`,
          ) +
          "\nfunction freshDecoy(): void {}\nfunction probeHelper(admission: unknown): void {\n  void admission;\n}\ndeclare const probeKey: string;\n" +
          // (a consumer recording through an alias of the instance creates; a nested class's own `this` does not)
          "export function probeSelf(walk: Consumers): void {\n  const self = walk;\n  self.diagnostics.push(self.diagnostics[0]!);\n  walk.admission.routeSelf();\n}\n" +
          // (a function the model cannot name as a consumer's, calling into admission: unproved)
          "interface ProbeView {\n  admission: Admission;\n}\nexport function probeOutside(view: ProbeView): void {\n  view.admission.routeSelf();\n}\n" +
          "export function probeQuiet(walk: Consumers): void {\n  class Inner {\n    diagnostics: unknown[] = [];\n    run(): void {\n      this.diagnostics.push(0);\n    }\n  }\n  new Inner().run();\n  walk.admission.routeQuiet();\n}\n",
      ],
    ),
    {
      [PART]: `${PART_HEAD}\n${[...ROUTES.map(([name]) => name), "routeQuiet", "routeSelf", "freshAliased", "freshDecoy"].map(unlisted).join("\n\n")}\n`,
    },
  );
  for (const [name] of ROUTES)
    expectStart(messages, `Consumers.#freshStores calls Admission.${name}:`);
  for (const [report] of UNPROVED) expectStart(messages, `Consumers.#freshStores ${report}`);
  expectStart(messages, "Consumers.probeSelf calls Admission.routeSelf:");
  expectStart(messages, "Consumers.probeQuiet calls Admission.routeQuiet:", false);
  expectStart(messages, "An Admission call is made outside every consumer derivation");
  expectStart(messages, "The fresh pass does not call freshDecoy");
  expectStart(messages, "The fresh pass does not call freshAliased", false);
});
