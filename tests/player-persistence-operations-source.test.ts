import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
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
 * This check reads the syntax tree of every module of the host (`HOST_MODULES`). One recognizer (`useAt`) finds each use
 * of a raw resource, the media store, a member of the host, or a member it cannot read; the check fails a place with
 * one that no table below classifies, and in an operation, with every closure nested in it, each use the one deciding
 * function (`refusal`) does not admit. It covers the operations' own code, not a helper they call: a new branch inside a
 * helper still needs a source review. Its raw resources are the names `RAW` lists; every binding of the host's body made
 * from one is checked to be one of them or classified (`DERIVED`), but a store the host would build from nothing it
 * lists is outside the check's reach, as is a binding it cannot resolve lexically.
 */

/** The host's modules, under this folder: the composable and every module of its `session/` folder. */
const HOST_ROOT = "player/vue/src";
const MAIN = "usePlayerSession.ts";
const HOST_MODULES = () => [
  MAIN,
  ...readdirSync(resolve(process.cwd(), HOST_ROOT, "session"))
    .filter((name) => name.endsWith(".ts"))
    .sort()
    .map((name) => `session/${name}`),
];

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
const CAMERA =
  "the cameras' setup: it hands the media store to the session camera, whose photos are session media in memory";
const SERVICES =
  "the shown session's capture, file and lock services: their `request` asks a service, not the host; no persistence operation";

/**
 * Every other place of the host that reaches a raw resource, the media store or the host, by module, and why it is no
 * persistence operation. A place is a named function, or a method or property function as `<object>.<property>`; a
 * closure belongs to its place. A place no table names fails the check; so does a name here its module no longer has.
 */
const OUTSIDE: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  [MAIN]: {
    usePlayerSession: SETUP,
    "usePlayerSession.hasNormalStorage": MOVE,
    keptStore: RESOURCE,
    routed: RESOURCE,
    "scriptStorage.load": RESOURCE,
    "scriptStorage.write": RESOURCE,
    "scriptStorage.replace": RESOURCE,
    "scriptStorage.clear": RESOURCE,
    switchStorage: MOVE,
    enterDebugRoom: MOVE,
    copyToDebugRoom: MOVE,
    createDebugRoom: MOVE,
    startDebugSessionAnew: MOVE,
    activate: SESSION,
    "prepareRestore.begin": SESSION,
    prepareActivation: SESSION,
    startedSession: SESSION,
    reportHostError: SESSION,
    incident: SESSION,
    "usePlayerSession.readPhoto": READ,
    stopAt: SESSION,
    supersede: SESSION,
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
    scriptStorageOptions: READ,
    ownStoredMedia: READ,
    readTransfer: TRANSFER,
    discardSessionReview: TRANSFER,
    adoptShown: EDIT,
    settleAdoption: EDIT,
    applySavedDataEdit: EDIT,
    clearScriptStorage: EDIT,
    "usePlayerSession.rememberScriptName": EDIT,
    "usePlayerSession.images.discard": EDIT,
    sameMedium:
      "compares a held photo's bytes with an imported one's, by position: it reaches no store",
  },
  "session/useActivationRun.ts": { "useActivationRun.retire": READ },
  "session/useCallView.ts": { viewCalls: SESSION },
  "session/useDebugModeAndTrace.ts": {
    issueTracing: SESSION,
    applyDebugMode: SESSION,
    debugView: SESSION,
  },
  "session/useSessionMedia.ts": { storeImageFile: EDIT, "useSessionMedia.watchMedia": SETUP },
  "session/useRandomControl.ts": {
    useRandomControl: SETUP,
    sendRandomRequest: SESSION,
    randomTried: SESSION,
    "useRandomControl.dispose": SETUP,
  },
  "session/useExportCandidate.ts": {
    useExportCandidate: READ,
    lives: READ,
    release: READ,
    deliver: READ,
    "deliver.prepare": READ,
    debugExportCandidate: READ,
    capture: READ,
  },
  "session/useFailureRecording.ts": {
    settle: READ,
    "useFailureRecording.stopped": READ,
    "useFailureRecording.retire": READ,
  },
  "session/usePlayerCameras.ts": { useSessionCamera: CAMERA, usePlayerCameraLifecycle: CAMERA },
  "session/usePlayerSessionServices.ts": {
    usePlayerSessionServices: SERVICES,
    serviceCapture: SERVICES,
  },
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
/**
 * The other bindings of the host's body made from a raw resource, and why each is none: the check finds them from `RAW`
 * (`derivedBindings`), and a new one fails until it is a raw resource or named here (#1963 L4).
 */
const DERIVED: Readonly<Record<string, string>> = {
  resolvePackageAsset: "the host's asset resolver, from the options: no store",
  bridge: "the engine bridge, from the options: its requests are checked as host members",
  bridgeReady: "the bridge once ready, from the options: its requests are checked as host members",
  capturedMedia: "the media store, from the options: checked by `MEDIA`",
  room: "the room shown, from the options and the saved values: a value, no store",
  resolveTemporalContext: "the host's time zone source, from the options: no store",
  decodeImage: "the host's image decoder, from the options: no store",
  keptScope: "the saved values' scope, a name: no store",
  exportCandidate:
    "a debug export's candidate, reading the media store's photos through `readPhoto`: it writes no store",
};

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
  knownReferences: "owned",
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
  hasAllocatedTracingIntent: "local",
  nextRandomIntent: "local",
  nextHistoryIntent: "local",
  nextRun: "local",
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
  historyOpen: "host",
  historyTimeline: "host",
  historyStep: "host",
  releaseRecording: "host",
  captureExport: "host",
  exportPrepare: "host",
  retireRun: "host",
  commitIncident: "host",
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
  hostCall: "a host request outside an ownership's `admit`",
  hostRefused: "the connection's lifecycle",
  unreadable: "a member the check cannot read",
} as const;

/** The name a member access names, for `a.name` and `a["name"]`; `null` for a computed one. */
function memberName(node: ts.PropertyAccessExpression | ts.ElementAccessExpression): string | null {
  if (ts.isPropertyAccessExpression(node)) return node.name.text;
  return ts.isStringLiteralLike(node.argumentExpression) ? node.argumentExpression.text : null;
}

/** Whether `node`, a computed key, is a number: a position in a list, which names no member of a store or the host. */
function numeric(node: ts.Expression): boolean {
  const inner = unwrapped(node);
  if (ts.isNumericLiteral(inner)) return true;
  if (ts.isPrefixUnaryExpression(inner))
    return [ts.SyntaxKind.MinusToken, ts.SyntaxKind.PlusToken].includes(inner.operator);
  return (
    ts.isBinaryExpression(inner) &&
    [
      ts.SyntaxKind.MinusToken,
      ts.SyntaxKind.AsteriskToken,
      ts.SyntaxKind.SlashToken,
      ts.SyntaxKind.PercentToken,
    ].includes(inner.operatorToken.kind)
  );
}

/** `node` without the parentheses and type assertions around it, which change no value. */
function unwrapped(node: ts.Expression): ts.Expression {
  let inner = node;
  while (
    ts.isParenthesizedExpression(inner) ||
    ts.isAsExpression(inner) ||
    ts.isNonNullExpression(inner) ||
    ts.isSatisfiesExpression(inner) ||
    ts.isTypeAssertionExpression(inner)
  )
    inner = inner.expression;
  return inner;
}

/** The outermost wrapper of `node` that changes no value: the expression its context uses. */
function wrapped(node: ts.Expression): ts.Expression {
  let outer = node;
  while (
    (ts.isParenthesizedExpression(outer.parent) ||
      ts.isAsExpression(outer.parent) ||
      ts.isNonNullExpression(outer.parent) ||
      ts.isSatisfiesExpression(outer.parent) ||
      ts.isTypeAssertionExpression(outer.parent)) &&
    outer.parent.expression === outer
  )
    outer = outer.parent;
  return outer;
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
    (ts.isBindingElement(parent) && (parent.propertyName === node || parent.name === node))
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

/**
 * A use the check recognizes at `node`: a raw resource or the media store by name, a member of the host by an access or
 * a destructured property, or a member it cannot read (a computed key that is no number). The one recognizer of the
 * check: the inventory of places and the operations' check both read uses through it.
 */
type Use =
  | { readonly kind: "raw" | "media"; readonly node: ts.Identifier }
  | { readonly kind: "member"; readonly name: string; readonly node: ts.Node }
  | { readonly kind: "unreadable"; readonly node: ts.Node };
function useAt(node: ts.Node): Use | null {
  if (ts.isIdentifier(node) && !declared(node)) {
    if (RAW.has(node.text)) return { kind: "raw", node };
    if (node.text === MEDIA_STORE) return { kind: "media", node };
    return null;
  }
  if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
    const name = memberName(node);
    if (name === null)
      return ts.isElementAccessExpression(node) && numeric(node.argumentExpression)
        ? null
        : { kind: "unreadable", node };
    return HOST.has(name) ? { kind: "member", name, node } : null;
  }
  if (ts.isBindingElement(node) && ts.isObjectBindingPattern(node.parent)) {
    const key = node.propertyName ?? node.name;
    if (ts.isComputedPropertyName(key)) return { kind: "unreadable", node };
    const name = ts.isIdentifier(key) || ts.isStringLiteralLike(key) ? key.text : null;
    if (name === null) return { kind: "unreadable", node };
    return HOST.has(name) ? { kind: "member", name, node } : null;
  }
  return null;
}

/** Whether `node` sits inside the function given to `admit` of an operation's ownership. */
function insideAdmit(node: ts.Node): boolean {
  for (let current = node.parent; current !== undefined; current = current.parent)
    if (
      (ts.isArrowFunction(current) || ts.isFunctionExpression(current)) &&
      ts.isCallExpression(current.parent) &&
      ts.isPropertyAccessExpression(current.parent.expression) &&
      current.parent.expression.name.text === "admit" &&
      isOwnership(current.parent.expression.expression)
    )
      return true;
  return false;
}

/**
 * Whether `node` names an operation's ownership: an identifier of `OWNERSHIP_NAMES` whose nearest declaration is a
 * parameter of the type `PersistenceOwnership`, or a parameter or variable that `persistenceOwnership(...)` initializes.
 * An alias of anything else under such a name (`const owner = unrelated`) is none (#1963 L4).
 */
function isOwnership(node: ts.Node): boolean {
  if (!ts.isIdentifier(node) || !OWNERSHIP_NAMES.has(node.text)) return false;
  const declaration = nearestDeclaration(node);
  if (declaration === null) return false;
  const made =
    declaration.initializer !== undefined &&
    ts.isCallExpression(declaration.initializer) &&
    ts.isIdentifier(declaration.initializer.expression) &&
    declaration.initializer.expression.text === "persistenceOwnership";
  return (
    made ||
    (ts.isParameter(declaration) &&
      declaration.type !== undefined &&
      ts.isTypeReferenceNode(declaration.type) &&
      declaration.type.typeName.getText() === "PersistenceOwnership")
  );
}

/** The nearest parameter or variable declaring `node`'s name in the scopes around it, or `null` for none. */
function nearestDeclaration(
  node: ts.Identifier,
): ts.ParameterDeclaration | ts.VariableDeclaration | null {
  for (let scope: ts.Node | undefined = node.parent; scope !== undefined; scope = scope.parent) {
    if (ts.isFunctionLike(scope)) {
      const parameter = scope.parameters.find(
        (candidate) => ts.isIdentifier(candidate.name) && candidate.name.text === node.text,
      );
      if (parameter !== undefined) return parameter;
    }
    if (ts.isBlock(scope) || ts.isSourceFile(scope)) {
      for (const statement of scope.statements) {
        if (!ts.isVariableStatement(statement)) continue;
        const variable = statement.declarationList.declarations.find(
          (candidate) => ts.isIdentifier(candidate.name) && candidate.name.text === node.text,
        );
        if (variable !== undefined) return variable;
      }
    }
  }
  return null;
}

/** Why `use`, in an operation, is not admitted, or `null` where it is: the one deciding function of the check. */
function refusal(use: Use): string | null {
  switch (use.kind) {
    case "raw":
      return rawUse(use.node) ? WHY.raw : null;
    case "media":
      return mediaUse(use.node);
    case "unreadable":
      return WHY.unreadable;
    case "member":
      if (HOST.get(use.name) === "refused") return WHY.hostRefused;
      return insideAdmit(use.node) ? null : WHY.hostCall;
  }
}

/** Why the media store's use at `node` is not admitted, or `null` where it is. */
function mediaUse(node: ts.Identifier): string | null {
  const store = wrapped(node);
  const parent = store.parent;
  if (
    (ts.isPropertyAccessExpression(parent) || ts.isElementAccessExpression(parent)) &&
    parent.expression === store
  ) {
    const name = memberName(parent);
    const kind = name === null ? undefined : MEDIA_KINDS.get(name);
    if (kind === undefined) return WHY.mediaUnknown;
    if (kind === "memory") return null;
    if (kind === "refused") return WHY.mediaRefused;
    const call = wrapped(parent).parent;
    const owner =
      ts.isCallExpression(call) && call.expression === wrapped(parent)
        ? call.arguments[1]
        : undefined;
    return owner !== undefined && isOwnership(owner) ? null : WHY.mediaOwner;
  }
  if (
    ts.isCallExpression(parent) &&
    parent.arguments.includes(store) &&
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
  const resource = wrapped(node);
  const parent = resource.parent;
  // Its scope names the script: a field, not a call of the store.
  if (
    ts.isPropertyAccessExpression(parent) &&
    parent.expression === resource &&
    parent.name.text === "scope"
  )
    return false;
  // `keptStore()` is used as its result is.
  const use: ts.Expression =
    ts.isCallExpression(parent) && parent.expression === resource ? wrapped(parent) : resource;
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
    use === resource &&
    node.text === "storageRoute" &&
    ts.isExpressionStatement(context.parent)
  )
    return false;
  if (
    ts.isCallExpression(context) &&
    context.arguments.includes(use) &&
    ts.isPropertyAccessExpression(context.expression) &&
    HANDLES.has(context.expression.name.text) &&
    isOwnership(context.expression.expression)
  )
    return false;
  return true;
}

/** Each use in `body` the check does not admit, as `line: why: text`. */
function violations(source: ts.SourceFile, body: ts.Node): string[] {
  const found: string[] = [];
  const visit = (node: ts.Node) => {
    const use = useAt(node);
    const why = use === null ? null : refusal(use);
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
 * Every place of `source` with a use the recognizer finds outside an operation and the boundary, each with the first
 * line that has one.
 */
function consumers(source: ts.SourceFile, checked: ReadonlySet<string>): Map<string, number> {
  const found = new Map<string, number>();
  const visit = (node: ts.Node) => {
    if (useAt(node) !== null) {
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

/**
 * The bindings declared directly in the host's body (`usePlayerSession`) whose value is made from a raw resource,
 * functions apart: each binding's name.
 */
function derivedBindings(source: ts.SourceFile): string[] {
  let host: ts.FunctionDeclaration | undefined;
  ts.forEachChild(source, (node) => {
    if (ts.isFunctionDeclaration(node) && node.name?.text === "usePlayerSession") host = node;
  });
  const found: string[] = [];
  for (const statement of host?.body?.statements ?? []) {
    if (!ts.isVariableStatement(statement)) continue;
    for (const declaration of statement.declarationList.declarations) {
      const value = declaration.initializer;
      if (!ts.isIdentifier(declaration.name) || value === undefined) continue;
      if (ts.isArrowFunction(value) || ts.isFunctionExpression(value)) continue;
      let made = false;
      const visit = (node: ts.Node) => {
        if (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) return;
        if (ts.isIdentifier(node) && RAW.has(node.text) && !declared(node)) made = true;
        ts.forEachChild(node, visit);
      };
      visit(value);
      if (made) found.push(declaration.name.text);
    }
  }
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

/** The ownerships `source` makes, by operation, and each one it cannot read or place. */
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

/**
 * Each use the check does not admit in the operations of `text`, the module of the host at `module`, and each place of
 * it the tables of that module do not classify.
 */
function check(text: string, module = MAIN) {
  const source = ts.createSourceFile(module, text, ts.ScriptTarget.Latest, true);
  const found = operations(source);
  const failures = [...found].flatMap(([name, node]) =>
    violations(source, node).map((violation) => `${name}, line ${violation}`),
  );
  const reached = consumers(source, new Set(found.keys()));
  const outside = OUTSIDE[module] ?? {};
  const unclassified = [...reached]
    .filter(
      ([place]) =>
        !(module === MAIN && Object.hasOwn(UNBOUND, place)) && !Object.hasOwn(outside, place),
    )
    .map(([place, line]) => `${module}: ${place}, line ${line}`);
  return { found: new Set(found.keys()), failures, reached, unclassified, source };
}

/** Each module of the host, by its path under `player/vue/src`, as `check` reads it. */
const checkedModules = () =>
  HOST_MODULES().map((module) => ({
    module,
    ...check(readFileSync(resolve(process.cwd(), HOST_ROOT, module), "utf8"), module),
  }));

test("every persistence operation reaches stores and the host only through its ownership", () => {
  const modules = checkedModules();
  const found = new Set(modules.flatMap((checked) => [...checked.found]));
  for (const name of OPERATIONS) assert.ok(found.has(name), `${name} is an operation of the host`);
  const text = readFileSync(resolve(process.cwd(), HOST_ROOT, MAIN), "utf8");
  for (const name of Object.keys(UNBOUND))
    assert.ok(
      new RegExp(`async function ${name}\\((?![^)]*Ownership)`).test(text),
      `${name} is a helper of ${MAIN} that takes no ownership`,
    );
  assert.deepEqual(
    modules.flatMap(({ module, failures }) => failures.map((failure) => `${module}: ${failure}`)),
    [],
  );
});

test("every place of the host that reaches a store or the host is an operation, its boundary, or classified", () => {
  const modules = checkedModules();
  assert.deepEqual(
    modules.flatMap(({ unclassified }) => unclassified),
    [],
    "places no table classifies",
  );
  // Each module of the tables is one of the host, and each name a place it has, of one table alone.
  assert.deepEqual(
    Object.keys(OUTSIDE).filter((module) => !HOST_MODULES().includes(module)),
    [],
    "modules the host does not have",
  );
  for (const { module, reached, found } of modules) {
    const outside = Object.keys(OUTSIDE[module] ?? {});
    const unbound = module === MAIN ? Object.keys(UNBOUND) : [];
    for (const place of [...outside, ...unbound])
      assert.ok(reached.has(place), `${place} reaches no store or host in ${module}`);
    for (const place of outside) assert.ok(!found.has(place), `${place} takes an ownership`);
  }
  const main = [
    OPERATIONS,
    Object.keys(BOUNDARY),
    Object.keys(UNBOUND),
    Object.keys(OUTSIDE[MAIN] ?? {}),
  ].flat();
  assert.equal(new Set(main).size, main.length, "a place in two tables");
});

/**
 * Each read of an adoption's saved values (`captureStorage`) in `source`, and how its settlement is wired: a `.then`
 * whose reply and rejection callbacks each call `settleAdoption` and nothing else, awaited as it is, with nothing chained
 * after it; `settleAdoption` referenced nowhere else; and `settleAdoption`'s first statement returning unless
 * `ownsShown(...)` holds. What a settlement says is not seen here: that no stale failure notice shows once the page moved
 * on is the rewind read family's (`player-session-rewind.test.ts`).
 */
function adoptionSettlements(source: ts.SourceFile): { reads: number; problems: string[] } {
  const problems: string[] = [];
  let reads = 0;
  const line = (node: ts.Node) =>
    source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
  const settles = (callback: ts.Expression | undefined) =>
    callback !== undefined &&
    ts.isArrowFunction(callback) &&
    ts.isCallExpression(callback.body) &&
    ts.isIdentifier(callback.body.expression) &&
    callback.body.expression.text === "settleAdoption";
  // The `settleAdoption` references the admitted reads' callbacks make; any other is a second settlement.
  const admitted = new Set<ts.Node>();
  const visit = (node: ts.Node) => {
    if (
      ts.isIdentifier(node) &&
      node.text === "settleAdoption" &&
      !(ts.isFunctionDeclaration(node.parent) && node.parent.name === node) &&
      !admitted.has(node)
    )
      problems.push(
        `${line(node)}: settleAdoption is reached outside the adoption read's settlement`,
      );
    if (ts.isStringLiteralLike(node) && node.text === "captureStorage") {
      const read = node.parent;
      const access = read.parent;
      const then = access?.parent;
      if (
        ts.isCallExpression(read) &&
        read.arguments[1] === node &&
        ts.isPropertyAccessExpression(read.expression) &&
        read.expression.name.text === "read" &&
        ts.isPropertyAccessExpression(access) &&
        access.name.text === "then" &&
        ts.isCallExpression(then) &&
        then.arguments.length === 2 &&
        settles(then.arguments[0]) &&
        settles(then.arguments[1]) &&
        ts.isAwaitExpression(then.parent)
      ) {
        reads += 1;
        for (const callback of then.arguments)
          if (ts.isArrowFunction(callback) && ts.isCallExpression(callback.body))
            admitted.add(callback.body.expression);
      } else
        problems.push(
          `${line(node)}: a captureStorage read that does not settle only through settleAdoption`,
        );
    }
    if (ts.isFunctionDeclaration(node) && node.name?.text === "settleAdoption") {
      const first = node.body?.statements[0];
      const guarded =
        first !== undefined &&
        ts.isIfStatement(first) &&
        ts.isPrefixUnaryExpression(first.expression) &&
        ts.isCallExpression(first.expression.operand) &&
        ts.isIdentifier(first.expression.operand.expression) &&
        first.expression.operand.expression.text === "ownsShown" &&
        ts.isReturnStatement(first.thenStatement);
      if (!guarded)
        problems.push(`${line(node)}: settleAdoption does not begin with its ownership check`);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return { reads, problems };
}

test("an adoption's read reaches settleAdoption only from its two callbacks, with nothing chained after it, and settleAdoption begins with its ownership check", () => {
  const { reads, problems } = adoptionSettlements(
    ts.createSourceFile(
      MAIN,
      readFileSync(resolve(process.cwd(), HOST_ROOT, MAIN), "utf8"),
      ts.ScriptTarget.Latest,
      true,
    ),
  );
  assert.deepEqual(problems, []);
  assert.equal(reads, 1, "the adoption's one read");
  const of = (text: string) =>
    adoptionSettlements(ts.createSourceFile("a.ts", text, ts.ScriptTarget.Latest, true)).problems;
  // A rejection that skips it, a read awaited on its own, and an unguarded settlement are each found.
  assert.deepEqual(
    of(
      'host.read(s, "captureStorage").then((c) => settleAdoption(o, s, { capture: c }), () => false);',
    ),
    [
      "1: a captureStorage read that does not settle only through settleAdoption",
      "1: settleAdoption is reached outside the adoption read's settlement",
    ],
  );
  assert.equal(of('const c = await host.read(s, "captureStorage");').length, 1);
  assert.equal(of("async function settleAdoption() { await write(); }").length, 1);
  // A second settlement chained after the read's, which calls settleAdoption again, is found.
  const read =
    'await host.read(s, "captureStorage").then((c) => settleAdoption(o, s, { capture: c }), (e) => settleAdoption(o, s, { error: e }))';
  assert.deepEqual(of(`async function f() { ${read}; }`), []);
  assert.deepEqual(
    of(
      `async function f() { ${read.replace("await ", "await (")}).then((a) => a ? settleAdoption(o, s, { capture: c }) : false); }`,
    ),
    [
      "1: a captureStorage read that does not settle only through settleAdoption",
      "1: settleAdoption is reached outside the adoption read's settlement",
      "1: settleAdoption is reached outside the adoption read's settlement",
      "1: settleAdoption is reached outside the adoption read's settlement",
    ],
  );
});

test("every binding of the host made from a raw resource is one, the media store, or classified", () => {
  const source = ts.createSourceFile(
    MAIN,
    readFileSync(resolve(process.cwd(), HOST_ROOT, MAIN), "utf8"),
    ts.ScriptTarget.Latest,
    true,
  );
  const derived = derivedBindings(source);
  assert.deepEqual(
    derived.filter((name) => !RAW.has(name) && !Object.hasOwn(DERIVED, name)),
    [],
    "bindings made from a raw resource, unclassified",
  );
  for (const name of Object.keys(DERIVED))
    assert.ok(derived.includes(name), `${name} is no binding made from a raw resource`);
  // An alias of a raw resource is found.
  const alias = ts.createSourceFile(
    "alias.ts",
    "function usePlayerSession(options) {\n  const sessions = options.keptSessions;\n  const newStore = keptSessions;\n}",
    ts.ScriptTarget.Latest,
    true,
  );
  assert.deepEqual(derivedBindings(alias), ["sessions", "newStore"]);
});

test("each ownership the host makes belongs to an operation of the family, with the modes the family drives", () => {
  const modes = new Map<Operated, Set<Ownership>>();
  const failures: string[] = [];
  for (const { module, source } of checkedModules()) {
    const made = ownerships(source);
    failures.push(...made.failures.map((failure) => `${module}: ${failure}`));
    for (const [operation, found] of made.modes)
      modes.set(operation, new Set([...(modes.get(operation) ?? []), ...found]));
  }
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

/**
 * The forms a store or the host can be reached in, each with what the check can read of it: a member named and called
 * on the store itself (`direct`), one it names otherwise (an alias, a destructured property, `.call`), or none.
 */
const FORMS = {
  dot: { template: "await {O}.{M}({A});", reads: "direct" },
  literal: { template: 'await {O}["{M}"]({A});', reads: "direct" },
  parenthesized: { template: "await ({O}).{M}({A});", reads: "direct" },
  asserted: { template: "await ({O} as Store).{M}({A});", reads: "direct" },
  calleeParenthesized: { template: "await ({O}.{M})({A});", reads: "direct" },
  nested: { template: "const later = async () => { await {O}.{M}({A}); };", reads: "direct" },
  alias: { template: "const f = {O}.{M}; await f({A});", reads: "named" },
  call: { template: "await {O}.{M}.call({O}, {A});", reads: "named" },
  destructured: { template: "const { {M} } = {O}; await {M}({A});", reads: "binding" },
  renamed: { template: "const { {M}: f } = {O}; await f({A});", reads: "binding" },
  computed: { template: "await {O}[key]({A});", reads: "none" },
  computedAlias: { template: "const f = {O}[key]; await f({A});", reads: "none" },
  computedParenthesized: { template: "await ({O}[key])({A});", reads: "none" },
  computedBinding: { template: "const { [key]: f } = {O}; await f({A});", reads: "none" },
  computedCall: { template: "await {O}[key].call({O}, {A});", reads: "none" },
} as const satisfies Record<
  string,
  { template: string; reads: "direct" | "named" | "binding" | "none" }
>;
/** Where a form's use sits: in the operation's own code, in its ownership's `admit`, or in another object's `admit`. */
const CONTEXTS = {
  plain: (body: string) => body,
  admitted: (body: string) => `await ctx.admit(async () => { ${body} });`,
  otherAdmit: (body: string) => `await unrelated.admit(async () => { ${body} });`,
  aliasedAdmit: (body: string) =>
    `const owner = unrelated; await owner.admit(async () => { ${body} });`,
} as const;

// EVIDENCE: invariant: the keys of `FORMS` and `CONTEXTS`, declared literally above.
const FORM_NAMES = Object.keys(FORMS) as (keyof typeof FORMS)[];
// EVIDENCE: invariant: the keys of `FORMS` and `CONTEXTS`, declared literally above.
const CONTEXT_NAMES = Object.keys(CONTEXTS) as (keyof typeof CONTEXTS)[];

interface FormCase {
  readonly body: string;
  readonly refused: boolean;
  /** The resource or member, form and context the case reaches, for the coverage check. */
  readonly reaches: string;
}

/**
 * Whether a use of a host member of class `kind` in `form` and `context` is refused, by the rules the check states: a
 * member it cannot read never passes; a request of the host passes only in its ownership's `admit`; the connection's
 * lifecycle never; the bridge's own state always.
 */
function hostRefused(
  kind: string,
  form: keyof typeof FORMS,
  context: keyof typeof CONTEXTS,
): boolean {
  if (FORMS[form].reads === "none" || kind === "refused") return true;
  if (kind === "local") return false;
  return context !== "admitted";
}

/**
 * Whether a use of a media member of class `kind` in `form` is refused, `owned` when its call passes the ownership: a
 * member it cannot read, a destructured one, or the store handed to `.call` never passes; one in memory passes named on
 * the store; its repository passes only when called on the store with the ownership.
 */
function mediaRefused(kind: string, form: keyof typeof FORMS, owned: boolean): boolean {
  const reads = FORMS[form].reads;
  if (reads === "none" || reads === "binding" || form === "call" || kind === "refused") return true;
  if (kind === "memory") return false;
  return !(owned && reads === "direct");
}

/** Each form of use of each resource and member the check classifies, in each context, with whether it must fail. */
function formCases(): FormCase[] {
  const cases: FormCase[] = [];
  const add = (reaches: string, refused: boolean, ...bodies: string[]) =>
    bodies.forEach((body) => cases.push({ body, refused, reaches }));
  const fill = (form: keyof typeof FORMS, object: string, member: string, args: string) =>
    FORMS[form].template.replace(/\{([OMA])\}/g, (_, part: string) =>
      part === "O" ? object : part === "M" ? member : args,
    );
  for (const raw of RAW) {
    for (const form of FORM_NAMES)
      for (const context of CONTEXT_NAMES)
        add(
          `raw ${raw} ${form} ${context}`,
          true,
          CONTEXTS[context](fill(form, raw, "discard", "scope")),
        );
    add(
      `raw ${raw} shapes`,
      true,
      `const alias = ${raw};`,
      `const awaited = await (${raw});`,
      `const store = await ${raw}();`,
    );
    add(
      `raw ${raw} shapes`,
      false,
      `if (${raw} === other) return;`,
      `if ((${raw}) !== other) return;`,
      `await ctx.kept(${raw}).discard(scope);`,
      `const scope = ${raw}.scope;`,
    );
  }
  // An ownership is one by its declaration, not by its name (#1963 L4).
  add(
    "ownership binding",
    true,
    "const owner = unrelated;\nawait owner.kept(keptSessions).discard(scope);",
    "const owner = unrelated;\nawait capturedMedia.promote(references, owner);",
    'let ownership = unrelated;\nawait ownership.admit(() => host.client.request("planText", { plan }));',
  );
  add(
    "ownership binding",
    false,
    "const owner = persistenceOwnership();\nawait owner.kept(keptSessions).discard(scope);",
    'const owner = persistenceOwnership(null);\nawait owner.admit(() => host.client.request("planText", { plan }));',
  );
  // The storage route is awaited as a statement of its own, whose result nothing takes.
  add("raw storageRoute shapes", false, "await storageRoute;");
  add(
    "raw storageRoute shapes",
    true,
    "const route = await storageRoute;\nawait route.provider.load();",
  );
  for (const [member, kind] of Object.entries(MEDIA))
    for (const form of FORM_NAMES)
      for (const owned of [false, true])
        add(
          `media ${member} ${form} ${owned ? "owned" : "unowned"}`,
          mediaRefused(kind, form, owned),
          fill(form, MEDIA_STORE, member, owned ? "references, ctx" : "references"),
        );
  add(
    "media shapes",
    true,
    `const media = ${MEDIA_STORE};`,
    `await helper(${MEDIA_STORE});`,
    `await ${MEDIA_STORE}["unknown"](references);`,
  );
  for (const helper of Object.keys(MEDIA_HELPERS))
    add(
      "media shapes",
      false,
      `await ${helper}(storage, ${MEDIA_STORE}, script);`,
      `await ${helper}(storage, (${MEDIA_STORE}), script);`,
    );
  for (const member of new Set([...Object.keys(BRIDGE), ...Object.keys(CLIENT)])) {
    const kind = HOST.get(member) ?? "local";
    for (const form of FORM_NAMES)
      for (const context of CONTEXT_NAMES)
        add(
          `host ${member} ${form} ${context}`,
          hostRefused(kind, form, context),
          CONTEXTS[context](fill(form, "host.client", member, "plan")),
        );
  }
  return cases;
}

test("the check fails each form of use it does not admit, and admits each form it classifies as admitted", () => {
  const reasons = new Set<string>();
  const wrong: string[] = [];
  const cases = formCases();
  for (const { body, refused, reaches } of cases) {
    const { failures } = check(operation(body));
    if (failures.length > 0 !== refused)
      wrong.push(`${reaches}, ${refused ? "admitted" : "refused"}: ${body} ${failures.join("; ")}`);
    for (const failure of failures) reasons.add(failure.split(": ")[1]!);
  }
  assert.deepEqual(wrong, []);
  // The generated forms reach each resource and member the tables classify in every form and context, and every rule.
  const reached = new Set(cases.map(({ reaches }) => reaches));
  const expected = [
    ...[...RAW].flatMap((raw) =>
      Object.keys(FORMS).flatMap((form) =>
        Object.keys(CONTEXTS).map((context) => `raw ${raw} ${form} ${context}`),
      ),
    ),
    ...Object.keys(MEDIA).flatMap((member) =>
      Object.keys(FORMS).flatMap((form) =>
        ["owned", "unowned"].map((owned) => `media ${member} ${form} ${owned}`),
      ),
    ),
    ...[...new Set([...Object.keys(BRIDGE), ...Object.keys(CLIENT)])].flatMap((member) =>
      Object.keys(FORMS).flatMap((form) =>
        Object.keys(CONTEXTS).map((context) => `host ${member} ${form} ${context}`),
      ),
    ),
  ];
  assert.deepEqual(
    expected.filter((name) => !reached.has(name)),
    [],
    "forms no case reaches",
  );
  assert.deepEqual([...reasons].sort(), Object.values(WHY).sort());
});

test("the check finds an unclassified place, and an ownership no operation makes or it cannot read", () => {
  const unclassified = (body: string) =>
    check(`function host() {\n  async function sweepAll() {\n    ${body}\n  }\n}`).unclassified;
  assert.deepEqual(unclassified("await keptSessions.discard(scope);"), [
    `${MAIN}: sweepAll, line 3`,
  ]);
  // Every use the recognizer finds puts its place in the inventory: a destructured or computed host member too.
  for (const body of [
    'const { request } = bridge.client; await request("transferCommit", { ticket });',
    'const { [member]: request } = bridge.client; await request("transferCommit", { ticket });',
    'await bridge.client[member]("transferCommit", { ticket });',
    "await (capturedMedia as Store).read(reference);",
  ])
    assert.deepEqual(unclassified(body), [`${MAIN}: sweepAll, line 3`], body);
  // A position in a list names no member.
  assert.deepEqual(unclassified("const last = events[events.length - 1];"), []);
  const made = (text: string) =>
    ownerships(ts.createSourceFile("o.ts", text, ts.ScriptTarget.Latest, true)).failures;
  assert.equal(made("function other() { const ctx = persistenceOwnership(); }").length, 1);
  assert.equal(made("function keepOnce() { const ctx = persistenceOwnership(pick()); }").length, 1);
  assert.deepEqual(
    made("function keepOnce() { const owner = nextPreparation(); persistenceOwnership(owner); }"),
    [],
  );
});
