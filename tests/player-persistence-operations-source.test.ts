import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import ts from "typescript";

import type { CapturedMediaStore } from "../player/captured-media.js";
import type { BridgeClient } from "../player/engine-bridge/client.js";
import type { PlayerBridge } from "../player/player-bridge.js";
import { OWNERSHIP_MODES, type Operated, type Ownership } from "./helpers/plan-json-family.js";

/*
 * The persistence operations of the Player's session host (`player/vue/src/usePlayerSession.ts`: keep, the kept
 * session's restore, the session import, the saved-data import) reach the page's stores and the host only through their
 * ownership's handles (`player/persistence-ownership.ts`), so a stale operation's call is refused wherever it is made.
 * This check reads the host's syntax tree. It finds every place that reaches a raw resource, the media store or the
 * host, and fails one no table below classifies. In an operation, with every closure nested in it, it fails each use of
 * a resource it does not recognize as admitted. It covers the operations' own code, not a helper they call: a new
 * branch inside a helper still needs a source review.
 */

const SOURCE = "player/vue/src/usePlayerSession.ts";

/** The persistence operations, by name; any other function of the host that takes an ownership is checked too. */
const OPERATIONS = [
  "keepOnce",
  "keepIn",
  "forgetKeptSession",
  "discardKeptSession",
  "prepareKept",
  "restoreKept",
  "importSession",
  "readScriptStorage",
  "importSavedData",
];

/** Where an ownership is made or bound to the raw resources: the boundary, which the check leaves out, and why. */
const BOUNDARY: Readonly<Record<string, string>> = {
  persistenceOwnership:
    "makes an operation's ownership from the page's room, store, tenure and preparation",
  operationStorage: "binds the routed saved values to an operation's ownership",
  owned: "runs an operation and ends its registration; it touches no store",
  replaceOwnInDebugRoom:
    "binds the script's own saved values and photos to an operation while the debug room is shown",
};

/**
 * Helpers an operation calls that write without its ownership, and why: none of this page's state retires them. Each
 * must stay a helper of its own, taking no ownership, so the check sees where the operation hands work over.
 */
const UNBOUND: Readonly<Record<string, string>> = {
  importOtherScript:
    "another script's saved data in a saved-data import: the player's confirmed writes for a script this page does not show (L5h.2, orchestrator 2's decision (a))",
};

const RESOURCE =
  "defines a raw resource of this check: the kept store, the saved values' route or a wrapper of them";
const MOVE =
  "a move of the page: a room change, the debug room it makes, or a debug session started anew; what retires an operation, not one";
const SESSION =
  "the shown session's own work in the host, which the session's lineage and `publishOwned` own; no persistence operation";
const READ = "a read for display, review or export: it writes no store";
const TRANSFER =
  "an import's reading in the host before the player confirms it, or its release: it reaches no store";
const EDIT =
  "a direct edit by the player of the shown script's saved data or photos, or Debug's adoption of an inspected state: outside the continuation family, unowned as before L5h";
const SETUP = "the host's setup, its watchers and its teardown";

/**
 * Every other place of the host that reaches a raw resource, the media store or the host, and why it is no persistence
 * operation. A place is a named function, or a method or property function as `<object>.<property>`; a closure belongs
 * to its place. A place no table names fails the check; so does a name here the host no longer has.
 */
const OUTSIDE: Readonly<Record<string, string>> = {
  usePlayerSession: SETUP,
  keptStore: RESOURCE,
  routed: RESOURCE,
  "scriptStorage.load": RESOURCE,
  "scriptStorage.write": RESOURCE,
  "scriptStorage.replace": RESOURCE,
  "scriptStorage.clear": RESOURCE,
  switchStorage: MOVE,
  enterDebugRoom: MOVE,
  setDebugMode: MOVE,
  copyToDebugRoom: MOVE,
  createDebugRoom: MOVE,
  startDebugSessionAnew: MOVE,
  activate: SESSION,
  "prepareRestore.begin": SESSION,
  prepareActivation: SESSION,
  startedSession: SESSION,
  reportHostError: SESSION,
  stopAt: SESSION,
  supersede: SESSION,
  issueTracing: SESSION,
  applyDebugMode: SESSION,
  debugView: SESSION,
  viewCalls: SESSION,
  serviceCapture: SESSION,
  ownedSection: SESSION,
  settlePlanJson: SESSION,
  loadScriptStorage: READ,
  "usePlayerSession.readSavedData": READ,
  savedScripts: READ,
  reviewSavedDataImport: READ,
  reviewedImport: READ,
  exportSession: READ,
  storedPhotos: READ,
  "usePlayerSession.savedPhoto": READ,
  resolveAsset: READ,
  "usePlayerSession.debugExportCandidate": READ,
  scriptStorageOptions: READ,
  ownStoredMedia: READ,
  readTransfer: TRANSFER,
  discardSessionReview: TRANSFER,
  adoptShown: EDIT,
  applySavedDataEdit: EDIT,
  clearScriptStorage: EDIT,
  storeImageFile: EDIT,
  "usePlayerSession.rememberScriptName": EDIT,
  "usePlayerSession.images.discard": EDIT,
};

/** The page's raw resources, which an operation reaches only through its handles. */
const RAW = new Set([
  "keptSessions",
  "debugRooms",
  "keptStore",
  "storageProvider",
  "scriptStorage",
  "normalStorage",
  "normalRoute",
  "storageRoute",
  "capturedMediaPersistence",
  "debugRoomStorage",
  "options",
]);
/** The handles an ownership binds a raw resource with. */
const HANDLES = new Set(["kept", "rooms", "values", "photos"]);
/** Names an operation's ownership goes by. */
const OWNERSHIP_NAMES = new Set(["ctx", "owner", "ownership"]);

/** The page's media store. */
const MEDIA_STORE = "capturedMedia";
/**
 * Each member of the media store, as an operation may use it: its media in memory, freely; its repository through the
 * ownership given as the second argument; or not at all (a repository read, a load, the store's lifecycle).
 */
const MEDIA = {
  add: "memory",
  discard: "memory",
  holds: "memory",
  knows: "memory",
  sessionRecords: "memory",
  restoreSessionMedia: "memory",
  size: "memory",
  storedReferences: "owned",
  promote: "owned",
  read: "refused",
  readDurable: "refused",
  resolve: "refused",
  sweep: "refused",
  useRepository: "refused",
  disableDurable: "refused",
  close: "refused",
} as const satisfies Record<keyof CapturedMediaStore, "memory" | "owned" | "refused">;
const MEDIA_KINDS: ReadonlyMap<string, string> = new Map(Object.entries(MEDIA));
/** Helpers an operation hands the media store to, and why that admits nothing new. */
const MEDIA_HELPERS: Readonly<Record<string, string>> = {
  replaceScript:
    "adds the imported photos to the media in memory and discards them after a failure; its values go to the storage it is given",
};

/**
 * Each member of the bridge and its client, as an operation may name it: a request of the host, only inside `admit`;
 * the bridge's own state, freely (`release` lets go of a session the operation restored, as a stale one does); or the
 * connection's lifecycle, never.
 */
const BRIDGE = {
  nextTracingIntent: "local",
  traced: "local",
  claim: "refused",
  unclaim: "refused",
  client: "local",
  open: "local",
  store: "local",
  latest: "local",
  frozen: "local",
  release: "local",
  deliverInTransit: "local",
  start: "host",
  read: "host",
  restoreKept: "host",
  request: "host",
  viewCalls: "host",
  section: "host",
  halt: "host",
} as const satisfies Record<keyof PlayerBridge, "host" | "local" | "refused">;
const CLIENT = {
  request: "host",
  section: "host",
  signal: "host",
  terminate: "refused",
  onLoss: "refused",
} as const satisfies Record<keyof BridgeClient, "host" | "local" | "refused">;
/** The class of each member name, the stricter where the bridge and its client share one. */
const HOST: ReadonlyMap<string, "host" | "refused"> = (() => {
  const classes = new Map<string, "host" | "refused">();
  for (const [name, kind] of [...Object.entries(BRIDGE), ...Object.entries(CLIENT)])
    if (kind !== "local" && classes.get(name) !== "refused") classes.set(name, kind);
  return classes;
})();

/** Why the check fails a use, one reason per rule. */
const WHY = {
  raw: "a raw resource",
  mediaOwner: "the media store without the ownership",
  mediaRefused: "the media store's repository or lifecycle",
  mediaUnknown: "a use of the media store the check does not recognize",
  hostCall: "a host request outside `admit`",
  hostRefused: "the connection's lifecycle",
  computedCall: "a call the check cannot read",
} as const;

/** The name a member access names, for `a.name` and `a["name"]`; `null` for a computed one. */
function memberName(node: ts.PropertyAccessExpression | ts.ElementAccessExpression): string | null {
  if (ts.isPropertyAccessExpression(node)) return node.name.text;
  return ts.isStringLiteralLike(node.argumentExpression) ? node.argumentExpression.text : null;
}

/** Whether `node` is a name a declaration or a type gives, not a use of what it names. */
function declared(node: ts.Identifier): boolean {
  const parent = node.parent;
  if (
    (ts.isPropertyAccessExpression(parent) && parent.name === node) ||
    (ts.isPropertyAssignment(parent) && parent.name === node) ||
    (ts.isPropertySignature(parent) && parent.name === node) ||
    (ts.isMethodDeclaration(parent) && parent.name === node) ||
    (ts.isVariableDeclaration(parent) && parent.name === node) ||
    (ts.isFunctionDeclaration(parent) && parent.name === node) ||
    (ts.isParameter(parent) && parent.name === node) ||
    (ts.isBindingElement(parent) && parent.propertyName === node)
  )
    return true;
  for (let current: ts.Node = parent; !ts.isSourceFile(current); current = current.parent)
    if (ts.isTypeNode(current)) return true;
  return false;
}

/** The place a function node is: its name, or `<object>.<property>` for a property or method of an object literal. */
function placeName(node: ts.Node, source: ts.SourceFile): string | null {
  if (ts.isFunctionDeclaration(node)) return node.name?.text ?? null;
  const holder =
    ts.isArrowFunction(node) || ts.isFunctionExpression(node)
      ? node.parent
      : ts.isMethodDeclaration(node) || ts.isGetAccessorDeclaration(node)
        ? node
        : null;
  if (holder === null) return null;
  if (ts.isVariableDeclaration(holder) && ts.isIdentifier(holder.name)) return holder.name.text;
  if (
    !ts.isPropertyAssignment(holder) &&
    !ts.isMethodDeclaration(holder) &&
    !ts.isGetAccessorDeclaration(holder)
  )
    return null;
  // The property's path through nested object literals, under the variable that holds the outermost, or the place
  // whose code it is part of.
  const path = [holder.name.getText(source)];
  let literal: ts.Node = holder.parent;
  while (ts.isObjectLiteralExpression(literal) && ts.isPropertyAssignment(literal.parent)) {
    path.unshift(literal.parent.name.getText(source));
    literal = literal.parent.parent;
  }
  let owner: ts.Node = literal;
  while (ts.isParenthesizedExpression(owner.parent) || ts.isBinaryExpression(owner.parent))
    owner = owner.parent;
  if (ts.isVariableDeclaration(owner.parent) && ts.isIdentifier(owner.parent.name))
    return [owner.parent.name.text, ...path].join(".");
  return [enclosingPlace(literal, source) ?? "", ...path].join(".");
}

/** The nearest place around `node`. */
function enclosingPlace(node: ts.Node, source: ts.SourceFile): string | null {
  for (let current = node.parent; current !== undefined; current = current.parent) {
    const name = placeName(current, source);
    if (name !== null) return name;
  }
  return null;
}

/** Each place around `node`, the nearest first. */
function places(node: ts.Node, source: ts.SourceFile): string[] {
  const found: string[] = [];
  for (let current = node.parent; current !== undefined; current = current.parent) {
    const name = placeName(current, source);
    if (name !== null) found.push(name);
  }
  return found;
}

/** The functions of the host's body to check, by name. */
function operations(source: ts.SourceFile): Map<string, ts.Node> {
  const found = new Map<string, ts.Node>();
  // A parameter of the ownership's type, or an untyped one by an ownership's name.
  const takesOwnership = (node: ts.SignatureDeclaration) =>
    node.parameters.some((parameter) =>
      parameter.type === undefined
        ? ts.isIdentifier(parameter.name) && OWNERSHIP_NAMES.has(parameter.name.text)
        : parameter.type.getText(source) === "PersistenceOwnership",
    );
  const visit = (node: ts.Node) => {
    let name: string | null = null;
    let signature: ts.SignatureDeclaration | null = null;
    if (ts.isFunctionDeclaration(node) && node.name !== undefined) {
      name = node.name.text;
      signature = node;
    } else if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer !== undefined &&
      (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer))
    ) {
      name = node.name.text;
      signature = node.initializer;
    }
    if (name !== null && signature !== null && !Object.hasOwn(BOUNDARY, name)) {
      if (OPERATIONS.includes(name) || takesOwnership(signature)) {
        found.set(name, signature);
        return;
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

/** Whether `node` sits inside the function given to an ownership's `admit`. */
function insideAdmit(node: ts.Node): boolean {
  for (let current = node.parent; current !== undefined; current = current.parent)
    if (
      (ts.isArrowFunction(current) || ts.isFunctionExpression(current)) &&
      ts.isCallExpression(current.parent) &&
      ts.isPropertyAccessExpression(current.parent.expression) &&
      current.parent.expression.name.text === "admit"
    )
      return true;
  return false;
}

/** The member name `node` names, as an access (`a.name`, `a["name"]`) or a destructured property; `null` for none. */
function namedMember(node: ts.Node): string | null {
  if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node))
    return memberName(node);
  if (ts.isBindingElement(node) && ts.isObjectBindingPattern(node.parent)) {
    const name = node.propertyName ?? node.name;
    return ts.isIdentifier(name) || ts.isStringLiteralLike(name) ? name.text : null;
  }
  return null;
}

/**
 * Why the use at `node`, in an operation, is not admitted, or `null` where it is. The one deciding function of the
 * check: a raw resource, the media store, a member of the host, or a call it cannot read.
 */
function refusal(node: ts.Node): string | null {
  if (ts.isIdentifier(node) && RAW.has(node.text) && !declared(node) && rawUse(node))
    return WHY.raw;
  if (ts.isIdentifier(node) && node.text === MEDIA_STORE && !declared(node)) return mediaUse(node);
  const member = namedMember(node);
  if (member !== null && HOST.has(member)) {
    if (HOST.get(member) === "refused") return WHY.hostRefused;
    if (!insideAdmit(node)) return WHY.hostCall;
  }
  if (
    ts.isCallExpression(node) &&
    ts.isElementAccessExpression(node.expression) &&
    memberName(node.expression) === null
  )
    return WHY.computedCall;
  return null;
}

/** Why the media store's use at `node` is not admitted, or `null` where it is. */
function mediaUse(node: ts.Identifier): string | null {
  const parent = node.parent;
  if (
    (ts.isPropertyAccessExpression(parent) || ts.isElementAccessExpression(parent)) &&
    parent.expression === node
  ) {
    const name = memberName(parent);
    const kind = name === null ? undefined : MEDIA_KINDS.get(name);
    if (kind === undefined) return WHY.mediaUnknown;
    if (kind === "memory") return null;
    if (kind === "refused") return WHY.mediaRefused;
    const call = parent.parent;
    const owner =
      ts.isCallExpression(call) && call.expression === parent ? call.arguments[1] : undefined;
    return owner !== undefined && ts.isIdentifier(owner) && OWNERSHIP_NAMES.has(owner.text)
      ? null
      : WHY.mediaOwner;
  }
  if (
    ts.isCallExpression(parent) &&
    parent.arguments.includes(node) &&
    ts.isIdentifier(parent.expression) &&
    Object.hasOwn(MEDIA_HELPERS, parent.expression.text)
  )
    return null;
  return WHY.mediaUnknown;
}

/**
 * Whether the identifier `node` uses a raw resource other than to compare it, bind it to a handle, or wait for the
 * storage route as a statement of its own, whose result nothing takes.
 */
function rawUse(node: ts.Identifier): boolean {
  const parent = node.parent;
  // Its scope names the script: a field, not a call of the store.
  if (
    ts.isPropertyAccessExpression(parent) &&
    parent.expression === node &&
    parent.name.text === "scope"
  )
    return false;
  // `keptStore()` is used as its result is.
  const use: ts.Expression =
    ts.isCallExpression(parent) && parent.expression === node ? parent : node;
  const context = use.parent;
  if (
    ts.isBinaryExpression(context) &&
    [ts.SyntaxKind.EqualsEqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsEqualsToken].includes(
      context.operatorToken.kind,
    )
  )
    return false;
  if (
    ts.isAwaitExpression(context) &&
    ts.isIdentifier(use) &&
    use.text === "storageRoute" &&
    ts.isExpressionStatement(context.parent)
  )
    return false;
  if (
    ts.isCallExpression(context) &&
    context.arguments.includes(use) &&
    ts.isPropertyAccessExpression(context.expression) &&
    HANDLES.has(context.expression.name.text) &&
    ts.isIdentifier(context.expression.expression) &&
    OWNERSHIP_NAMES.has(context.expression.expression.text)
  )
    return false;
  return true;
}

/** Each use in `body` the check does not admit, as `line: why: text`. */
function violations(source: ts.SourceFile, body: ts.Node): string[] {
  const found: string[] = [];
  const visit = (node: ts.Node) => {
    const why = refusal(node);
    if (why !== null) {
      const { line } = source.getLineAndCharacterOfPosition(node.getStart(source));
      found.push(`${line + 1}: ${why}: ${node.getText(source).split("\n")[0]}`);
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(body, visit);
  return found;
}

/**
 * Every place of `source` that reaches a raw resource, the media store or a member of the host outside an operation
 * and the boundary, each with the first line that does.
 */
function consumers(source: ts.SourceFile, checked: ReadonlySet<string>): Map<string, number> {
  const found = new Map<string, number>();
  const visit = (node: ts.Node) => {
    const reaches =
      (ts.isIdentifier(node) &&
        (RAW.has(node.text) || node.text === MEDIA_STORE) &&
        !declared(node)) ||
      ((ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) &&
        HOST.has(memberName(node) ?? ""));
    if (reaches) {
      const around = places(node, source);
      if (!around.some((place) => checked.has(place) || Object.hasOwn(BOUNDARY, place))) {
        const place = around[0] ?? "(the module)";
        if (!found.has(place))
          found.set(place, source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

/** The function that makes each ownership the host makes, by the operation of the family it belongs to. */
const OWNING: Readonly<Record<string, Operated>> = {
  keepOnce: "captureKeep",
  prepareKept: "restoreKept",
  importSession: "planText",
  importSavedData: "savedDataImport",
};

/**
 * The ownerships an argument of `persistenceOwnership` can give, in `scope`: none or `null` holds the tenure alone,
 * `nextPreparation()` a preparation, a condition either branch's, a name its declaration's. `null` for a form the check
 * cannot read.
 */
function modesOf(argument: ts.Expression | undefined, scope: ts.Node): Ownership[] | null {
  if (argument === undefined || argument.kind === ts.SyntaxKind.NullKeyword) return ["tenure"];
  if (
    ts.isCallExpression(argument) &&
    ts.isIdentifier(argument.expression) &&
    argument.expression.text === "nextPreparation"
  )
    return ["preparation"];
  if (ts.isConditionalExpression(argument)) {
    const [whenTrue, whenFalse] = [
      modesOf(argument.whenTrue, scope),
      modesOf(argument.whenFalse, scope),
    ];
    return whenTrue === null || whenFalse === null
      ? null
      : [...new Set([...whenTrue, ...whenFalse])];
  }
  if (ts.isIdentifier(argument)) {
    let initializer: ts.Expression | undefined | null = null;
    const find = (node: ts.Node) => {
      if (
        (ts.isVariableDeclaration(node) || ts.isParameter(node)) &&
        ts.isIdentifier(node.name) &&
        node.name.text === argument.text
      )
        initializer = initializer === null ? node.initializer : undefined;
      ts.forEachChild(node, find);
    };
    find(scope);
    return initializer === null || initializer === undefined ? null : modesOf(initializer, scope);
  }
  return null;
}

/** The ownerships the host makes, by operation, and each one it cannot read or place. */
function ownerships(source: ts.SourceFile): {
  modes: Map<Operated, Set<Ownership>>;
  failures: string[];
} {
  const modes = new Map<Operated, Set<Ownership>>();
  const failures: string[] = [];
  const visit = (node: ts.Node) => {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === "persistenceOwnership"
    ) {
      const line = source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
      const maker = places(node, source).find((place) => Object.hasOwn(OWNING, place));
      let scope: ts.Node = node;
      while (scope.parent !== undefined && placeName(scope, source) !== maker) scope = scope.parent;
      const found = maker === undefined ? null : modesOf(node.arguments[0], scope);
      if (maker === undefined)
        failures.push(`${line}: an ownership no operation of the family makes`);
      else if (found === null) failures.push(`${line}: an ownership the check cannot read`);
      else {
        const operated = OWNING[maker]!;
        modes.set(operated, new Set([...(modes.get(operated) ?? []), ...found]));
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return { modes, failures };
}

/** Each use the check does not admit in the operations of `text`, and each place it finds unclassified. */
function check(text: string, path = "operations.ts") {
  const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true);
  const found = operations(source);
  const failures = [...found].flatMap(([name, node]) =>
    violations(source, node).map((violation) => `${name}, line ${violation}`),
  );
  const reached = consumers(source, new Set(found.keys()));
  const unclassified = [...reached]
    .filter(([place]) => !Object.hasOwn(UNBOUND, place) && !Object.hasOwn(OUTSIDE, place))
    .map(([place, line]) => `${place}, line ${line}`);
  return { found: new Set(found.keys()), failures, reached, unclassified, source };
}

test("every persistence operation reaches stores and the host only through its ownership", () => {
  const path = resolve(process.cwd(), SOURCE);
  const text = readFileSync(path, "utf8");
  const { found, failures } = check(text, path);
  for (const name of OPERATIONS) assert.ok(found.has(name), `${name} is in ${SOURCE}`);
  for (const name of Object.keys(UNBOUND))
    assert.ok(
      new RegExp(`async function ${name}\\((?![^)]*Ownership)`).test(text),
      `${name} is a helper of ${SOURCE} that takes no ownership`,
    );
  assert.deepEqual(failures, []);
});

test("every place of the host that reaches a store or the host is an operation, its boundary, or classified", () => {
  const path = resolve(process.cwd(), SOURCE);
  const { found, reached, unclassified } = check(readFileSync(path, "utf8"), path);
  assert.deepEqual(unclassified, [], "places no table classifies");
  // Each name of the tables is a place the host has, of one table alone.
  for (const place of [...Object.keys(OUTSIDE), ...Object.keys(UNBOUND)])
    assert.ok(reached.has(place), `${place} reaches no store or host in ${SOURCE}`);
  const tables = [
    OPERATIONS,
    Object.keys(BOUNDARY),
    Object.keys(UNBOUND),
    Object.keys(OUTSIDE),
  ].flat();
  assert.equal(new Set(tables).size, tables.length, "a place in two tables");
  for (const place of Object.keys(OUTSIDE))
    assert.ok(!found.has(place), `${place} takes an ownership`);
});

test("each ownership the host makes belongs to an operation of the family, with the modes the family drives", () => {
  const path = resolve(process.cwd(), SOURCE);
  const source = ts.createSourceFile(
    path,
    readFileSync(path, "utf8"),
    ts.ScriptTarget.Latest,
    true,
  );
  const { modes, failures } = ownerships(source);
  assert.deepEqual(failures, []);
  assert.deepEqual(
    Object.fromEntries([...modes].map(([operation, made]) => [operation, [...made].sort()])),
    Object.fromEntries(
      Object.entries(OWNERSHIP_MODES).map(([operation, made]) => [operation, [...made].sort()]),
    ),
  );
});

/** An operation of the host whose body is `body`. */
const operation = (body: string) =>
  `function host() {\n  async function keepIn(ctx: PersistenceOwnership) {\n${body}\n  }\n}`;

interface FormCase {
  readonly body: string;
  readonly refused: boolean;
  /** The resource or member the case reaches, for the coverage check. */
  readonly reaches: string;
}

/** Each form of use of each resource and member the check classifies, with whether it must fail. */
function formCases(): FormCase[] {
  const cases: FormCase[] = [];
  const add = (reaches: string, refused: boolean, ...bodies: string[]) =>
    bodies.forEach((body) => cases.push({ body, refused, reaches }));
  for (const raw of RAW) {
    add(
      `raw ${raw}`,
      true,
      `await ${raw}.discard(scope);`,
      `await ${raw}["discard"](scope);`,
      `const { discard } = ${raw};`,
      `const alias = ${raw};`,
      `const later = async () => { await ${raw}.load(); };`,
      `const store = await ${raw}();`,
    );
    add(
      `raw ${raw}`,
      false,
      `if (${raw} === other) return;`,
      `await ctx.kept(${raw}).discard(scope);`,
      `const scope = ${raw}.scope;`,
    );
  }
  // The storage route is awaited as a statement of its own, whose result nothing takes.
  add("raw storageRoute", false, "await storageRoute;");
  add("raw storageRoute", true, "const route = await storageRoute;\nawait route.provider.load();");
  for (const [member, kind] of Object.entries(MEDIA))
    for (const access of [`${MEDIA_STORE}.${member}`, `${MEDIA_STORE}["${member}"]`]) {
      add(`media ${member}`, kind !== "memory", `await ${access}(references);`);
      add(`media ${member}`, kind === "refused", `await ${access}(references, ctx);`);
    }
  add(
    "media use",
    true,
    `const media = ${MEDIA_STORE};`,
    `const { promote } = ${MEDIA_STORE};`,
    `await ${MEDIA_STORE}[name](references);`,
    `await ${MEDIA_STORE}["unknown"](references);`,
    `await helper(${MEDIA_STORE});`,
  );
  for (const helper of Object.keys(MEDIA_HELPERS))
    add("media use", false, `await ${helper}(storage, ${MEDIA_STORE}, script);`);
  for (const member of new Set([...Object.keys(BRIDGE), ...Object.keys(CLIENT)])) {
    const kind = HOST.get(member) ?? "local";
    add(
      `host ${member}`,
      kind !== "local",
      `await host.${member}(plan);`,
      `await host["${member}"](plan);`,
      `const { ${member} } = host;`,
      `await host.${member}.call(host, plan);`,
    );
    add(
      `host ${member}`,
      kind === "refused",
      `await ctx.admit(() => host.${member}(plan));`,
      `await ctx.admit(() => host["${member}"](plan));`,
    );
  }
  add("computed call", true, "await host[op](plan);", "await review[key](plan);");
  return cases;
}

test("the check fails each form of use it does not admit, and admits each form it classifies as admitted", () => {
  const reasons = new Set<string>();
  for (const { body, refused } of formCases()) {
    const { failures } = check(operation(body));
    assert.equal(
      failures.length > 0,
      refused,
      `${refused ? "refused" : "admitted"}: ${body}\n${failures.join("\n")}`,
    );
    for (const failure of failures) reasons.add(failure.split(": ")[1]!);
  }
  // The generated forms reach every resource and member the tables classify, and every rule of the check.
  const reached = new Set(formCases().map(({ reaches }) => reaches));
  for (const name of [
    ...[...RAW].map((raw) => `raw ${raw}`),
    ...Object.keys(MEDIA).map((member) => `media ${member}`),
    ...[...Object.keys(BRIDGE), ...Object.keys(CLIENT)].map((member) => `host ${member}`),
    "media use",
    "computed call",
  ])
    assert.ok(reached.has(name), `no form reaches ${name}`);
  assert.deepEqual([...reasons].sort(), Object.values(WHY).sort());
});

test("the check finds an unclassified place, and an ownership no operation makes or it cannot read", () => {
  const unclassified = check(
    "function host() {\n  async function sweepAll() {\n    await keptSessions.discard(scope);\n  }\n}",
  ).unclassified;
  assert.deepEqual(unclassified, ["sweepAll, line 3"]);
  const made = (text: string) =>
    ownerships(ts.createSourceFile("o.ts", text, ts.ScriptTarget.Latest, true)).failures;
  assert.equal(made("function other() { const ctx = persistenceOwnership(); }").length, 1);
  assert.equal(made("function keepOnce() { const ctx = persistenceOwnership(pick()); }").length, 1);
  assert.deepEqual(
    made("function keepOnce() { const owner = nextPreparation(); persistenceOwnership(owner); }"),
    [],
  );
});
