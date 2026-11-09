import { readFileSync } from "node:fs";
import { Project, ts } from "ts-morph";

import { CONFIGURED, chargedIterationDiagnostics } from "./check-charged-iteration.mjs";

/** The fixture project's other files: stubs of the declarations the cases import, and the real helpers. */
const STUBS = {
  "src/type-inference/core/budget.ts": `export type WorkCounter = "objectSteps";
export class WorkLedger {
  #n = 0;
  charge(_counter: WorkCounter, _units = 1): void { this.#n += 1; }
}
export function joinParts(...parts: readonly (string | number | readonly string[])[]): string { return parts.length > 0 ? "|" : ""; }
export function keptArray<T>(_work: WorkLedger, steps: readonly T[]): readonly T[] { return steps; }
export function keptParts(_work: WorkLedger, ...parts: readonly (string | readonly string[])[]): string { return parts.length > 0 ? "|" : ""; }
`,
  "src/type-inference/core/definitions.ts": `export function sortCost(n: number): number { return n; }
export function keyOf(place: number, path: readonly string[]): string { return path.length === 0 ? String(place) : "|"; }
export function keyBelow(key: string, rest: readonly string[]): string { return rest.length === 0 ? key : "|"; }
export function keyPath(key: string): string[] { return key.split("."); }
`,
  "src/type-inference/core/contract/kinds.ts": `export interface Item { readonly tag: string }
export function heldReference(items: readonly Item[]): boolean { return items.length > 0; }
`,
  "src/type-inference/core/barrel.ts": `export { joinParts as renamed } from "./budget.js";
export * as api from "./budget.js";
`,
  "src/type-inference/core/other.ts": `export class Other {
  #n = 0;
  readonly length = 1;
  get text(): string { return "x"; }
  at(_index: number): string { return "x"; }
  *[Symbol.iterator](): Generator<string> { yield "x"; }
}
`,
  "src/type-inference/core/contract/key-ids.ts": `export class PathSteps {
  readonly #raw: readonly string[];
  readonly length: number;
  constructor(raw: readonly string[]) { this.#raw = raw; this.length = raw.length; }
  at(index: number): string | undefined { return this.#raw[index]; }
}
export interface KeyWalk {
  readonly path: readonly string[] | PathSteps;
  prefix(length: number): string;
}
export function keyWalk(key: string): KeyWalk { return { path: [], prefix: () => key }; }
export function isPathSteps(steps: readonly string[] | PathSteps): steps is PathSteps { return steps instanceof PathSteps; }
`,
};
const ITERATION = readFileSync(
  new URL("../../src/type-inference/core/charged-iteration.ts", import.meta.url),
  "utf8",
);
/** The rules a message names: the language's tag, or the retained rule's. */
const RETAINED = [
  ["is handed a collection", "retained-collection"],
  ["is used as a value", "retained-value"],
  ["is not in OUTSIDE", "retained-outside"],
  ["spread", "retained-spread"],
  ["opaque local callable", "retained-opaque"],
  ["unresolved call escapes", "retained-unresolved"],
  ["function body goes uncharged", "retained-entry"],
  ["computed member", "retained-computed"],
  ["converts an object to text", "retained-text"],
  ["constructor alias", "retained-constructor"],
  ["walks its argument uncharged", "retained-walking-constructor"],
];
const ruleOf = (message) =>
  /\[([a-z-]+)\]/.exec(message)?.[1] ??
  RETAINED.find(([text]) => message.includes(text))?.[1] ??
  `unknown: ${message.slice(0, 60)}`;

/** The rules the configured checker rejects `source` by, as `objects.ts`, sorted; `[]` where it admits it. */
export function objectsRules(source) {
  const project = new Project({
    useInMemoryFileSystem: true,
    compilerOptions: {
      strict: true,
      target: ts.ScriptTarget.ES2023,
      module: ts.ModuleKind.ESNext,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
      lib: ["lib.es2023.d.ts"],
    },
  });
  for (const [file, text] of Object.entries(STUBS)) project.createSourceFile(`/repo/${file}`, text);
  project.createSourceFile(`/repo/${CONFIGURED.iteration}`, ITERATION);
  const objects = CONFIGURED.files.find((file) => file.endsWith("/objects.ts"));
  for (const file of CONFIGURED.files)
    if (file !== objects) project.createSourceFile(`/repo/${file}`, "export {};\n");
  project.createSourceFile(`/repo/${objects}`, source);
  return chargedIterationDiagnostics(project.getProgram().compilerObject, "/repo", CONFIGURED)
    .filter(({ fileName }) => fileName.endsWith("/objects.ts"))
    .map(({ message }) => ruleOf(message))
    .sort();
}
