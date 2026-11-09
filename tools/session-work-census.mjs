// The census of session work in `player/` (L5i.5, R3): which entry points reach the engine bridge's sending surfaces,
// derived with the TypeScript language service, not listed by hand. The boundary is read from the code: every member
// of the `BridgeClient` interface and every function the in-process facade exports. The test walks the sending ones but
// `section`, which takes the scene clock's ticket: leaving it out fails type-checking (#1983). The type does not decide
// where a ticket came from (a check-disabling construct makes one, a `BridgeClient` wrapper keeps one). Discovery walks
// references backwards from each sending surface (`findReferences`): a function that calls a surface directly is a forwarder, and
// its callers are walked in turn. Where the walk ends is an entry point: a named function nothing in `player/` calls,
// an anonymous function passed as a value (a callback), or a reference that is not a direct call (an escape: a value
// passed, bound or stored). An object literal's property that holds a forwarder is followed through its property's
// references, and reported as an escape too, so the admit-list names it; a destructured binding that declares the
// variable a shorthand property returns is no reference of that property. The test that runs the census
// (`tests/player-session-work-census.test.ts`) holds the classifications; this tool only discovers.

import { readdirSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import ts from "typescript";

/** The files the census reads: the Player's TypeScript, outside its build output. */
const inScope = (path) =>
  path.startsWith("player/") && path.endsWith(".ts") && !path.endsWith(".d.ts");

/**
 * A census over the sources under `root`, whose files `overrides` (path relative to `root` → text) may replace or add,
 * as a scratch copy does. `run` reads the overrides as they are when it is called.
 */
export function createSessionWorkCensus(root) {
  const base = resolve(root);
  const rel = (file) => relative(base, file).split("\\").join("/");
  // The Player's own configuration, which holds the composables and their DOM types; every Player module is a root.
  const config = ts.getParsedCommandLineOfConfigFile(
    join(base, "player/vue/tsconfig.json"),
    {},
    {
      ...ts.sys,
      onUnRecoverableConfigFileDiagnostic: (diagnostic) => {
        throw new Error(ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"));
      },
    },
  );
  const overrides = new Map();
  let version = 0;
  const versions = new Map();
  const sources = (function list(directory) {
    return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
      const path = join(directory, entry.name);
      if (entry.isDirectory())
        return entry.name === "node_modules" || entry.name === "dist" ? [] : list(path);
      return inScope(rel(path)) ? [path] : [];
    });
  })(join(base, "player"));
  const roots = () => [
    ...new Set([
      ...sources,
      ...[...overrides.keys()].filter(inScope).map((path) => join(base, path)),
    ]),
  ];
  const text = (file) => overrides.get(rel(file)) ?? ts.sys.readFile(file);
  const host = {
    getScriptFileNames: roots,
    getScriptVersion: (file) => String(versions.get(rel(file)) ?? 0),
    getScriptSnapshot: (file) => {
      const content = text(file);
      return content === undefined ? undefined : ts.ScriptSnapshot.fromString(content);
    },
    getCurrentDirectory: () => base,
    getCompilationSettings: () => config.options,
    getDefaultLibFileName: (options) => ts.getDefaultLibFilePath(options),
    fileExists: (file) => overrides.has(rel(file)) || ts.sys.fileExists(file),
    readFile: text,
    readDirectory: ts.sys.readDirectory,
    directoryExists: ts.sys.directoryExists,
    getDirectories: ts.sys.getDirectories,
  };
  const service = ts.createLanguageService(host, ts.createDocumentRegistry());

  return {
    /** Replaces the overrides (path → text) for the next `run`; an empty map restores the sources as they are. */
    setOverrides(next) {
      for (const path of new Set([...overrides.keys(), ...Object.keys(next)]))
        versions.set(path, ++version);
      overrides.clear();
      for (const [path, content] of Object.entries(next)) overrides.set(path, content);
    },
    /**
     * Walks back from `surfaces`, each `{ name, file, member? }`: the member `member` of the interface or class `name`
     * in `file`, or the exported function `name` of `file`. With `within`, a path prefix, only references in files
     * under it are walked. Returns the boundary as the code declares it, and what the walk found.
     */
    run(surfaces, { within = "player/" } = {}) {
      const program = service.getProgram();
      if (program === undefined) throw new Error("The census has no program.");
      return walk(service, program, base, rel, surfaces, within);
    },
    /**
     * Every use in `player/` of each target `{ file, path }`: the declaration at `path` in `file`, as the census names
     * places (`useRuntimeSceneClock > observe`). Each use is `{ file, path, use }`, `use` being how the value is used:
     * `awaited`, `returned`, `handled` (its promise's rejection handled at once), `voided` (discarded with `void`),
     * `exposed` (an object literal's property, followed), or what else it is (`unawaited` for a call whose result
     * nobody takes).
     */
    uses(targets) {
      const program = service.getProgram();
      if (program === undefined) throw new Error("The census has no program.");
      return usesOf(service, program, base, rel, targets);
    },
    /** The program the census reads, with the overrides as they are now, and its root; for other checks to share. */
    program() {
      const program = service.getProgram();
      if (program === undefined) throw new Error("The census has no program.");
      return { program, root: base };
    },
  };
}

function usesOf(service, program, base, rel, targets) {
  const found = [];
  const queue = targets.map((target) => {
    const file = program.getSourceFile(join(base, target.file));
    if (file === undefined) throw new Error(`The census has no file ${target.file}.`);
    let name;
    (function visit(node) {
      const binding = isFunctionLike(node) ? bindingName(node) : undefined;
      if (binding !== undefined && name === undefined && pathOf(binding, file) === target.path)
        name = binding;
      node.forEachChild(visit);
    })(file);
    if (name === undefined) throw new Error(`No ${target.path} in ${target.file}.`);
    return { path: target.file, node: name, target: `${target.file} ${target.path}` };
  });
  const seen = new Set();
  const places = new Set();
  while (queue.length > 0) {
    const { path, node, target } = queue.shift();
    const key = `${path}:${node.getStart()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    for (const symbol of service.findReferences(join(base, path), node.getStart()) ?? [])
      for (const entry of symbol.references) {
        if (entry.isDefinition || !inScope(rel(entry.fileName))) continue;
        const file = program.getSourceFile(entry.fileName);
        const at = tokenAt(file, entry.textSpan.start);
        if (at === undefined || isTypeOrModuleReference(at) || isDeclarationName(at)) continue;
        const where = rel(entry.fileName);
        // One place is one use, also when two symbols (a function and its shorthand property) both list it.
        const place = `${target} ${where}:${at.getStart()}`;
        if (places.has(place)) continue;
        places.add(place);
        const holder = propertyHolding(at);
        if (holder !== undefined) queue.push({ path: where, node: holder, target });
        found.push({
          target,
          file: where,
          path: pathOf(at, file),
          use: holder !== undefined ? "exposed" : useOf(at),
        });
      }
  }
  return found.sort((one, other) =>
    `${one.target} ${one.file} ${one.path}` < `${other.target} ${other.file} ${other.path}`
      ? -1
      : 1,
  );
}

/** How the value `node` names is used, for `uses`. */
function useOf(node) {
  const call = directCall(node);
  if (call === undefined) return escapeKind(node);
  let outer = call.parent;
  while (outer !== undefined && ts.isParenthesizedExpression(outer)) outer = outer.parent;
  if (outer === undefined) return "unawaited";
  if (ts.isAwaitExpression(outer)) return "awaited";
  if (ts.isVoidExpression(outer)) return "voided";
  if (ts.isReturnStatement(outer) || (ts.isArrowFunction(outer) && outer.body === call))
    return "returned";
  if (
    ts.isPropertyAccessExpression(outer) &&
    ["catch", "then"].includes(outer.name.text) &&
    ts.isCallExpression(outer.parent)
  )
    return "handled";
  return "unawaited";
}

function walk(service, program, base, rel, surfaces, within) {
  const sourceOf = (path) => {
    const file = program.getSourceFile(join(base, path));
    if (file === undefined) throw new Error(`The census has no file ${path}.`);
    return file;
  };
  const boundary = { interfaces: {}, exports: {} };
  const starts = [];
  for (const surface of surfaces) {
    const file = sourceOf(surface.file);
    if (surface.member !== undefined) {
      const declaration = file.statements.find(
        (statement) =>
          (ts.isInterfaceDeclaration(statement) || ts.isClassDeclaration(statement)) &&
          statement.name?.text === surface.name,
      );
      if (declaration === undefined) throw new Error(`No ${surface.name} in ${surface.file}.`);
      const members = declaration.members.filter((member) => member.name !== undefined);
      boundary.interfaces[`${surface.file}#${surface.name}`] = members
        .filter((member) => !isPrivate(member))
        .map((member) => member.name.getText(file));
      const member = members.find((each) => each.name.getText(file) === surface.member);
      if (member === undefined)
        throw new Error(`No ${surface.name}.${surface.member} in ${surface.file}.`);
      starts.push({
        origin: `${surface.name}.${surface.member}`,
        file: surface.file,
        node: member.name,
      });
    } else {
      boundary.exports[surface.file] ??= file.statements
        .filter(
          (statement) =>
            ts.isFunctionDeclaration(statement) &&
            statement.name !== undefined &&
            statement.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword),
        )
        .map((statement) => statement.name.text);
      const declaration = file.statements.find(
        (statement) => ts.isFunctionDeclaration(statement) && statement.name?.text === surface.name,
      );
      if (declaration === undefined)
        throw new Error(`No function ${surface.name} in ${surface.file}.`);
      starts.push({ origin: surface.name, file: surface.file, node: declaration.name });
    }
  }

  const references = new Map();
  const referencesOf = (path, node) => {
    const key = `${path}:${node.getStart()}`;
    if (!references.has(key)) {
      const found = service.findReferences(join(base, path), node.getStart()) ?? [];
      references.set(
        key,
        found
          .flatMap((symbol) => symbol.references)
          .filter(
            (entry) =>
              !entry.isDefinition &&
              inScope(rel(entry.fileName)) &&
              rel(entry.fileName).startsWith(within),
          ),
      );
    }
    return references.get(key);
  };

  const forwarders = new Map();
  const entries = new Map();
  const escapes = new Map();
  const add = (map, key, value) => {
    const found = map.get(key);
    const { origin, ...rest } = value;
    if (found === undefined) map.set(key, { ...rest, origins: new Set([origin]) });
    else found.origins.add(value.origin);
  };

  for (const start of starts) {
    const seen = new Set();
    const queue = [{ path: start.file, node: start.node }];
    while (queue.length > 0) {
      const { path, node } = queue.shift();
      const key = `${path}:${node.getStart()}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const found = referencesOf(path, node);
      let called = false;
      for (const entry of found) {
        const file = program.getSourceFile(entry.fileName);
        const at = tokenAt(file, entry.textSpan.start);
        if (at === undefined || isTypeOrModuleReference(at) || isDeclarationName(at)) continue;
        // A shorthand property's own variable, declared by destructuring, is no caller of the property.
        if (declaresShorthand(program.getTypeChecker(), node, at)) continue;
        const where = rel(entry.fileName);
        const call = directCall(at);
        if (call === undefined) {
          const holder = propertyHolding(at);
          const path = `${pathOf(at.parent, file)} {${at.getText(file)}}`;
          const kind = escapeKind(at);
          add(escapes, `${where} ${path} [${kind}]`, {
            origin: start.origin,
            file: where,
            path,
            kind,
            line: lineOf(file, at),
          });
          // An object literal's property is followed: its references are the forwarder's callers.
          if (holder !== undefined) queue.push({ path: where, node: holder });
          called = true;
          continue;
        }
        called = true;
        // An anonymous function passed as a value is an entry point of its own (a callback), and the named function
        // around it, which passes it, is walked as a forwarder too: it may call the callback itself.
        let enclosing = enclosingFunction(call);
        const inCallback = enclosing !== undefined && bindingName(enclosing) === undefined;
        if (inCallback) {
          const path = pathOf(enclosing.body ?? enclosing, file);
          add(entries, `${where} ${path}`, {
            origin: start.origin,
            file: where,
            path,
            kind: "callback",
            line: lineOf(file, enclosing),
          });
          while (enclosing !== undefined && bindingName(enclosing) === undefined)
            enclosing = enclosingFunction(enclosing);
        }
        if (enclosing === undefined) {
          // A call at a module's or a class field's top level, outside any callback, is an entry point of its own.
          if (!inCallback)
            add(entries, `${where} (module)`, {
              origin: start.origin,
              file: where,
              path: "(module)",
              kind: "module",
            });
          continue;
        }
        const name = bindingName(enclosing);
        add(forwarders, `${where} ${pathOf(name, file)}`, {
          origin: start.origin,
          file: where,
          path: pathOf(name, file),
        });
        queue.push({ path: where, node: name });
      }
      // A named function nothing in `player/` calls is an entry point itself.
      if (!called && node !== start.node) {
        const file = program.getSourceFile(join(base, path));
        const label = `${path} ${pathOf(node, file)}`;
        add(entries, label, {
          origin: start.origin,
          file: path,
          path: pathOf(node, file),
          kind: "uncalled",
          line: lineOf(file, node),
        });
      }
    }
  }
  const listed = (map) =>
    [...map.values()]
      .map((each) => ({ ...each, origins: [...each.origins].sort() }))
      .sort((one, other) => (`${one.file} ${one.path}` < `${other.file} ${other.path}` ? -1 : 1));
  return {
    boundary,
    forwarders: listed(forwarders),
    entries: listed(entries),
    escapes: listed(escapes),
  };
}

/** The 1-based line of `node`, for a reader of the census; no key holds it. */
const lineOf = (file, node) => file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1;

function isPrivate(member) {
  return (
    ts.isPrivateIdentifier(member.name) ||
    member.modifiers?.some(
      (modifier) =>
        modifier.kind === ts.SyntaxKind.PrivateKeyword ||
        modifier.kind === ts.SyntaxKind.ProtectedKeyword,
    ) === true
  );
}

function tokenAt(file, position) {
  let found;
  (function visit(node) {
    if (position < node.getStart(file) || position >= node.getEnd()) return;
    if (ts.isIdentifier(node) || ts.isPrivateIdentifier(node) || ts.isStringLiteral(node))
      found = node;
    node.forEachChild(visit);
  })(file);
  return found;
}

/** Whether `node` names something in a type, an import or an export, not a value the code uses. */
function isTypeOrModuleReference(node) {
  for (let at = node.parent; at !== undefined; at = at.parent) {
    if (
      ts.isTypeNode(at) ||
      ts.isImportSpecifier(at) ||
      ts.isExportSpecifier(at) ||
      ts.isImportClause(at)
    )
      return true;
    if (ts.isExpression(at) || ts.isStatement(at)) return false;
  }
  return false;
}

/** The call whose callee `node` names directly (`f(...)`, `a.f(...)`, `a?.f(...)`), or `undefined`. */
function directCall(node) {
  let callee = node;
  if (
    (ts.isPropertyAccessExpression(node.parent) || ts.isPropertyAccessChain?.(node.parent)) &&
    node.parent.name === node
  )
    callee = node.parent;
  const call = callee.parent;
  return call !== undefined && ts.isCallExpression(call) && call.expression === callee
    ? call
    : undefined;
}

/**
 * For an escape that is an object literal's property value or a destructured binding, the name whose references are
 * followed: the property's, or the binding's.
 */
function propertyHolding(node) {
  const parent = node.parent;
  if (ts.isShorthandPropertyAssignment(parent) && parent.name === node) return parent.name;
  if (ts.isPropertyAssignment(parent) && parent.initializer === node) return parent.name;
  if (ts.isBindingElement(parent) && (parent.propertyName === node || parent.name === node))
    return parent.name;
  return undefined;
}

/**
 * Whether `at` is the destructured binding that declares the variable the shorthand property `node` holds, which
 * `findReferences` on the property lists as a reference: `const { a } = owner; return { a };`.
 */
function declaresShorthand(checker, node, at) {
  if (!ts.isShorthandPropertyAssignment(node.parent) || !ts.isBindingElement(at.parent))
    return false;
  const value = checker.getShorthandAssignmentValueSymbol(node.parent);
  return value?.declarations?.includes(at.parent) === true;
}

/** Whether `node` is the name a declaration or a type member declares, which `findReferences` lists as a reference. */
function isDeclarationName(node) {
  const parent = node.parent;
  return (
    (ts.isFunctionDeclaration(parent) ||
      ts.isMethodDeclaration(parent) ||
      ts.isMethodSignature(parent) ||
      ts.isPropertySignature(parent) ||
      ts.isPropertyDeclaration(parent) ||
      ts.isVariableDeclaration(parent)) &&
    parent.name === node
  );
}

function escapeKind(node) {
  const parent = node.parent;
  if (ts.isShorthandPropertyAssignment(parent) || ts.isPropertyAssignment(parent))
    return "property";
  if (ts.isBindingElement(parent)) return "destructured";
  if (ts.isCallExpression(parent) || ts.isNewExpression(parent)) return "argument";
  if (ts.isPropertyAccessExpression(parent) && parent.name === node) {
    const outer = parent.parent;
    if (ts.isPropertyAccessExpression(outer) && ["bind", "call", "apply"].includes(outer.name.text))
      return "bound";
    if (ts.isCallExpression(outer) || ts.isNewExpression(outer)) return "argument";
    if (ts.isShorthandPropertyAssignment(outer) || ts.isPropertyAssignment(outer))
      return "property";
  }
  if (ts.isVariableDeclaration(parent) || ts.isBinaryExpression(parent)) return "stored";
  if (ts.isReturnStatement(parent) || ts.isArrowFunction(parent)) return "returned";
  return ts.SyntaxKind[parent.kind];
}

function isFunctionLike(node) {
  return (
    ts.isFunctionDeclaration(node) ||
    ts.isMethodDeclaration(node) ||
    ts.isArrowFunction(node) ||
    ts.isFunctionExpression(node) ||
    ts.isGetAccessorDeclaration(node) ||
    ts.isSetAccessorDeclaration(node) ||
    ts.isConstructorDeclaration(node)
  );
}

function enclosingFunction(node) {
  for (let at = node.parent; at !== undefined; at = at.parent) if (isFunctionLike(at)) return at;
  return undefined;
}

/** The name a function is called by: its own, or the variable or property it is the value of; else `undefined`. */
function bindingName(fn) {
  if (
    (ts.isFunctionDeclaration(fn) ||
      ts.isMethodDeclaration(fn) ||
      ts.isGetAccessorDeclaration(fn)) &&
    fn.name
  )
    return fn.name;
  const parent = fn.parent;
  if ((ts.isArrowFunction(fn) || ts.isFunctionExpression(fn)) && parent !== undefined) {
    if (ts.isVariableDeclaration(parent) && ts.isIdentifier(parent.name)) return parent.name;
    if (ts.isPropertyAssignment(parent) && parent.initializer === fn) return parent.name;
    if (ts.isPropertyDeclaration(parent) && parent.initializer === fn) return parent.name;
  }
  return undefined;
}

/** Where `node` is, as the names of what encloses it: functions, methods, classes and the properties that hold them. */
function pathOf(node, file) {
  const parts = [];
  for (let at = node; at !== undefined && at !== file; at = at.parent) {
    if (ts.isClassDeclaration(at) && at.name) parts.push(at.name.text);
    else if (
      (ts.isFunctionDeclaration(at) ||
        ts.isMethodDeclaration(at) ||
        ts.isGetAccessorDeclaration(at)) &&
      at.name
    )
      parts.push(at.name.getText(file));
    else if (ts.isConstructorDeclaration(at)) parts.push("constructor");
    else if (
      ts.isVariableDeclaration(at) &&
      ts.isIdentifier(at.name) &&
      at.initializer !== undefined &&
      isFunctionLike(at.initializer)
    )
      parts.push(at.name.text);
    else if (
      ts.isPropertyAssignment(at) ||
      ts.isPropertyDeclaration(at) ||
      ts.isShorthandPropertyAssignment(at)
    )
      parts.push(at.name.getText(file));
    else if (
      (ts.isArrowFunction(at) || ts.isFunctionExpression(at)) &&
      bindingName(at) === undefined
    )
      parts.push(callbackLabel(at, file));
  }
  return parts.reverse().join(" > ");
}

const calleeName = (call, file) =>
  ts.isPropertyAccessExpression(call.expression)
    ? call.expression.name.getText(file)
    : call.expression.getText(file);

/**
 * An anonymous function's label: what it is passed to, numbered among the calls of that name in the same enclosing
 * function that pass a function, in source order, and among that call's function arguments.
 */
function callbackLabel(fn, file) {
  const parent = fn.parent;
  if (parent === undefined || !(ts.isCallExpression(parent) || ts.isNewExpression(parent)))
    return "function";
  const name = calleeName(parent, file);
  const scope = enclosingFunction(parent) ?? file;
  const calls = [];
  (function visit(node) {
    if (node !== scope && isFunctionLike(node) && node !== fn && !hasAncestor(parent, node)) return;
    if ((ts.isCallExpression(node) || ts.isNewExpression(node)) && calleeName(node, file) === name)
      if (
        (node.arguments ?? []).some((argument) => isFunctionLike(argument)) &&
        enclosingFunction(node) === enclosingFunction(parent)
      )
        calls.push(node);
    node.forEachChild(visit);
  })(scope);
  const order = calls.indexOf(parent);
  const functions = (parent.arguments ?? []).filter((argument) => isFunctionLike(argument));
  const position = functions.length > 1 ? `.${functions.indexOf(fn) + 1}` : "";
  return `${name}:callback${calls.length > 1 ? `#${order + 1}` : ""}${position}`;
}

function hasAncestor(node, ancestor) {
  for (let at = node; at !== undefined; at = at.parent) if (at === ancestor) return true;
  return false;
}
