// The checks of activation work (session split S2's HEAD 0), over the program the session-work census builds
// (`createSessionWorkCensus(…).program()`). They read every module in `player/vue/src/session/activation/work/` and
// enforce its documented wiring forms, with a closed default: a form they do not know fails.
//
// 1. Imports: a value import names a symbol the declarations admit for its module; type-only imports stay. Side-effect,
//    default, namespace and computed imports, re-exports and module-initialization effects are refused.
// 2. Holders: an activation record (`Origin`) is held only as a function's plain formal, and used only forwarded to a
//    resolved call, or read in the trusted adapter. Returned, boxed or stored records, reassigned formals, a getter of
//    records, unresolved calls, reflection, assertions, `any` and unclassified exports are refused.
// 3. Shapes: each protocol interface has exactly its declared operations and data; the types its operations and the
//    entries take and give hold no raw bridge, session, ref, callable or accessor in a data position (index-signature
//    values included), and no carrier the declarations do not name.
// 4. Discovery: each work entry's call sites, awaits, callbacks and hooks, by the symbol each call resolves to, and
//    those of every work helper it calls or holds (parameter defaults included), followed by symbol once per entry; a
//    call to anything but the work's own protocol, its own functions or a promise's reactions fails.
// 5. Callback boundaries: outside the adapter, a function value is a local `const`, a handler of a declared handler
//    object, or a reaction, handler or body passed to a promise or a protocol operation. (`no-floating-promises` with `ignoreVoid: false` owns the chains' ends.)
//
// These are syntax and shape rules: they do not prove what a trusted adapter does, nor when a callback runs.
// The declarations (what is admitted) are the caller's: `tests/helpers/player/activation-work-checks.ts` holds them.

import { relative } from "node:path";
import ts from "typescript";

export const WORK = "player/vue/src/session/activation/work/";
const RECORD = "player/vue/src/session/activation/useActivationRun.ts";
const RECORDS = new Set(["InitialOrigin", "RunOrigin"]);
const REFLECTION = new Set(["Reflect", "Proxy", "eval", "globalThis", "Function"]);
const REFLECTIVE_MEMBERS = new Set([
  "apply",
  "bind",
  "call",
  "defineProperties",
  "defineProperty",
  "getOwnPropertyDescriptor",
  "getOwnPropertyDescriptors",
  "getPrototypeOf",
  "setPrototypeOf",
  "__proto__",
]);
const REACTIONS = new Set(["then", "catch", "finally"]);

/**
 * Runs the checks over `program` (rooted at `root`) with `declared`:
 * `{ valueImports, moduleState, exports, protocol, handles, carriers }` (see the declarations module).
 * Returns `{ refusals, exports, sites }`: each refusal `{ check, at, form }`, every export `file name`, and every
 * discovered site of the work entries, as sorted keys.
 */
export function checkActivationWork(program, root, declared) {
  const checker = program.getTypeChecker();
  const rel = (file) => relative(root, file).split("\\").join("/");
  const files = program
    .getSourceFiles()
    .filter((file) => rel(file.fileName).startsWith(WORK))
    .sort((a, b) => rel(a.fileName).localeCompare(rel(b.fileName)));
  const refusals = [];
  const exports = [];
  const sites = new Set();
  for (const file of files) {
    const path = rel(file.fileName);
    const at = (node) =>
      `${path}:${file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1}`;
    const refuse = (check, node, form) => refusals.push({ check, at: at(node), form });
    const context = { checker, rel, path, file, declared, refuse };
    imports(context);
    holders(context, exports);
    shapes(context);
    discover(context, sites);
    if (!declared.adapters.includes(path)) callbacks(context);
  }
  return {
    refusals: refusals.sort((a, b) => `${a.at} ${a.form}`.localeCompare(`${b.at} ${b.form}`)),
    exports: exports.sort(),
    sites: [...sites].sort(),
  };
}

// 1. Imports and module initialization.
function imports({ checker, rel, path, file, declared, refuse }) {
  const admitted = declared.valueImports[path] ?? {};
  const state = declared.moduleState[path] ?? [];
  for (const statement of file.statements) {
    if (ts.isImportDeclaration(statement)) {
      const source = checker.getSymbolAtLocation(statement.moduleSpecifier)?.valueDeclaration;
      const from = source !== undefined && ts.isSourceFile(source) ? rel(source.fileName) : null;
      const clause = statement.importClause;
      if (from === null) refuse("imports", statement, "unresolved import");
      else if (clause === undefined) refuse("imports", statement, "side-effect import");
      else if (!clause.isTypeOnly) {
        if (clause.name !== undefined) refuse("imports", statement, "default import");
        if (clause.namedBindings !== undefined && ts.isNamespaceImport(clause.namedBindings))
          refuse("imports", statement, "namespace import");
        else
          for (const element of clause.namedBindings?.elements ?? []) {
            const name = (element.propertyName ?? element.name).text;
            if (!element.isTypeOnly && !(admitted[from] ?? []).includes(name))
              refuse("imports", element, `value import ${name} from ${from}`);
          }
      }
    } else if (
      ts.isInterfaceDeclaration(statement) ||
      ts.isTypeAliasDeclaration(statement) ||
      (ts.isFunctionDeclaration(statement) && statement.body !== undefined)
    ) {
      if (ambient(statement)) refuse("imports", statement, "ambient declaration");
    } else if (ts.isClassDeclaration(statement)) {
      if (!plainClass(statement)) refuse("imports", statement, "class initialization");
    } else if (ts.isVariableStatement(statement)) {
      const constant = (statement.declarationList.flags & ts.NodeFlags.Const) !== 0;
      for (const each of statement.declarationList.declarations) {
        const init = each.initializer;
        const fn =
          init !== undefined && (ts.isArrowFunction(init) || ts.isFunctionExpression(init));
        const held =
          init !== undefined &&
          ts.isNewExpression(init) &&
          ts.isIdentifier(init.expression) &&
          init.expression.text === "WeakMap" &&
          (init.arguments ?? []).length === 0 &&
          ts.isIdentifier(each.name) &&
          state.includes(each.name.text);
        if (!constant || !(fn || held)) refuse("imports", each, "module initialization");
      }
    } else refuse("imports", statement, "module initialization");
  }
  visit(file, (node) => {
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword)
      refuse("imports", node, "computed import");
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === "require"
    )
      refuse("imports", node, "computed import");
  });
}

const ambient = (node) => (ts.getCombinedModifierFlags(node) & ts.ModifierFlags.Ambient) !== 0;

function plainClass(node) {
  const heritage = (node.heritageClauses ?? []).every((clause) =>
    clause.types.every((type) => ts.isIdentifier(type.expression)),
  );
  return (
    heritage &&
    !ambient(node) &&
    (ts.getDecorators(node) ?? []).length === 0 &&
    node.members.every(
      (member) =>
        !ts.isClassStaticBlockDeclaration(member) &&
        (ts.getCombinedModifierFlags(member) & ts.ModifierFlags.Static) === 0 &&
        (member.name === undefined || !ts.isComputedPropertyName(member.name)),
    )
  );
}

// 2. Holders, reflection, assertions and exports.
function holders({ checker, path, file, declared, refuse }, exports) {
  const adapter = declared.adapters.includes(path);
  const roles = declared.exports[path] ?? {};
  for (const statement of file.statements) {
    const exported = (ts.getCombinedModifierFlags(statement) & ts.ModifierFlags.Export) !== 0;
    if (!exported) continue;
    const names = ts.isVariableStatement(statement)
      ? statement.declarationList.declarations.map((each) => each.name.getText(file))
      : [statement.name?.getText(file) ?? "default"];
    for (const name of names) {
      exports.push(`${path} ${name}`);
      if (!Object.hasOwn(roles, name)) refuse("holders", statement, `unclassified export ${name}`);
    }
  }
  visit(file, (node) => {
    if (ts.isAsExpression(node) && !isConstAssertion(node)) refuse("holders", node, "assertion");
    if (ts.isTypeAssertionExpression(node) || ts.isNonNullExpression(node))
      refuse("holders", node, "assertion");
    if (ts.isGetAccessorDeclaration(node) || ts.isSetAccessorDeclaration(node))
      refuse("holders", node, "accessor");
    if (ts.isElementAccessExpression(node)) refuse("holders", node, "computed access");
    if (ts.isPropertyAccessExpression(node) && REFLECTIVE_MEMBERS.has(node.name.text))
      refuse("holders", node, "reflection");
    if (!ts.isIdentifier(node) || !isValue(node)) return;
    if (REFLECTION.has(node.text) && isGlobal(checker, node)) refuse("holders", node, "reflection");
    const type = checker.getTypeAtLocation(node);
    if ((type.flags & ts.TypeFlags.Any) !== 0) refuse("holders", node, "erased type");
    if (type.getCallSignatures().some((signature) => isRecord(signature.getReturnType())))
      refuse("holders", node, "record getter");
    if (!isRecord(type)) return;
    const symbol = ts.isShorthandPropertyAssignment(node.parent)
      ? checker.getShorthandAssignmentValueSymbol(node.parent)
      : checker.getSymbolAtLocation(node);
    const declaration = symbol?.valueDeclaration ?? symbol?.declarations?.[0];
    if (declaration === undefined) return refuse("holders", node, "unresolved record");
    if (declaration === node.parent && ts.isParameter(declaration)) {
      if (
        declaration.initializer !== undefined ||
        declaration.questionToken !== undefined ||
        declaration.dotDotDotToken !== undefined
      )
        refuse("holders", node, "record formal with a default");
      return;
    }
    if (!ts.isParameter(declaration)) return refuse("holders", node, "stored record");
    const use = node.parent;
    if (ts.isCallExpression(use) && use.arguments.includes(node)) {
      if (callee(checker, use) === undefined) refuse("holders", node, "unresolved call");
    } else if (ts.isPropertyAccessExpression(use) && use.expression === node) {
      if (!adapter) refuse("holders", node, "record read");
    } else if (ts.isBinaryExpression(use) && use.left === node)
      refuse("holders", node, "writable alias");
    else if (ts.isReturnStatement(use) || (ts.isArrowFunction(use) && use.body === node))
      refuse("holders", node, "returned record");
    else if (ts.isVariableDeclaration(use) && use.initializer === node)
      refuse("holders", node, "stored record");
    else if (
      ts.isPropertyAssignment(use) ||
      ts.isShorthandPropertyAssignment(use) ||
      ts.isArrayLiteralExpression(use) ||
      ts.isSpreadElement(use)
    )
      refuse("holders", node, "boxed record");
    else refuse("holders", node, "record use");
  });
}

const isConstAssertion = (node) =>
  ts.isTypeReferenceNode(node.type) && node.type.typeName.getText() === "const";

/** Whether `node` is a value the code uses, not a declaration's name, a member name, or part of a type. */
function isValue(node, member = false) {
  const parent = node.parent;
  if (ts.isPartOfTypeNode(node)) return false;
  if ((ts.isPropertyAccessExpression(parent) || ts.isQualifiedName(parent)) && parent.name === node)
    return member;
  if (ts.isParameter(parent) && parent.name === node) return true;
  if (ts.isShorthandPropertyAssignment(parent)) return true;
  if (ts.isDeclarationName(node)) return false;
  if (ts.isImportSpecifier(parent) || ts.isImportClause(parent)) return false;
  if (ts.isPropertyAssignment(parent) && parent.name === node) return false;
  return true;
}

function isGlobal(checker, node) {
  const declaration = checker.getSymbolAtLocation(node)?.declarations?.[0];
  return declaration === undefined || declaration.getSourceFile().isDeclarationFile;
}

function isRecord(type) {
  return (type.isUnion() ? type.types : [type]).some((each) => {
    const symbol = each.aliasSymbol ?? each.getSymbol();
    const declaration = symbol?.declarations?.[0];
    return (
      symbol !== undefined &&
      RECORDS.has(symbol.name) &&
      declaration !== undefined &&
      declaration.getSourceFile().fileName.endsWith(RECORD)
    );
  });
}

function callee(checker, call) {
  const declaration = checker.getResolvedSignature(call)?.getDeclaration();
  return declaration === undefined || declaration.kind === ts.SyntaxKind.JSDocSignature
    ? undefined
    : declaration;
}

// 3. Shapes.
function shapes({ checker, path, file, declared, refuse }) {
  const roles = declared.exports[path] ?? {};
  const { operation, data } = typeWalk(checker, declared, refuse);
  for (const statement of file.statements) {
    const name = statement.name?.getText(file);
    if (name === undefined) continue;
    const role = roles[name];
    if (role === "protocol" && ts.isInterfaceDeclaration(statement)) {
      const expected = declared.protocol[name] ?? {};
      const found = {};
      for (const member of statement.members) {
        const key = member.name?.getText(file) ?? "";
        const type = checker.getTypeAtLocation(member);
        found[key] =
          ts.isMethodSignature(member) || type.getCallSignatures().length > 0
            ? "operation"
            : "data";
        if (expected[key] !== found[key])
          refuse("shapes", member, `protocol member ${name}.${key} (${found[key]})`);
        if (found[key] === "operation")
          for (const signature of type.getCallSignatures())
            operation(signature, `${name}.${key}`, member);
        else data(type, `${name}.${key}`, member);
      }
      for (const key of Object.keys(expected))
        if (!Object.hasOwn(found, key))
          refuse("shapes", statement, `missing protocol member ${name}.${key}`);
    } else if (role === "data") {
      data(checker.getTypeAtLocation(statement.name), name, statement);
    } else if (role === "entry" && ts.isFunctionDeclaration(statement)) {
      const signature = checker.getSignatureFromDeclaration(statement);
      if (signature !== undefined) operation(signature, name, statement);
    }
  }
}

/** The walks of operation signatures, carriers and plain data that `shapes` reads protocol types with. */
function typeWalk(checker, declared, refuse) {
  // An operation's parameters and result: handles and records pass; a callable parameter is a hook, read in turn.
  function operation(signature, at, node) {
    signature.getParameters().forEach((parameter, index) => {
      const type = checker.getTypeOfSymbolAtLocation(parameter, node);
      carrier(type, `${at}(${index})`, node, true);
    });
    carrier(signature.getReturnType(), `${at}→`, node, false);
  }

  function carrier(type, at, node, formal) {
    for (const each of type.isUnion() ? type.types : [type]) {
      if (isRecord(each)) {
        if (!formal) refuse("shapes", node, `record in a result: ${at}`);
        continue;
      }
      const name = named(each);
      if (name !== null && declared.handles.includes(name)) continue;
      if (name !== null && (declared.carriers[name] ?? []).includes(at)) continue;
      if (name === "Promise") {
        const [inner] = checker.getTypeArguments(each);
        if (inner !== undefined) carrier(inner, at, node, formal);
        continue;
      }
      if (name !== null && Object.hasOwn(declared.protocol, name)) {
        if (!formal) refuse("shapes", node, `protocol in a result: ${at}`);
        continue;
      }
      if (each.isIntersection() && formal) {
        for (const part of each.types) carrier(part, at, node, formal);
        continue;
      }
      const signatures = each.getCallSignatures();
      if (signatures.length > 0) {
        if (!formal) refuse("shapes", node, `callable in a result: ${at}`);
        for (const signature of signatures) operation(signature, at, node);
        continue;
      }
      // A page an entry takes, declared inline beside its protocol: its members read as a protocol's.
      const literal = each.getSymbol()?.declarations?.[0];
      if (
        formal &&
        literal !== undefined &&
        ts.isTypeLiteralNode(literal) &&
        literal.getSourceFile() === node.getSourceFile()
      ) {
        for (const property of each.getProperties()) {
          const type = checker.getTypeOfSymbolAtLocation(property, node);
          const member = `${at}.${property.name}`;
          if (type.getCallSignatures().length === 0) data(type, member, node);
          for (const signature of type.getCallSignatures()) operation(signature, member, node);
        }
        continue;
      }
      data(each, at, node);
    }
  }

  // Plain data: primitives, literals, arrays and objects of plain data; nothing callable, accessed or opaque.
  function data(type, at, node, seen = new Set()) {
    if (seen.has(type)) return;
    seen.add(type);
    const flags = type.flags;
    if (
      flags &
      (ts.TypeFlags.StringLike |
        ts.TypeFlags.NumberLike |
        ts.TypeFlags.BooleanLike |
        ts.TypeFlags.BigIntLike |
        ts.TypeFlags.Null |
        ts.TypeFlags.Undefined |
        ts.TypeFlags.Void |
        ts.TypeFlags.Unknown |
        ts.TypeFlags.Never |
        ts.TypeFlags.TypeParameter)
    )
      return;
    if (flags & ts.TypeFlags.Any) return refuse("shapes", node, `erased type in data: ${at}`);
    if (type.isUnion() || type.isIntersection()) {
      for (const each of type.types) data(each, at, node, seen);
      return;
    }
    const name = named(type);
    if (name !== null && (declared.carriers[name] ?? []).includes(at)) return;
    if (isRecord(type)) return refuse("shapes", node, `record in data: ${at}`);
    if (checker.isArrayType(type) || checker.isTupleType(type)) {
      for (const each of checker.getTypeArguments(type)) data(each, `${at}[]`, node, seen);
      return;
    }
    if (type.getCallSignatures().length > 0 || type.getConstructSignatures().length > 0)
      return refuse("shapes", node, `callable in data: ${at}`);
    const symbol = type.getSymbol();
    if (
      !(flags & ts.TypeFlags.Object) ||
      (symbol !== undefined && (symbol.flags & ts.SymbolFlags.Class) !== 0)
    )
      return refuse(
        "shapes",
        node,
        `unknown carrier in data: ${at} (${checker.typeToString(type)})`,
      );
    for (const property of type.getProperties()) {
      const declaration = property.valueDeclaration ?? property.declarations?.[0];
      if (property.escapedName.toString().startsWith("__@"))
        return refuse(
          "shapes",
          node,
          `unknown carrier in data: ${at} (${checker.typeToString(type)})`,
        );
      if (
        declaration !== undefined &&
        (ts.isGetAccessorDeclaration(declaration) || ts.isSetAccessorDeclaration(declaration))
      ) {
        refuse("shapes", node, `accessor in data: ${at}.${property.name}`);
        continue;
      }
      data(checker.getTypeOfSymbolAtLocation(property, node), `${at}.${property.name}`, node, seen);
    }
    // An index signature's values are data too.
    for (const info of checker.getIndexInfosOfType(type))
      data(info.type, `${at}[${checker.typeToString(info.keyType)}]`, node, seen);
  }
  return { operation, carrier, data };
}

/** The name of a declared type, or `null` for an anonymous one. */
function named(type) {
  const symbol = type.aliasSymbol ?? type.getSymbol();
  if (symbol === undefined) return null;
  const name = symbol.name;
  return name.startsWith("__") ? null : name;
}

// 4. Discovery: each work entry's sites, by the symbol each call resolves to, through the work's own helpers.
function discover({ checker, rel, path, file, declared, refuse }, sites) {
  const roles = declared.exports[path] ?? {};
  for (const statement of file.statements) {
    if (!ts.isFunctionDeclaration(statement) || statement.name === undefined) continue;
    const entry = statement.name.text;
    if (roles[entry] !== "entry") continue;
    // A helper the entry calls or holds, in a work module, is walked as the entry's own, once per entry.
    const walked = new Set([statement]);
    const walk = (fn, prefix) => {
      const site = (node, kind, name = "") =>
        sites.add(
          `${path} ${entry}${prefix}${label(node, fn)}: ${kind}${name === "" ? "" : ` ${name}`}`,
        );
      const follow = (node, declaration, name) => {
        const helper = helperOf(declaration);
        if (helper === null || walked.has(helper) || hasAncestor(helper, statement)) return;
        walked.add(helper);
        walk(helper, `${prefix}${label(node, fn)} > ${name}`);
      };
      const inspect = (node) => {
        if (ts.isAwaitExpression(node))
          site(node, "await", node.expression.getText(file).split("(")[0]);
        if (isFunction(node)) site(node, "callback");
        // A function passed or held as a value, not called here: a hook, which its holder may call later.
        if (
          (ts.isIdentifier(node) || ts.isPropertyAccessExpression(node)) &&
          isValue(ts.isPropertyAccessExpression(node) ? node.name : node, true) &&
          !isCallee(node) &&
          checker.getTypeAtLocation(node).getCallSignatures().length > 0
        ) {
          const symbol = checker.getSymbolAtLocation(
            ts.isPropertyAccessExpression(node) ? node.name : node,
          );
          const declaration = symbol?.valueDeclaration ?? symbol?.declarations?.[0];
          const held =
            declaration === undefined ? null : classify(rel, declared, hookOf(declaration));
          if (held === null) refuse("discovery", node, `unknown hook ${node.getText(file)}`);
          else {
            site(node, "hook", held.name);
            follow(node, hookOf(declaration), held.name);
          }
        }
        if (!ts.isCallExpression(node) && !ts.isNewExpression(node)) return;
        const declaration = callee(checker, node);
        const kind = declaration === undefined ? null : classify(rel, declared, declaration);
        if (kind === null)
          return refuse("discovery", node, `unknown edge ${node.expression.getText(file)}`);
        site(node, kind.kind, kind.name);
        if (kind.kind === "work" || kind.kind === "local") follow(node, declaration, kind.name);
      };
      // A helper's parameter defaults run as it is called: they are its own, as its body is.
      for (const parameter of fn.parameters)
        if (parameter.initializer !== undefined) visit(parameter.initializer, inspect);
      visit(fn.body, inspect);
    };
    walk(statement, "");
  }
}

/** The function a work or local call names, whose body discovery walks, or `null` (a declaration without one). */
function helperOf(declaration) {
  if (ts.isFunctionDeclaration(declaration) && declaration.body !== undefined) return declaration;
  if (isFunction(declaration) && declaration.body !== undefined) return declaration;
  return null;
}

/** Whether `node` is the callee of a call, or the object of a member access. */
function isCallee(node) {
  const parent = node.parent;
  return (
    ((ts.isCallExpression(parent) || ts.isNewExpression(parent)) && parent.expression === node) ||
    (ts.isPropertyAccessExpression(parent) && parent.expression === node) ||
    (ts.isPropertyAccessExpression(parent) && parent.name === node)
  );
}

/** The declaration a held function names: a property signature's function type, or a `const` function's own. */
function hookOf(declaration) {
  if (ts.isPropertySignature(declaration) && declaration.type !== undefined)
    return declaration.type;
  if (ts.isVariableDeclaration(declaration) && declaration.initializer !== undefined)
    return declaration.initializer;
  return declaration;
}

function classify(rel, declared, declaration) {
  const source = declaration.getSourceFile();
  const from = rel(source.fileName);
  const member = memberOf(declaration);
  if (source.isDeclarationFile && /lib\.[a-z0-9.]+\.d\.ts$/.test(source.fileName)) {
    if (member !== null && member.container === "Promise" && REACTIONS.has(member.name))
      return { kind: "reaction", name: member.name };
    if (member !== null && member.container === "PromiseConstructor")
      return { kind: "promise", name: member.name };
    return null;
  }
  if (!from.startsWith(WORK)) return null;
  if (member !== null) {
    const kind = declared.handles.includes(member.container) ? "action" : "page";
    return { kind, name: `${member.container}.${member.name}` };
  }
  if (ts.isFunctionDeclaration(declaration) && declaration.name !== undefined)
    return { kind: "work", name: declaration.name.text };
  if (isFunction(declaration) && ts.isVariableDeclaration(declaration.parent))
    return { kind: "local", name: declaration.parent.name.getText() };
  return null;
}

/** The interface or type literal member a signature is declared as, and its container's name. */
function memberOf(declaration) {
  let node = declaration;
  if (ts.isFunctionTypeNode(node)) node = node.parent;
  if (!(ts.isMethodSignature(node) || ts.isPropertySignature(node))) return null;
  const owner = node.parent;
  const name = node.name.getText();
  if (ts.isInterfaceDeclaration(owner)) return { container: owner.name.text, name };
  if (ts.isTypeLiteralNode(owner)) {
    let holder = owner.parent;
    while (holder !== undefined && !ts.isParameter(holder)) holder = holder.parent;
    const fn = holder?.parent;
    return fn !== undefined && ts.isFunctionDeclaration(fn) && fn.name !== undefined
      ? { container: `${fn.name.text}:${holder.name.getText()}`, name }
      : null;
  }
  return null;
}

/** Where `node` is inside `entry`: the chain of callbacks around it, each named by what holds it. */
function label(node, entry) {
  const parts = [];
  for (let at = node; at !== entry; at = at.parent)
    if (isFunction(at) && at !== node) parts.unshift(callbackName(at));
  if (isFunction(node)) parts.push(callbackName(node));
  return parts.map((part) => ` > ${part}`).join("");
}

function callbackName(fn) {
  const parent = fn.parent;
  if (ts.isVariableDeclaration(parent)) return parent.name.getText();
  if (ts.isPropertyAssignment(parent)) return parent.name.getText();
  if (ts.isCallExpression(parent)) {
    const callee = parent.expression;
    const name = ts.isPropertyAccessExpression(callee) ? callee.name.text : callee.getText();
    const index = parent.arguments.filter(isFunction).indexOf(fn) + 1;
    return `${name}:callback#${index}`;
  }
  return "callback";
}

// 5. Callback boundaries.
function callbacks({ checker, rel, declared, file, refuse }) {
  visit(file, (node) => {
    if (!isFunction(node) || ts.isFunctionDeclaration(node)) return;
    const parent = node.parent;
    if (ts.isVariableDeclaration(parent) && ts.isVariableDeclarationList(parent.parent)) {
      if ((parent.parent.flags & ts.NodeFlags.Const) === 0)
        refuse("callbacks", node, "writable callback");
      return;
    }
    // A handler of a declared handler object (`const handlers: ReplyHandlers<T> = { … }`), which the work passes to a
    // protocol operation.
    if (
      ts.isPropertyAssignment(parent) &&
      ts.isObjectLiteralExpression(parent.parent) &&
      ts.isVariableDeclaration(parent.parent.parent) &&
      (parent.parent.parent.parent.flags & ts.NodeFlags.Const) !== 0 &&
      parent.parent.parent.type !== undefined &&
      ts.isTypeReferenceNode(parent.parent.parent.type) &&
      declared.handlerObjects.includes(parent.parent.parent.type.typeName.getText())
    )
      return;
    const call =
      ts.isPropertyAssignment(parent) && ts.isObjectLiteralExpression(parent.parent)
        ? parent.parent.parent
        : parent;
    if (!ts.isCallExpression(call)) return refuse("callbacks", node, "callback boundary");
    const declaration = callee(checker, call);
    const kind = declaration === undefined ? null : classify(rel, declared, declaration);
    if (kind === null || !["reaction", "action", "page"].includes(kind.kind))
      refuse("callbacks", node, "callback boundary");
  });
}

const isFunction = (node) =>
  ts.isArrowFunction(node) ||
  ts.isFunctionExpression(node) ||
  ts.isFunctionDeclaration(node) ||
  ts.isMethodDeclaration(node);

function visit(node, fn) {
  fn(node);
  ts.forEachChild(node, (child) => visit(child, fn));
}

function hasAncestor(node, ancestor) {
  for (let at = node.parent; at !== undefined; at = at.parent) if (at === ancestor) return true;
  return false;
}
