import assert from "node:assert/strict";
import test from "node:test";

import {
  checkRetainedState,
  retainedStateDiagnostics,
  scratchProgram,
} from "./check-retained-state.mjs";
import { repositoryRoot } from "./files.mjs";

/** The retained API, imported at a scratch file's end so that its lines keep their numbers. */
const API = '\nimport { Retained, retainedModule } from "./retained/retained.js";\n';

/**
 * The check's diagnostics for scratch files, each `{ name, text, level }` placed in the type core (or the test helpers),
 * read in one program; by file name, each a sorted list of reported lines.
 */
function scratch(files) {
  const placed = files.map(({ name, text, level }) => ({
    file:
      level === "helper"
        ? `tests/helpers/${name}.ts`
        : `src/type-inference/core/${name}.${name.endsWith("-mts") ? "mts" : "ts"}`,
    text: `${text}${level === "helper" ? API.replace("./retained/", "../../src/type-inference/core/retained/") : API}`,
    level,
  }));
  const program = scratchProgram(repositoryRoot, placed);
  const diagnostics = retainedStateDiagnostics(
    program,
    repositoryRoot,
    new Map(placed.map(({ file, level }) => [file, level])),
  );
  return new Map(
    placed.map(({ file }, index) => [
      files[index].name,
      diagnostics
        .filter((diagnostic) => diagnostic.fileName === file)
        .map(({ line }) => line)
        .sort((x, y) => x - y),
    ]),
  );
}

/** The lines `text`'s `// refused` markers name, a line once per marker word (`// refused refused`). */
const marked = (text) =>
  text
    .split("\n")
    .flatMap((line, index) =>
      Array.from(
        {
          length: (/\/\/ (refused(?: refused)*)$/u.exec(line)?.[1] ?? "").split(" ").filter(Boolean)
            .length,
        },
        () => index + 1,
      ),
    );

/** One scratch file's reported lines, against its markers. */
function assertMarked(text, level = "file") {
  assert.deepEqual(scratch([{ name: "scratch", text, level }]).get("scratch"), marked(text));
}

test("the type core passes the check, its files read from the program the compiler builds (#1072)", () => {
  assert.deepEqual(checkRetainedState(repositoryRoot), []);
});

test("a collection made where an owner can keep it is refused, in every such place (#1072)", () => {
  assertMarked(
    [
      "class Owner {",
      "  readonly byKey = new Map<string, number>(); // refused",
      // (a collection kept as made, and a private field the instrument cannot see)
      "  readonly #hidden = new Set<string>(); // refused refused",
      "  readonly pair = [new WeakMap<object, number>(), new WeakMap<object, number>()]; // refused refused",
      "  readonly caches = { summaries: new WeakSet<object>() }; // refused",
      "  public constructor(readonly given: Map<string, number> = new Map()) { // refused",
      "    this.later = new Map(); // refused",
      "  }",
      "  public fill(outer: Map<string, Map<string, number>>, key: string): void {",
      "    this.lazy ??= new Set(); // refused",
      "    this.nested = { inner: new Map() }; // refused",
      "    captured = { passes: new WeakMap() }; // refused",
      "  }",
      "}",
      "const mutable = new Map<string, number>(); // refused",
      "let table = new Set([1, 2]); // refused",
      "let captured: object | null = null;",
      "function chained(owner: { slots: Map<string, number>[] }): void {",
      "  let steps: Map<string, number> | undefined;",
      "  owner.slots[0] = steps = new Map(); // refused",
      "}",
      // (a native constructor is the one the checker resolves, under any name)
      "const Native = Map;",
      "const aliased = new Native<string, number>(); // refused",
    ].join("\n"),
  );
});

test("a collection that stands where no owner keeps it as made passes (#1072)", () => {
  assertMarked(
    [
      "const TABLE: ReadonlySet<string> = new Set(['a', 'b']);",
      "const ROWS: ReadonlyMap<string, number> = new Map([['a', 1]]);",
      "function local(list: readonly string[], seen?: Set<string>): number {",
      "  const counts = new Map<string, number>();",
      "  const unique = seen ?? new Set<string>();",
      "  for (const each of new Set(list)) counts.set(each, 1);",
      "  use(new Map(counts), [...new Set(list)]);",
      "  if (new Set(list).has('a')) return counts.size;",
      "  let later: Set<string>;",
      "  later = new Set();",
      "  return (unique.size + later.size) as number;",
      "}",
      "const make = (): Map<string, number> => new Map();",
      "function build(): Set<string> {",
      "  return new Set();",
      "}",
      "function withDefault(seen: Set<string> = new Set()): number {",
      "  return seen.size;",
      "}",
      // (a class of its own named `Map` is no native collection)
      "class Mapping<K, V> { readonly entries: [K, V][] = []; }",
      "class Holder { readonly made = new Mapping<string, number>(); }",
    ].join("\n"),
  );
});

test("a file scoped at its top level is checked there only: its classes keep no retained state (#1072)", () => {
  const text = [
    "class Answers {",
    "  readonly byKey = new Map<string, number>();",
    "  #lazy: Map<string, number> | null = null;",
    "}",
    "const captured = new Map<string, number>(); // refused",
  ].join("\n");
  assertMarked(text, "module");
});

test("a private field is readonly and made by a maker the checker resolves, or exposed by its class's `hidden`, or refused (#1072)", () => {
  assertMarked(
    [
      "class Owner {",
      "  readonly #made = Retained.map<string, number>('Owner.#made');",
      "  #lazy: Map<string, number> | null = null; // refused",
      "  #size: Set<string> | null = null; // refused",
      "  readonly #given: Owner | null;",
      "  #slot = Retained.set<string>('Owner.#slot'); // refused",
      "  public constructor(given: Owner | null) {",
      "    this.#given = given;",
      "    Retained.owner(this, 'Owner', (owner) => ({ lazy: owner.#lazy, size: owner.#size?.size, given: owner.#given }));",
      "  }",
      "}",
      "class Static {",
      "  static readonly #hidden = (owner: Static) => ({ count: owner.#count, seen: owner.#seen });",
      "  #count = 0; // refused",
      "  readonly #seen = 0;",
      "  #other = 0; // refused",
      "  public constructor() {",
      "    Retained.owner(this, 'Static', Static.#hidden);",
      "  }",
      "}",
      "class GuardIndex {",
      "  #narrowing = null;",
      "  #queries = null;",
      "  #other = null; // refused",
      "}",
      "class Unregistered {",
      "  #state = 0; // refused",
      "}",
      "class Held {",
      "  readonly #payload = Retained.held(this, Retained.map<string, number>('Held.#payload')); // refused",
      "}",
      // (a maker by its resolved declaration, however it is reached)
      "const { record } = Retained;",
      "const api = { Retained };",
      "class Reached {",
      "  readonly #alias = record('Reached.#alias', { n: 0 });",
      "  readonly #carried = api.Retained.arena<number>('Reached.#carried');",
      "}",
      // (a call that resolves to no maker, or to none, is not one)
      "const Shadow = { map: () => new Map<string, number>() };",
      "declare const untyped: any;",
      "class Unresolved {",
      "  readonly #shadowed = Shadow.map(); // refused",
      "  readonly #untyped = untyped.map('Unresolved.#untyped'); // refused",
      "}",
    ].join("\n"),
  );
});

test("the indexed program's own classes give each private field to the program walk (#1072 R61)", () => {
  const text = [
    "class Indexed {",
    "  readonly #byId = new Map<number, string>();",
    "  readonly #order: number[] = [];",
    "  readonly #missed = new Set<number>(); // refused",
    "  #counted = 0; // refused",
    "  public index(): void {",
    "    Retained.programPart(this, (part) => ({ byId: part.#byId, order: part.#order, counted: part.#counted }));",
    "  }",
    "}",
  ].join("\n");
  assert.deepEqual(
    scratch([{ name: "scratch", text, level: "program" }]).get("scratch"),
    marked(text),
  );
});

test("the meta-object layer is closed in type inference: `Object`'s listed members, assignment and a kind's own methods alone (#1072 R30)", () => {
  // (one line per refused form, each refused alone)
  const refused = [
    "Reflect.set(value, 'n', 1);",
    "Reflect.get(value, 'n');",
    "if (Object.isFrozen(value)) skip();",
    "Object.isSealed(value);",
    "Object.isExtensible(value);",
    "Object.getOwnPropertyDescriptor(value, 'n');",
    "Object.getPrototypeOf(map).set.call(map, 'x', 1);",
    "Object.setPrototypeOf(value, null);",
    "Object.defineProperty(value, 'n', { get: () => 1 });",
    "const define = Object.defineProperty;",
    "const { defineProperties } = Object;",
    "Reflect['defineProperty'](value, 'n', { value: 1 });",
    "value.__defineGetter__('n', () => 1);",
    "value.__defineSetter__('n', () => {});",
    "delete value.n;",
    "map.prototype;",
    "value.__proto__;",
    "value['__proto__'];",
    "map.constructor;",
    "value['constructor'];",
    "const { prototype } = Map;",
    "const { constructor: made } = value;",
    "const O = Object;",
    "Object[name](value);",
    "globalThis.Object;",
    "new Function('return 1');",
    "eval('1');",
    "class Owner { constructor() { return existing; } }",
  ];
  // (a control per form left open: each listed member of `Object`, assignment, a kind's own method, a nested
  // function's return in a constructor, and the refused names where they name no value)
  const passed = [
    "Object.freeze(value);",
    "Object.hasOwn(value, 'n');",
    "Object.keys(value).length;",
    "Object.values(value);",
    "Object.entries(value);",
    "Object.fromEntries([]);",
    "Object.assign(value, { n: 1 });",
    "Object.is(value, other);",
    "value.n = 1;",
    "const { n, ...rest } = value; const spread = { ...value, n: 2 };",
    "map.set('x', 1); map.delete('x');",
    "class Owner { constructor() { const make = () => { return 1; }; this.n = make(); } }",
    "type Keys = keyof typeof value; const shown: Record<string, number> = { constructor: 1, eval: 2 };",
    "interface Shape { prototype: number; Reflect(): void }",
  ];
  const files = [];
  for (const level of ["file", "module", null, "meta", "helper"])
    for (const [index, form] of [...refused, ...passed].entries())
      files.push({ name: `scratch-${String(level)}-${index}`, text: form, level });
  const found = scratch(files);
  for (const { name, text, level } of files) {
    const expected = level !== "helper" && refused.includes(text) ? [1] : [];
    assert.deepEqual([...new Set(found.get(name))], expected, `${level}: ${text}`);
  }
});

test("the retained API's own folder is the trusted implementation the meta-object and `catch` lines leave out (#1072 R46)", () => {
  const program = scratchProgram(repositoryRoot, [
    {
      file: "src/type-inference/core/retained/scratch.ts",
      text: "export const copy = (given: object): object => Object.assign(Object.create(Object.getPrototypeOf(given)), given);",
    },
  ]);
  assert.deepEqual(
    retainedStateDiagnostics(
      program,
      repositoryRoot,
      new Map([["src/type-inference/core/retained/scratch.ts", null]]),
    ),
    [],
  );
});

test("a `catch` handles only type inference's own errors, and a `finally` completes normally (#1072 R60)", () => {
  const classes = [
    "class Stop extends Error {}",
    "class Decline extends Error {}",
    "class Nested extends Stop {}",
    "class Native extends TypeError {}",
    "declare function work(): void;",
    "declare function cleanup(): void;",
  ].join("\n");
  // (one function per refused form: its first line the refused `catch` or exit)
  const refused = [
    // (the design check's witness: V8's refusal of a frozen write, handled by its class)
    "function f() { try { work(); } catch (error) { if (error instanceof TypeError) return; throw error; } }",
    "function f() { try { work(); } catch (error) { if (error instanceof Error) return; throw error; } }",
    "function f() { try { work(); } catch (error) { if (error instanceof Native) return; throw error; } }",
    "function f() { try { work(); } catch (error) { if (error instanceof Nested) return; throw error; } }",
    "function f() { try { work(); } catch { return; } }",
    "function f() { try { work(); } catch (error) { cleanup(); } }",
    "function f() { try { work(); } catch (error) { return; } }",
    "function f() { try { work(); } catch (error) { if (error instanceof Error) throw new Stop(); throw error; } }",
    "function f() { try { work(); } catch (error) { if (ready()) return; if (!(error instanceof Stop)) throw error; } }",
    "function f() { try { work(); } catch (error) { throw new Stop(); } }",
    // (the final review's witness, R67: a consumer that stops at the `yield` closes the generator before the rethrow)
    "function* f() { try { work(); yield 1; } catch (error) { yield -1; throw error; } }",
    // (the design check's other witness: a pending error replaced by a generator's `finally`)
    "function* f() { try { work(); } finally { yield 0; } }",
    "function f() { try { work(); } finally { return; } }",
    "function f() { for (;;) { try { work(); } finally { break; } } }",
    "function f() { for (;;) { try { work(); } finally { continue; } } }",
    "function f() { try { work(); } finally { throw new Stop(); } }",
  ];
  // (a control per form: a class of type inference's own, a guard, a translation under its test, a cleanup that
  // rethrows, a `finally` that only cleans up)
  const passed = [
    "function f() { try { work(); } catch (error) { if (error instanceof Stop) return; throw error; } }",
    "function f() { try { work(); } catch (error) { if (!(error instanceof Stop)) throw error; return; } }",
    "function f() { try { work(); } catch (error) { if (!(error instanceof Stop) && !(error instanceof Decline)) throw error; return; } }",
    "function f() { try { work(); } catch (error) { if (!(error instanceof Stop) || ready()) throw error; return; } }",
    "function f() { try { work(); } catch (error) { cleanup(); if (!(error instanceof Stop)) throw error; return; } }",
    "function f() { try { work(); } catch (error) { if (error instanceof Stop) throw new Decline(); throw error; } }",
    "function f() { try { work(); } catch (error) { if (!(error instanceof Stop)) throw error; throw new Decline(); } }",
    "function f() { try { work(); } catch (error) { cleanup(); throw error; } }",
    "function f() { try { work(); } catch (error) { for (const each of [1]) { if (each) break; } throw error; } }",
    "function f() { try { work(); } finally { cleanup(); } }",
    "function* f() { try { work(); } catch (error) { if (error instanceof Stop) { yield -1; return; } throw error; } }",
    "function f() { try { work(); } finally { for (const each of [1]) { if (each) break; } } }",
  ];
  const files = [...refused, ...passed].map((form, index) => ({
    name: `catch-${index}`,
    text: `${form}\n${classes}\ndeclare function ready(): boolean;`,
    level: "file",
  }));
  const found = scratch(files);
  for (const [index, form] of [...refused, ...passed].entries())
    assert.deepEqual(found.get(`catch-${index}`), index < refused.length ? [1] : [], form);
});

test("a class declared outside type inference is not one of its errors (#1072 R60)", () => {
  assertMarked(
    [
      'import { AsyncLocalStorage } from "node:async_hooks";',
      "class Stop extends Error {}",
      "declare function work(): void;",
      "export function f(): void {",
      "  try {",
      "    work();",
      "  } catch (error) { // refused",
      "    if (error instanceof AsyncLocalStorage) return;",
      "    throw error;",
      "  }",
      "}",
      "export function g(): void {",
      "  try {",
      "    work();",
      "  } catch (error) {",
      "    if (error instanceof Stop) return;",
      "    throw error;",
      "  }",
      "}",
    ].join("\n"),
  );
});

test("a function is registered right below the comment naming its captures, its call found by resolution (#1072 R26)", () => {
  assertMarked(
    [
      "declare const frontier: object;",
      "declare const steps: object;",
      "declare function use(value: unknown): void;",
      "// (#1072 R26: captures `frontier`, an owner)",
      "const a = Retained.closure('a', () => frontier);",
      "const b = Retained.closure('b', () => frontier); // refused",
      "// (#1072 R26: as `a`)",
      "const c = Retained.closure('c', () => frontier);",
      "// (#1072 R26: captures `frontier`, an owner, and",
      "// `steps`, fixed when it is made)",
      "use(Retained.closure('d', () => steps));",
      "// a comment naming nothing",
      "use(Retained.closure('e', () => steps)); // refused",
      "const { closure } = Retained;",
      "use(closure('f', () => steps)); // refused",
    ].join("\n"),
  );
});

test("a module the compiler reaches only through another module is read (#1072 R46)", () => {
  const program = scratchProgram(repositoryRoot, [
    {
      file: "src/type-inference/core/scratch-reached.ts",
      text: 'export { kept } from "./scratch-missed.mjs";\n',
    },
    {
      file: "src/type-inference/core/scratch-missed.mts",
      text: "export const kept = Reflect.get({}, 'n');\n",
    },
  ]);
  const found = retainedStateDiagnostics(program, repositoryRoot).filter(({ fileName }) =>
    fileName.startsWith("src/type-inference/core/scratch-"),
  );
  assert.deepEqual(
    found.map(({ fileName, line }) => `${fileName}:${line}`),
    ["src/type-inference/core/scratch-missed.mts:1"],
  );
});

test("an `accessor` field, whose value sits in a slot no line reads, is refused in type inference (#1072 R67)", () => {
  assertMarked(
    [
      "class Counted {",
      "  accessor count = 0; // refused",
      "  closed = 0;",
      "  static accessor shared = 0; // refused",
      "  public constructor() {",
      "    Retained.owner(this, 'Counted', null);",
      "  }",
      "}",
    ].join("\n"),
  );
});
