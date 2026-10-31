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

// Where the scratch copies are edited, in this layout (the #1071 splits repoint them): the class's entry, where its
// members are inserted and what it imports to name `boundaryCheck`; the file holding `OBLIGATION_SITES`; the fresh pass,
// its first line, its instance and its label, the path from it to admission's folder, and what it imports to name
// `Admission`.
const ADMISSION = "src/type-inference/core/admission.ts";
const MEMBERS = "  public valueAt(";
const ADMISSION_IMPORTS = 'import { boundaryCheck } from "./admission/boundaries.js";\n';
const INVENTORY = "src/type-inference/core/admission/boundaries.ts";
// (the scratch edit that lets the entry import it: `boundaryCheck` is its part's own)
const BOUNDARY_EXPORT = [
  [
    INVENTORY,
    (text) => text.replace("\nfunction boundaryCheck(", "\nexport function boundaryCheck("),
  ],
];
const CONSUMERS = "src/type-inference/core/consumers.ts";
const FRESH = "src/type-inference/core/consumers/fresh.ts";
const FRESH_START = "export function freshStores(walk: Consumers): void {\n";
const SELF = "walk";
const FRESH_LABEL = "Consumers.freshStores";
const FRESH_TO_ADMISSION = "../admission";
const FRESH_IMPORTS = 'import type { Admission } from "../admission.js";\n';
// where a member is inserted into the Consumers class
const CONSUMER_MEMBERS = "  public check(): void {\n";
// A part of admission's the split layout adds in memory, beside the files the layout already has.
const PART = "src/type-inference/core/admission/probe.ts";
const PART_HEAD = 'import type { Admission } from "../admission.js";\n';

/**
 * The check's messages for the repository's admission and consumers files, each changed in memory by its `edit` (a
 * scratch copy), the files `added` in memory, and the listed `reads`. The files as they are pass the check in `npm run lint`
 * (`run.mjs`); these are its negative checks (TABLE r4.143).
 */
function messagesWith(edits, added = {}, reads = READS) {
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
    reads,
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

/** How many messages start so. */
const count = (messages, start) => messages.filter((message) => message.startsWith(start)).length;

/** That exactly `n` messages start so, else the count named and the messages, for the assertion. */
const expectCount = (messages, start, n) =>
  assert.equal(count(messages, start), n, `count "${start}":\n${messages.join("\n")}`);

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
  assert.ok(messages.some((message) => message.includes("calls Admission.newDecision")));
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
 * The guard's family (TABLE r4.182; Codex r1–r3 on #1360, r4–r5 on #1369): each form, in each layout, by what the
 * closed list makes of it. A recognised creation must be listed; a reference to a guarded member in any other form is
 * unproved, by the name it contains, counted exactly (the files as they are have none); a name two derivations share is
 * reported; an exact forwarder is its function's.
 */
const UNPROVED_AT = (label) => `Unproved: ${label} is named`;
const OUTSIDE = "An obligation is created outside";
const CREATES = "(error: () => void): void {\n    error();\n  }";
const PUSHED = "undefined as never";
/** Members of the class, the single-file layout: [the name, the member, what it gives]. */
const MEMBER_FORMS = [
  // (recognised creations: an `error` parameter's call, `boundaryCheck(…)`, `R.readChecks.push(…)`)
  ["probeMethod", `public probeMethod${CREATES}`, "creates"],
  [
    "probeGetter",
    'get probeGetter(): number {\n    boundaryCheck({ file: 0, start: 0, end: 0 }, "x", [], "y");\n    return 0;\n  }',
    "creates",
  ],
  ["probePush", `public probePush(): void {\n    this.readChecks.push(${PUSHED});\n  }`, "creates"],
  ["probeArrow", "probeArrow = (error: () => void): void => {\n    error();\n  };", "creates"],
  ["probeQuoted", `"probeQuoted"${CREATES}`, "creates"],
  ["probeComputed", `["probeComputed"]${CREATES}`, "creates"],
  // (a property no closed form makes a derivation: its creation is outside every derivation)
  [
    "probeWrapped",
    "probeWrapped = ((error: () => void): void => {\n    error();\n  }) satisfies unknown;",
    OUTSIDE,
  ],
  // (`readChecks` in other forms: each reference unproved; Codex r4 B2, r5 B1)
  [
    "probeQuotedArray",
    `public probeQuotedArray(): void {\n    this["readChecks"].push(${PUSHED});\n  }`,
    1,
  ],
  [
    "probeQuotedPush",
    `public probeQuotedPush(): void {\n    this.readChecks["push"](${PUSHED});\n  }`,
    1,
  ],
  [
    "probeAliasArray",
    `public probeAliasArray(): void {\n    const checks = this.readChecks;\n    checks.push(${PUSHED});\n  }`,
    1,
  ],
  [
    "probePushCall",
    `public probePushCall(): void {\n    const { push } = this.readChecks;\n    push.call(this.readChecks, ${PUSHED});\n  }`,
    2,
  ],
  [
    "probePushApply",
    `public probePushApply(): void {\n    const { push } = this.readChecks;\n    push.apply(this.readChecks, [${PUSHED}]);\n  }`,
    2,
  ],
  [
    "probeDestructured",
    `public probeDestructured(): void {\n    const { readChecks } = this;\n    readChecks.push(${PUSHED});\n  }`,
    1,
  ],
  // (an assignment's destructuring, and a for-of's, Codex r6 B1)
  [
    "probeAssignedArray",
    `public probeAssignedArray(): void {\n    let readChecks: unknown[] = [];\n    ({ readChecks } = this);\n    readChecks.push(${PUSHED});\n  }`,
    1,
  ],
  [
    "probeAssignedFor",
    `public probeAssignedFor(): void {\n    let checks: unknown[] = [];\n    for ({ readChecks: checks } of [this]) checks.push(${PUSHED});\n  }`,
    1,
  ],
];
/** `error` parameters in other forms, members and top-level functions: each unproved. */
const ERROR_FORMS = [
  "public probeErrorCall(error: () => void): void {\n    error.call(undefined);\n  }",
  "public probeErrorApply(error: () => void): void {\n    error.apply(undefined, []);\n  }",
];
/** Top-level forms of the entry: [the report's start, the form]. */
const ENTRY_FORMS = [
  [
    "Admission.reject names 2 derivations",
    "function reject(admission: Admission): void {\n  void admission;\n}",
  ],
  [OUTSIDE, "function probeOutside(error: () => void): void {\n  error();\n}"],
  [OUTSIDE, "class ProbeNested {\n  run(error: () => void): void {\n    error();\n  }\n}"],
  [
    UNPROVED_AT("an error parameter"),
    "function probeOutsideCall(error: () => void): void {\n  error.call(undefined);\n}",
  ],
];
/** Functions of a part, the split layout: [the report's start, the declaration]. */
const PART_FORMS = [
  [
    "Admission.probePart creates",
    "export function probePart(admission: Admission, error: () => void): void {\n  void admission;\n  error();\n}",
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
    "export const probeConst = ((admission: Admission, error: () => void): void => {\n  void admission;\n  error();\n}) satisfies unknown;",
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
  // (exact)
  [
    "probeExact",
    "public probeExact(value: number): number {\n    return probeExact(this, value);\n  }",
    false,
  ],
  // (no closed form: wrappers, a quoted name, or wrong in one way)
  [
    "probeParens",
    "public probeParens(value: number): number {\n    return (probeParens)(this, value);\n  }",
    true,
  ],
  [
    "probeWrappedCall",
    "public probeWrappedCall(value: number): number {\n    return (probeWrappedCall(this, value));\n  }",
    true,
  ],
  [
    "probeQuotedName",
    'public "probeQuotedName"(value: number): number {\n    return probeQuotedName(this, value);\n  }',
    true,
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
// (an exact forwarder handing on its `error` parameter: its argument, no value read)
const ERROR_FORWARDER = [
  "public probeErrorForward(error: () => void): void {\n    probeErrorForward(this, error);\n  }",
  "export function probeErrorForward(admission: Admission, error: () => void): void {\n  void admission;\n  error();\n}",
];
const forwarded = (name) =>
  `export function ${name}(admission: Admission, a: number, b = 0): number {\n  void admission;\n  return a + b;\n}`;
const importing = (names, from) => `import { ${names.join(", ")} } from "${from}";\n`;

test("the single-file layout: each recognised creation must be listed; every other form of a guarded name is unproved", () => {
  const messages = messagesWith(
    edits(
      [
        ADMISSION,
        (text) =>
          `${ADMISSION_IMPORTS}${text.replace(
            MEMBERS,
            [...MEMBER_FORMS.map(([, member]) => member), ...ERROR_FORMS]
              .map((member) => `  ${member}\n\n`)
              .join("") + MEMBERS,
          )}\n${ENTRY_FORMS.map(([, form]) => form).join("\n\n")}\n`,
      ],
      ...BOUNDARY_EXPORT,
    ),
  );
  for (const [name, , gives] of MEMBER_FORMS)
    if (gives === "creates") expectStart(messages, `Admission.${name} creates`);
  for (const [start] of ENTRY_FORMS) expectStart(messages, start);
  const readChecks = MEMBER_FORMS.reduce(
    (sum, [, , gives]) => sum + (typeof gives === "number" ? gives : 0),
    0,
  );
  expectCount(messages, UNPROVED_AT("Admission.readChecks"), readChecks);
  expectCount(messages, UNPROVED_AT("an error parameter"), ERROR_FORMS.length + 1);
  expectCount(messages, OUTSIDE, 3);
});

test("the split layout: each function taking the instance is a derivation; only an exact forwarder is its function's", () => {
  const messages = messagesWith(
    {
      [ADMISSION]: (text) =>
        importing(
          [...FORWARDERS.map(([name]) => name), "probeErrorForward"],
          "./admission/probe.js",
        ) +
        text.replace(
          MEMBERS,
          [...FORWARDERS.map(([, member]) => member), ERROR_FORWARDER[0]]
            .map((member) => `  ${member}\n\n`)
            .join("") + MEMBERS,
        ),
    },
    {
      [PART]: `${PART_HEAD}\n${[...PART_FORMS.map(([, form]) => form), ...FORWARDERS.map(([name]) => forwarded(name)), ERROR_FORWARDER[1]].join("\n\n")}\n`,
    },
  );
  for (const [start] of PART_FORMS) expectStart(messages, start);
  expectCount(messages, OUTSIDE, 3);
  for (const [name, , reported] of FORWARDERS)
    expectStart(messages, `Admission.${name} names 2 derivations`, reported);
  expectStart(messages, "Admission.probeErrorForward creates");
  expectStart(messages, "Admission.probeErrorForward names 2 derivations", false);
  expectStart(messages, UNPROVED_AT("an error parameter"), false);
});

/** A creating consumer's calls into unlisted derivations: [the name, the statement, the report's start]. */
const ROUTES = [
  // (direct calls, the closed forms: listed or reported as unlisted)
  ["routeMethod", `${SELF}.admission.routeMethod();`, "calls"],
  ["routeDirect", `routeDirect(${SELF}.admission);`, "calls"],
  ["routeAlias", `aliased(${SELF}.admission);`, "calls"],
  // (every other form: unproved by its name)
  ["routeQuoted", `${SELF}.admission["routeQuoted"]();`, "unproved"],
  ["routeNamespace", `probe.routeNamespace(${SELF}.admission);`, "unproved"],
  ["routeParens", `(routeParens)(${SELF}.admission);`, "unproved"],
  ["routeCall", `routeCall.call(undefined, ${SELF}.admission);`, "unproved"],
  ["routeApply", `routeApply.apply(undefined, [${SELF}.admission]);`, "unproved"],
];
/** More forms in the fresh pass, each unproved by its name: [the label, the statement]. */
const VALUES = [
  ["Admission.routeMethod", `const stored = ${SELF}.admission.routeMethod;\n    void stored;`],
  ["Admission.routeQuoted", `const quoted = ${SELF}.admission["routeQuoted"];\n    void quoted;`],
  ["Admission.reject", `const { reject } = ${SELF}.admission;\n    void reject;`],
  [
    "Admission.sourceOrder",
    `const { ["sourceOrder"]: order } = ${SELF}.admission;\n    void order;`,
  ],
  ["Admission.probeMaybe", `const maybe = ${SELF}.admission.probeMaybe;\n    maybe?.();`],
  ["Admission.probeOpaque", `const { admission: { probeOpaque } } = ${SELF};\n    probeOpaque();`],
  // (a listed getter's destructuring: only its dot read is a listed read, N1)
  ["Admission.probeKnown", `const { probeKnown } = ${SELF}.admission;\n    void probeKnown;`],
  // (a listed read's form in a file it is not listed for)
  ["Admission.readChecks", `for (const check of ${SELF}.admission.readChecks) void check;`],
  // (assignments' destructurings: shorthand, quoted, nested, a for-of's, Codex r6 B1)
  [
    "Admission.groups",
    `let groups: unknown;\n    ({ groups } = ${SELF}.admission);\n    void groups;`,
  ],
  [
    "Admission.cellSited",
    `let cell: unknown;\n    ({ "cellSited": cell } = ${SELF}.admission);\n    void cell;`,
  ],
  [
    "Admission.contributionSited",
    `let contribution: unknown;\n    ({ admission: { contributionSited: contribution } } = ${SELF});\n    void contribution;`,
  ],
  [
    "Admission.compareLanded",
    `let landed: unknown;\n    for ({ compareLanded: landed } of [${SELF}.admission]) void landed;`,
  ],
  // (a namespace's shorthand binding of a moved derivation, Codex r6 B1)
  [
    "Admission.probeShorthand",
    `{\n      const { probeShorthand } = probe;\n      probeShorthand(${SELF}.admission);\n    }`,
  ],
  // (a constructor's parameter property, Codex r6 B2)
  ["Admission.host", `const host = ${SELF}.admission.host;\n    void host;`],
  // (an overloaded derivation read as a value, Codex r6 B3)
  ["Admission.probeOverloaded", "const overloaded = probeOverloaded;\n    void overloaded;"],
  // (a setter alone, though listed, Codex r6 B4)
  [
    "Admission.probeSetOnly",
    `${SELF}.admission.probeSetOnly = 1;\n    void ${SELF}.admission.probeSetOnly;`,
  ],
  // (a shorthand property's value)
  ["Admission.routeDirect", "const bag = { routeDirect };\n    void bag;"],
  // (a class's `extends` expression is a value position: a member, a namespace's moved derivation, Codex r7 B1)
  [
    "Admission.probeBase",
    `class ProbeDerived extends ${SELF}.admission.probeBase {}\n    void ProbeDerived;`,
  ],
  [
    "Admission.probeBaseMoved",
    `class ProbeMovedBase extends probe.probeBaseMoved(${SELF}.admission) {}\n    void ProbeMovedBase;`,
  ],
];
/**
 * The type/value boundary (#1401, #1527): [the label, the statement, how many unproved references it holds, the
 * top-level declarations it names, if any].
 */
const TYPE_VALUE = [
  // (an instantiation expression is a value, its type arguments types: a member's, a namespace's moved derivation's,
  // called in an `extends` expression)
  ["Admission.probeCtor", `const Ctor = ${SELF}.admission.probeCtor<number>;\n    void Ctor;`, 1],
  [
    "Admission.probeCtor",
    `const KeyedCtor = ${SELF}.admission.probeCtor<typeof ${SELF}.admission.probeKey>;\n    void KeyedCtor;`,
    1,
  ],
  [
    "Admission.probeInstantiated",
    "const make = probe.probeInstantiated<number>;\n    void make;",
    1,
  ],
  [
    "Admission.probeInstantiated",
    `class ProbeInstantiated extends (probe.probeInstantiated<number>)(${SELF}.admission) {}\n    void ProbeInstantiated;`,
    1,
  ],
  // (an `implements` heritage names a type: here the interface merged with the moved derivation, Codex r1 N1)
  [
    "Admission.probeInstantiated",
    "class ProbeImplements implements probe.probeInstantiated<number> {}\n    void ProbeImplements;",
    0,
  ],
  // (an interface emits nothing, its computed keys included, as a type literal's; the key's value read beside them,
  // and a class's computed key, which is evaluated, Codex r1 N2)
  [
    "Admission.probeKey",
    `interface ProbeKeyed {\n      [${SELF}.admission.probeKey]: number;\n    }\n    let keyed: ProbeKeyed | undefined;\n    void keyed;`,
    0,
  ],
  [
    "Admission.probeKey",
    `type ProbeKeyedLiteral = { [${SELF}.admission.probeKey]: number };\n    let keyedLiteral: ProbeKeyedLiteral | undefined;\n    void keyedLiteral;`,
    0,
  ],
  ["Admission.probeKey", `void ${SELF}.admission.probeKey;`, 1],
  [
    "Admission.probeKey",
    `class ProbeKeyedClass {\n      [${SELF}.admission.probeKey] = 1;\n    }\n    void ProbeKeyedClass;`,
    1,
  ],
  // (code that emits nothing, #1527, under a member of its own so that no report it gives can stand in for an evaluated
  // one's, Codex r1 N1: a `declare` and an `abstract` member's computed key, an overload signature's and an ambient
  // function's destructured parameter; the member's value read beside them)
  ["Admission.probeErased", `void ${SELF}.admission.probeErased;`, 1],
  [
    "Admission.probeErased",
    `class ProbeDeclared {\n      declare [${SELF}.admission.probeErased]: number;\n    }\n    void ProbeDeclared;`,
    0,
  ],
  [
    "Admission.probeErased",
    `abstract class ProbeAbstract {\n      abstract [${SELF}.admission.probeErased]: number;\n    }\n    void ProbeAbstract;`,
    0,
  ],
  [
    "Admission.probeErased",
    "void probeSignature;",
    0,
    "function probeSignature({ probeErased }: Admission): void;\nfunction probeSignature(admission: Admission): void {\n  void admission;\n}\n",
  ],
  [
    "Admission.probeErased",
    "void probeAmbient;",
    0,
    "declare function probeAmbient({ probeErased }: Admission): void;\n",
  ],
  // (evaluated: an overload signature's key beside its implementation's, of which only the implementation's runs; an
  // abstract class's method implementation's key; a decorator's expression; an `override` key with neither body nor
  // initializer, Codex r1 N2)
  [
    "Admission.probeKey",
    `class ProbeOverloadedKey {\n      [${SELF}.admission.probeKey](): void;\n      [${SELF}.admission.probeKey](): void {}\n    }\n    void ProbeOverloadedKey;`,
    1,
  ],
  [
    "Admission.probeKey",
    `abstract class ProbeKeyedMethod {\n      [${SELF}.admission.probeKey](): void {}\n    }\n    void ProbeKeyedMethod;`,
    1,
  ],
  [
    "Admission.probeKey",
    `class ProbeDecorated {\n      @probeDecorate(${SELF}.admission.probeKey) value = 0;\n    }\n    void ProbeDecorated;`,
    1,
    "function probeDecorate(key: string) {\n  return (value: unknown, context: DecoratorContext): void => {\n    void [key, value, context];\n  };\n}\n",
  ],
  [
    "Admission.probeKey",
    `class ProbeKeyedBase {\n      probeKey?: number;\n    }\n    class ProbeKeyedOverride extends ProbeKeyedBase {\n      override [${SELF}.admission.probeKey]?: number;\n    }\n    void ProbeKeyedOverride;`,
    1,
  ],
];
/** Writes and deletions of a listed getter, no read: each unproved (Codex r6 B4, r7 B2). */
const WRITES = [
  `${SELF}.admission.probeKnown = 1;`,
  `${SELF}.admission.probeKnown++;`,
  `${SELF}.admission.probeKnown += 1;`,
  `delete (${SELF}.admission as Partial<Admission>).probeKnown;`,
  `delete ((${SELF}.admission as Partial<Admission>).probeKnown);`,
];
/** Consumers by how they record, each calling its own unlisted derivation: [the consumer, the derivation, the body, creating]. */
const RECORDING = [
  ["probeSelf", "routeSelf", `const self = walk;\n  self.diagnostics.push(${PUSHED});`, true],
  ["probeGetterReader", "routeGetterRead", "void walk.probeRecording;", true],
  ["probeQuotedRecord", "routeQuotedRecord", `walk["diagnostics"].push(${PUSHED});`, false],
  [
    "probeBindingRecord",
    "routeBindingRecord",
    `const { "diagnostics": found } = walk;\n  found.push(${PUSHED});`,
    false,
  ],
  [
    "probeAliasRecord",
    "routeAliasRecord",
    `const list = walk.diagnostics;\n  list.push(${PUSHED});`,
    false,
  ],
  [
    "probeReadOnly",
    "routeReadOnly",
    "const { diagnostics } = walk;\n  void diagnostics.length;",
    false,
  ],
  // (an assignment's destructuring of the array, Codex r6 B1; a getter read after its setter, B3)
  [
    "probeAssignedRecord",
    "routeAssignedRecord",
    `let found: unknown[] = [];\n  ({ diagnostics: found } = walk);\n  found.push(${PUSHED});`,
    false,
  ],
  ["probeSetterFirstReader", "routeSetterFirst", "void walk.probeRecorded;", true],
  [
    "probeQuiet",
    "routeQuiet",
    "class Inner {\n    diagnostics: unknown[] = [];\n    run(): void {\n      this.diagnostics.push(0);\n    }\n  }\n  new Inner().run();",
    false,
  ],
];

test("a creating consumer's direct calls must be listed; every other form of a guarded name is unproved; the fresh pass runs one derivation by identity", () => {
  const forwarded = ["routeMethod", "routeQuoted", ...RECORDING.map(([, route]) => route)];
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
              // (callables no derivation is)
              "  probeOpaque = (() => () => 0)();\n\n  probeMaybe: (() => number) | undefined = (() => () => 0)();\n\n",
              "  get probeKnown(): number {\n    return 0;\n  }\n\n  set probeKnown(value: number) {\n    void value;\n  }\n\n",
              "  set probeSetOnly(value: number) {\n    void value;\n  }\n\n",
              "  probeUnionRead = 0;\n\n  probeBase = class {};\n\n",
              '  probeCtor = class<T> {\n    value?: T;\n  };\n\n  public readonly probeKey = "probeKey";\n\n  public readonly probeErased = "probeErased";\n\n',
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
        CONSUMERS,
        (text) =>
          text.replace(
            CONSUMER_MEMBERS,
            `  get probeRecording(): number {\n    this.diagnostics.push(${PUSHED});\n    return 0;\n  }\n\n  set probeRecorded(value: number) {\n    void value;\n  }\n\n  get probeRecorded(): number {\n    this.diagnostics.push(${PUSHED});\n    return 0;\n  }\n\n${CONSUMER_MEMBERS}`,
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
              "probeOverloaded",
            ],
            `${FRESH_TO_ADMISSION}/probe.js`,
          ) +
          `import * as probe from "${FRESH_TO_ADMISSION}/probe.js";\n` +
          text.replace(
            FRESH_START,
            `${FRESH_START}${[...ROUTES, ...VALUES, ...TYPE_VALUE, ...WRITES.map((write) => [, write])].map(([, statement]) => `    ${statement}\n`).join("")}    ${SELF}.admission.probeOpaque();\n    void ${SELF}.admission.probeKnown;\n    probeOverloaded(${SELF}.admission);\n    runAliased(${SELF}.admission);\n    freshDecoy();\n    freshShared(${SELF});\n`,
          ) +
          // (an unrecognised decoy; a recognised one of a derivation's name)
          "\nfunction freshDecoy(): void {}\nfunction freshShared(walk: Consumers): void {\n  void walk;\n}\n" +
          RECORDING.map(consumerFunction).join("") +
          TYPE_VALUE.map(([, , , declarations = ""]) => declarations).join("") +
          // (a parameter's destructuring; references outside every consumer derivation)
          `export function probeParameter({ diagnostics }: Consumers): void {\n  diagnostics.push(${PUSHED});\n}\n` +
          "interface ProbeView {\n  admission: Admission;\n}\n" +
          "export function probeOutsideRead(view: ProbeView): void {\n  const read = view.admission.routeSelf;\n  void read;\n}\n" +
          "export function probeOutsideCall(view: ProbeView): void {\n  view.admission.routeSelf();\n}\n" +
          "export function probeOutsideBinding({ probeOpaque }: Admission): void {\n  probeOpaque();\n}\n" +
          // (a union's member, its symbol made of the class's)
          "export function probeUnionReader(view: Admission | { probeUnionRead: number }): void {\n  void view.probeUnionRead;\n}\n",
      ],
    ),
    {
      [PART]: `${PART_HEAD}\n${[
        ...ROUTES.map(([name]) => name),
        ...RECORDING.map(([, route]) => route),
        "freshAliased",
        "freshDecoy",
        "freshShared",
        "probeShorthand",
      ]
        .filter((name, index, list) => list.indexOf(name) === index)
        .map(unlisted)
        .join(
          "\n\n",
        )}\n\nexport function probeBaseMoved(admission: Admission) {\n  void admission;\n  return class {};\n}\n\nexport function probeInstantiated<T>(admission: Admission) {\n  void admission;\n  return class {\n    value?: T;\n  };\n}\n\nexport interface probeInstantiated<T> {\n  value?: T;\n}\n\n// (an overloaded derivation, Codex r6 B3)\nexport function probeOverloaded(admission: Admission): number;\nexport function probeOverloaded(admission: Admission): number {\n  void admission;\n  return 0;\n}\n`,
    },
    new Map([...READS, ["probeKnown", "a getter read"], ["probeSetOnly", "a setter alone"]]),
  );
  for (const [name, , gives] of ROUTES) {
    expectStart(messages, `${FRESH_LABEL} calls Admission.${name}:`, gives === "calls");
    if (gives === "unproved") expectStart(messages, UNPROVED_AT(`Admission.${name}`));
  }
  expectStart(messages, UNPROVED_AT("Admission.routeAlias"));
  for (const [label] of VALUES) expectStart(messages, UNPROVED_AT(label));
  for (const label of new Set(TYPE_VALUE.map(([label]) => label)))
    expectCount(
      messages,
      UNPROVED_AT(label),
      TYPE_VALUE.reduce((sum, [at, , n]) => sum + (at === label ? n : 0), 0),
    );
  expectStart(messages, "Unproved: Admission.probeOpaque is called but is no derivation");
  expectCount(messages, UNPROVED_AT("Admission.probeOpaque"), 2);
  // (the listed getter's dot read is quiet, as a listed read; its destructuring, writes and deletions are not)
  expectCount(messages, UNPROVED_AT("Admission.probeKnown"), 1 + WRITES.length);
  expectStart(messages, `${FRESH_LABEL} calls Admission.probeKnown:`, false);
  // (an overloaded derivation's call reaches it, Codex r6 B3)
  expectStart(messages, `${FRESH_LABEL} calls Admission.probeOverloaded:`);
  for (const [name, route, , creating] of RECORDING)
    expectStart(messages, `Consumers.${name} calls Admission.${route}:`, creating);
  // (the quoted, destructured, assigned, aliased and parameter forms of a recording array, and the read alone)
  expectCount(messages, UNPROVED_AT("Consumers.diagnostics"), 6);
  expectStart(messages, UNPROVED_AT("Admission.routeSelf"));
  expectStart(messages, UNPROVED_AT("Admission.probeUnionRead"));
  // (a setter alone is written and read: each unproved)
  expectCount(messages, UNPROVED_AT("Admission.probeSetOnly"), 2);
  expectStart(
    messages,
    "Unproved: Admission.routeSelf is called outside every consumer derivation",
  );
  expectStart(messages, UNPROVED_AT("Admission.freshAliased"));
  expectStart(messages, "The fresh pass does not call freshDecoy");
  expectStart(messages, "The fresh pass does not call freshAliased", false);
  expectStart(
    messages,
    "OBLIGATION_SITES lists freshShared for freshShared, which names 2 derivations",
  );
});
