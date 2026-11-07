import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import ts from "typescript";

/*
 * The persistence operations of the Player's session host (`player/vue/src/usePlayerSession.ts`: keep, the kept
 * session's restore, the session import) reach the page's stores and the host only through their ownership's handles
 * (`player/persistence-ownership.ts`), so a stale operation's call is refused wherever it is made. This check reads the
 * operations' syntax tree, with every closure nested in them, and fails a use of a raw resource there. It covers the
 * operations' own code, not a helper they call: a new branch inside a helper still needs a source review.
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
];

/** Where an ownership is made or bound to the raw resources: the boundary, which the check leaves out, and why. */
const BOUNDARY: Readonly<Record<string, string>> = {
  persistenceOwnership:
    "makes an operation's ownership from the page's room, store, tenure and preparation",
  operationStorage: "binds the routed saved values to an operation's ownership",
  owned: "runs an operation and ends its registration; it touches no store",
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
/** Media-store methods that reach its repository: an operation passes them its ownership. */
const OWNED_MEDIA = new Set(["promote", "storedReferences"]);
/** Host calls, which an operation makes through `admit`. */
const HOST_CALLS = new Set(["read", "restoreKept", "request"]);

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

/** Each use of a raw resource or an unowned call in `body`, as `line: text`. */
function violations(source: ts.SourceFile, body: ts.Node): string[] {
  const found: string[] = [];
  const report = (node: ts.Node, why: string) => {
    const { line } = source.getLineAndCharacterOfPosition(node.getStart(source));
    found.push(`${line + 1}: ${why}: ${node.getText(source).split("\n")[0]}`);
  };
  const visit = (node: ts.Node) => {
    if (ts.isIdentifier(node) && RAW.has(node.text) && rawUse(node)) report(node, "a raw resource");
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      ts.isIdentifier(node.expression.expression) &&
      node.expression.expression.text === "capturedMedia"
    ) {
      const method = node.expression.name.text;
      if (method === "read") report(node, "the media store's read");
      const owner = node.arguments[1];
      if (
        OWNED_MEDIA.has(method) &&
        (owner === undefined || !ts.isIdentifier(owner) || !OWNERSHIP_NAMES.has(owner.text))
      )
        report(node, "the media store without the ownership");
    }
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      HOST_CALLS.has(node.expression.name.text) &&
      !insideAdmit(node)
    )
      report(node, "a host call outside `admit`");
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(body, visit);
  return found;
}

/**
 * Whether the identifier `node` uses a raw resource other than to compare it, bind it to a handle, or wait for the
 * storage route as a statement of its own, whose result nothing takes.
 */
function rawUse(node: ts.Identifier): boolean {
  const parent = node.parent;
  // A property's name or a declared name is not the resource.
  if (ts.isPropertyAccessExpression(parent) && parent.name === node) return false;
  if (ts.isPropertyAssignment(parent) && parent.name === node) return false;
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

/** Each use of a raw resource or an unowned call in the operations of `text`, as `name, line …`. */
function check(text: string, path = "operations.ts"): { found: Set<string>; failures: string[] } {
  const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true);
  const found = operations(source);
  const failures = [...found].flatMap(([name, node]) =>
    violations(source, node).map((violation) => `${name}, line ${violation}`),
  );
  return { found: new Set(found.keys()), failures };
}

test("every persistence operation reaches stores and the host only through its ownership", () => {
  const path = resolve(process.cwd(), SOURCE);
  const { found, failures } = check(readFileSync(path, "utf8"), path);
  for (const name of OPERATIONS) assert.ok(found.has(name), `${name} is in ${SOURCE}`);
  assert.deepEqual(failures, []);
});

/** An operation of the host whose body is `body`. */
const operation = (body: string) =>
  `function host() {\n  async function keepIn(ctx: PersistenceOwnership) {\n${body}\n  }\n}`;

test("the check fails a raw resource, an alias of one, an unowned media call and a host call outside admit", () => {
  const refused = {
    "a raw call": "await keptSessions.discard(scope);",
    "a raw call in a nested closure":
      "const later = async () => { await debugRooms.discardSession(scope); };",
    "an alias": "const sessions = keptSessions;\nawait sessions.publish(scope, update);",
    "an awaited alias": "const sessions = await keptSessions;\nawait sessions.discard(scope);",
    "an awaited store": "const store = await keptStore();\nawait store.discard(scope);",
    "the route's result": "const route = await storageRoute;\nawait route.provider.load();",
    "a promotion without the ownership": "await capturedMedia.promote(references, undefined);",
    "a lookup without the ownership": "await capturedMedia.storedReferences(references);",
    "the media store's read": "await capturedMedia.read(reference);",
    "a host call outside admit": "await host.restoreKept(plan, json, snapshot, events);",
  };
  for (const [what, body] of Object.entries(refused))
    assert.notDeepEqual(check(operation(body)).failures, [], what);
  const admitted = [
    "await ctx.kept(keptSessions).discard(scope);",
    "await ctx.rooms(debugRooms).discardSession(scope);",
    "await storageRoute;",
    "if (keptStore() === keptSessions) await ctx.kept(keptStore()).discard(scope);",
    "await capturedMedia.promote(references, ctx);",
    "await ctx.admit(() => host.restoreKept(plan, json, snapshot, events));",
  ];
  for (const body of admitted) assert.deepEqual(check(operation(body)).failures, [], body);
});
