import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import test from "node:test";
import ts from "typescript";

import { OwnedCell, OwnedMap } from "../../player/engine-bridge/delivery.js";
import { playerOpsContext, type PlayerOpsContext } from "../../player/engine-bridge/player-ops.js";

/*
 * Who owns what the host allocates (#2006, `delivery.ts`): its capability allocations and their ancillary state, not
 * the diagnostic state `releaseConnection` deliberately keeps (the recorder, the value trace, the random control).
 * One invariant: every such allocation the host retains belongs to a live delivery or a live owner, and an ended
 * delivery or owner leaves none behind. A delivery is live from just before its op runs until its success reply is
 * posted; after that, what it allocated is the connection's, until it is released or the connection closes.
 *
 * This file: two convention checks, by syntax and by declared types, that a connection's registries are owned ones.
 * They do not decide the invariant: the retention family does (`player-bridge-delivery-retention.test.ts`).
 */

// ---------------------------------------------------------------------------------------------------------------------
// The census, a convention check: the ops context's declared field types and its visible own fields, and the
// collections created by syntax outside function nodes in the modules of `player/engine-bridge/`. It does not see a
// class's private instance state, what an immediately invoked function or a computed name creates, or closure state.

/** The context's paths that hold diagnostics or scalar state the connection keeps by design, not registries. */
const CONNECTION_STATE = new Set([
  "delivery",
  "recorder",
  "trace",
  "traceId",
  "traceIntent",
  "transferCount",
  "random",
  // The debug export's runs and stops: diagnostic connection state, which allocates nothing a client holds.
  "exportObservation",
]);

/**
 * What on `holder` (at `path`) is not an owned registry or classified state, among its visible own fields: a raw
 * collection, an unknown value, or an object with no own fields. Exemptions are by exact path. A function with no own
 * fields but those `FUNCTION_FIELDS` exempts is skipped; one with more has them checked as any field's.
 */
function unowned(holder: Readonly<Record<string, unknown>>, path: string): string[] {
  const fields = Object.entries(holder);
  if (fields.length === 0) return [`${path || "(context)"}: an empty object`];
  return fields.flatMap(([name, value]) => {
    const at = path === "" ? name : `${path}.${name}`;
    if (CONNECTION_STATE.has(at)) return [];
    if (value instanceof OwnedMap || value instanceof OwnedCell) return [];
    if (
      value instanceof Map ||
      value instanceof Set ||
      value instanceof WeakMap ||
      value instanceof WeakSet ||
      Array.isArray(value)
    )
      return [`${at}: a raw collection`];
    if (typeof value === "function") {
      const own = ownFields(value).filter(([key]) => !FUNCTION_FIELDS.has(key));
      return own.length === 0 ? [] : unowned(Object.fromEntries(own), at);
    }
    if (typeof value === "object" && value !== null)
      return unowned(Object.fromEntries(ownFields(value)), at);
    return [`${at}: neither owned nor classified`];
  });
}

/**
 * The own fields this check exempts on a function. An exemption, not a proof: a function's `prototype` is an object
 * that could hold state, and this check does not look into it.
 */
const FUNCTION_FIELDS = new Set(["length", "name", "prototype"]);

/** Every own field of `value`, enumerable or not, a symbol's under its description; an accessor's by its getter. */
function ownFields<T>(value: T): [string, unknown][] {
  const descriptors = Object.getOwnPropertyDescriptors(value);
  return Reflect.ownKeys(descriptors).map((key) => {
    // EVIDENCE: fixture: `key` is one of `descriptors`' own keys, which `Reflect.ownKeys` listed.
    const descriptor = descriptors[key as keyof typeof descriptors];
    return [
      typeof key === "symbol" ? `[${key.description ?? "symbol"}]` : key,
      descriptor === undefined
        ? undefined
        : "value" in descriptor
          ? descriptor.value
          : descriptor.get,
    ];
  });
}

/**
 * Whether every declared field of `T`, recursively, is an owned registry or a call signature: `true`, or the offending
 * field's name. An object type with no keys fails. A function type passes as a call signature with no properties; with
 * properties, they are checked as any field's. Declared types only: a class's private state behind public methods passes.
 */
type AllOwned<T> = {
  [Field in keyof T]-?: T[Field] extends (...args: never[]) => infer _Result
    ? [keyof T[Field]] extends [never]
      ? true
      : [Exclude<AllOwned<T[Field]>, true>] extends [never]
        ? true
        : Field
    : T[Field] extends OwnedMap<infer _Key, infer _Value> | OwnedCell<infer _Item>
      ? true
      : T[Field] extends object
        ? [keyof T[Field]] extends [never]
          ? Field
          : [Exclude<AllOwned<T[Field]>, true>] extends [never]
            ? true
            : Field
        : Field;
}[keyof T];
type ContextFields = Omit<
  PlayerOpsContext,
  | "delivery"
  | "recorder"
  | "trace"
  | "traceId"
  | "traceIntent"
  | "transferCount"
  | "random"
  | "exportObservation"
>;
const ALL_OWNED: [Exclude<AllOwned<ContextFields>, true>] extends [never] ? true : false = true;
// Its negative controls: a raw map, at the top or nested, and a scalar field are found.
type Finds<T> = [Exclude<AllOwned<T>, true>] extends [never] ? false : true;
const FINDS: readonly [
  Finds<{ extra: Map<string, string> }>,
  Finds<{ caches: { trace: Map<string, string> } }>,
  Finds<{ count: number }>,
  Finds<{ extra: {} }>,
  Finds<{ caches: { extra: {} } }>,
  Finds<{ extra: object }>,
  Finds<{ stash: (() => void) & { readonly held: Map<string, string> } }>,
] = [true, true, true, true, true, true, true];

test("the context census classifies its declared types and visible own fields", () => {
  assert.equal(ALL_OWNED, true);
  assert.deepEqual(FINDS, [true, true, true, true, true, true, true]);
  assert.deepEqual(unowned({ ...playerOpsContext() }, ""), []);
  // A raw map on the context, one nested under an exempt name, an empty object and an unclassified field are found.
  const context = playerOpsContext();
  assert.deepEqual(unowned({ ...context, extra: new Map() }, ""), ["extra: a raw collection"]);
  assert.deepEqual(
    unowned({ ...context, sourceViews: { ...context.sourceViews, trace: new Map() } }, ""),
    ["sourceViews.trace: a raw collection"],
  );
  assert.deepEqual(unowned({ ...context, extra: {} }, ""), ["extra: an empty object"]);
  assert.deepEqual(unowned({ ...context, count: 1 }, ""), ["count: neither owned nor classified"]);
  // A function that carries a raw map is no behaviour; a plain one is.
  assert.deepEqual(
    unowned({ ...context, stash: Object.assign(() => {}, { held: new Map() }) }, ""),
    ["stash.held: a raw collection"],
  );
  assert.deepEqual(unowned({ ...context, run: () => {} }, ""), []);
});

const ENGINE_BRIDGE = resolve(process.cwd(), "player/engine-bridge");

/**
 * The module-scope bindings of `player/engine-bridge/` the module check finds: every module-scope `let`, and every
 * collection created by syntax (`new Map`, `Set`, `WeakMap`, `WeakSet`, an array literal) outside a function node,
 * named by the declaration it sits in. Each is classified by module and binding; an unclassified or stale one fails.
 */
const MODULE_STATE: Readonly<Record<string, string>> = {
  "delivery.ts › states": "the owners' own state, weakly keyed by its owner",
  "delivery.ts › OwnedMap.#entries": "an owned registry's map, private to it",
  "delivery.ts › OwnedMap.#insertions": "an owned registry's insertion marks, private to it",
  "instruction-facts.ts › cache": "immutable facts, weakly keyed by their plan",
  "transport.ts › nativePrototypes": "the transport's memo of native prototypes, weakly keyed",
  "transport.ts › FLAT_KEYS": "a constant table",
  "protocol.ts › REQUEST_KEYS": "a constant table",
  "protocol.ts › REPLY_OK_KEYS": "a constant table",
  "protocol.ts › REPLY_ERROR_KEYS": "a constant table",
  "protocol.ts › BUILD_KEYS": "a constant table",
  "inventory.ts › COMPLETED_FAMILIES": "a constant table",
  "inventory.ts › ALLOWED_SOURCE": "a constant table",
  "inventory.ts › WORKER_MODULES": "a constant table",
  "inventory.ts › RATCHET": "a constant table",
  "inventory.ts › VIEW_READERS": "a constant table",
  "ops/session.ts › START_OPTIONS": "a constant table",
  "ops/session.ts › nextHistoryKey":
    "the realm's lineage-key serial: a scalar, which holds no allocation",
  "ops/history.ts › CLOSE_REASONS": "a constant table",
  "ops/history.ts › OBLIGATION_REASONS": "a constant table",
  "history/core.ts › NO_EFFECTS": "a frozen constant",
  "history/core.ts › HistoryCore.#points":
    "a history's points, private to its core, which the registry owns",
  "history/core.ts › HistoryCore.#lastSequence":
    "a history's last sequence per log, private to its core, which the registry owns",
  "history/registry.ts › NOTHING": "a frozen constant",
  "recording/export-observation.ts › ExportObservation.runs":
    "a debug export's runs and stops, diagnostic connection state the context's `exportObservation` holds",
  "history/snapshots.ts › SnapshotStore.#memory":
    "a history's snapshots in memory, private to its store, which its core owns",
  "history/snapshots.ts › SnapshotStore.#spilled":
    "the IDs of a history's spilled snapshots, private to its store, which its core owns",
};

/** `node` without the casts and parentheses around it. */
function bare(node: ts.Expression): ts.Expression {
  let at = node;
  while (
    ts.isAsExpression(at) ||
    ts.isSatisfiesExpression(at) ||
    ts.isParenthesizedExpression(at) ||
    ts.isTypeAssertionExpression(at)
  )
    at = at.expression;
  return at;
}

const COLLECTIONS = new Set(["Map", "Set", "WeakMap", "WeakSet"]);
const isCollection = (node: ts.Expression | undefined): boolean => {
  if (node === undefined) return false;
  const value = bare(node);
  return (
    ts.isArrayLiteralExpression(value) ||
    (ts.isNewExpression(value) &&
      ts.isIdentifier(value.expression) &&
      COLLECTIONS.has(value.expression.text))
  );
};

/**
 * The function nodes the module walk does not enter, and only these. What they create is not seen here, also when a
 * call at module scope keeps it: an immediately invoked function, or a class method's computed name.
 */
const FUNCTION_NODES = new Set([
  ts.SyntaxKind.FunctionDeclaration,
  ts.SyntaxKind.FunctionExpression,
  ts.SyntaxKind.ArrowFunction,
  ts.SyntaxKind.MethodDeclaration,
  ts.SyntaxKind.GetAccessor,
  ts.SyntaxKind.SetAccessor,
  ts.SyntaxKind.Constructor,
]);

/**
 * The module-scope state of `text` (module `module`), by `module › binding`: every module-scope `let`, and every
 * collection created by syntax anywhere in the module outside a function node (`FUNCTION_NODES`), named by the
 * declaration it sits in.
 */
function moduleState(module: string, text: string): string[] {
  const source = ts.createSourceFile(module, text, ts.ScriptTarget.Latest, true);
  const found = new Set<string>();
  for (const statement of source.statements)
    if (
      ts.isVariableStatement(statement) &&
      (statement.declarationList.flags & ts.NodeFlags.Const) === 0
    )
      for (const declaration of statement.declarationList.declarations)
        found.add(`${module} › ${declaration.name.getText(source)}`);
  const visit = (node: ts.Node, binding: string) => {
    if (FUNCTION_NODES.has(node.kind)) return;
    let at = binding;
    if (ts.isVariableDeclaration(node)) at = node.name.getText(source);
    if (ts.isClassLike(node)) at = node.name?.text ?? "(class)";
    if (ts.isPropertyDeclaration(node)) at = `${binding}.${node.name.getText(source)}`;
    if (ts.isClassStaticBlockDeclaration(node)) at = `${binding}.(static block)`;
    if (ts.isExpression(node) && isCollection(node)) found.add(`${module} › ${at}`);
    ts.forEachChild(node, (child) => visit(child, at));
  };
  visit(source, "(statement)");
  return [...found];
}

function engineBridgeModules(): string[] {
  const modules: string[] = [];
  const walk = (folder: string) => {
    for (const name of readdirSync(folder)) {
      const path = join(folder, name);
      if (statSync(path).isDirectory()) walk(path);
      else if (path.endsWith(".ts")) modules.push(relative(ENGINE_BRIDGE, path));
    }
  };
  walk(ENGINE_BRIDGE);
  return modules.sort();
}

test("the module syntax census classifies every binding it discovers", () => {
  const found = engineBridgeModules().flatMap((module) =>
    moduleState(module, readFileSync(join(ENGINE_BRIDGE, module), "utf8")),
  );
  assert.deepEqual(
    found.filter((binding) => !Object.hasOwn(MODULE_STATE, binding)),
    [],
    "unclassified",
  );
  assert.deepEqual(
    Object.keys(MODULE_STATE).filter((binding) => !found.includes(binding)),
    [],
    "classified, but no such binding",
  );
  // A module-level map, also wrapped in an object or a call, a module-level `let` a registry could be stashed in, and a
  // class field, also wrapped, are found; a map a function creates is not seen.
  assert.deepEqual(
    moduleState(
      "ops/transfer.ts",
      [
        "const unowned = new Map<string, unknown>();",
        "const held = { tickets: new Map() };",
        "const list = { tickets: [] };",
        "const sealed = Object.seal(new Map());",
        "let stash = null;",
        "class Caches { readonly trace = new Map(); readonly holder = { tickets: new Map() }; }",
        "function local() { const per = new Map(); return per; }",
        "export const ops = { run: () => new Map() };",
        "export class Stash { static entries: Map<string, unknown>; static { this.entries = new Map(); } }",
        "export class Methods { run() { return new Map(); } get map() { return new Map(); } }",
      ].join("\n"),
    ).sort(),
    [
      "ops/transfer.ts › unowned",
      "ops/transfer.ts › held",
      "ops/transfer.ts › list",
      "ops/transfer.ts › sealed",
      "ops/transfer.ts › stash",
      "ops/transfer.ts › Caches.trace",
      "ops/transfer.ts › Caches.holder",
      "ops/transfer.ts › Stash.(static block)",
    ].sort(),
  );
});
