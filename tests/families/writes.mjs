// node tests/families/writes.mjs [<checkout>]
// Every filesystem write of the stored baselines' tools (#1542), computed rather than listed: the modules are the node
// entry points tools/corpus/baseline.sh runs and every module they import; in them, each binding of `fs` (`node:fs`,
// `fs/promises`: named, default, namespace, destructured, aliased, promisified, `import()`ed) and each call through one
// that creates, writes, appends, renames, links, unlinks, truncates or removes is a site. A site is named as a stack
// frame names its call (`<file>:<line>:<column>`) and has a kind:
// - `gate`: in `gate` (baselines.mjs), in a function passed to `gate`, or in a function only those call;
// - `outside`: each path it writes is proven to lie outside every baseline, made by `outside(…)` (checked to lie in
//   no folder of baselines and no baseline) or by `beside(…)` (a `.`-named folder beside the baselines), or inside one
//   made by `beside`, through constants and the arguments of every call of a function;
// - `creation`: a folder made beside the baselines in that function, renamed into a folder of baselines (onto no
//   folder or an empty one);
// - `unproven`: none of these.
// Any other use of an fs binding (passed on, stored, indexed by a computed name) is an escape. Also lists each child
// process started and each module loaded by a computed name. Prints it all as one JSON object.
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const MODULES = {
  fs: ["fs", "node:fs"],
  promises: ["fs/promises", "node:fs/promises"],
  processes: ["child_process", "node:child_process"],
  util: ["util", "node:util"],
  path: ["path", "node:path"],
};

/** The fs functions that write, each with the arguments that name what it writes (in its `Sync` and promise forms too). */
const WRITERS = new Map(
  Object.entries({
    writeFile: [0],
    appendFile: [0],
    mkdir: [0],
    mkdtemp: [0],
    rename: [0, 1],
    link: [1],
    symlink: [1],
    unlink: [0],
    rm: [0],
    rmdir: [0],
    copyFile: [1],
    cp: [1],
    truncate: [0],
    ftruncate: [0],
    createWriteStream: [0],
    write: [0],
    writev: [0],
    open: [0],
  }),
);
const opOf = (name) => (name.endsWith("Sync") ? name.slice(0, -4) : name);
const literal = (node) =>
  node !== undefined && ts.isStringLiteralLike(node) ? node.text : undefined;

/** Whether a call of the fs function `name` writes: a writer (an `open` only with flags other than `r`), or any call given a `flag` or `flags` other than `r`. */
function writes(name, call) {
  const op = opOf(name);
  if (op === "open")
    return !(
      call.arguments[1] === undefined || ["r", "rs", "sr"].includes(literal(call.arguments[1]))
    );
  if (WRITERS.has(op)) return true;
  return call.arguments.some(
    (argument) =>
      ts.isObjectLiteralExpression(argument) &&
      argument.properties.some(
        (property) =>
          ["flag", "flags"].includes(property.name?.getText()) &&
          !(ts.isPropertyAssignment(property) && literal(property.initializer) === "r"),
      ),
  );
}

/** The tools' modules: the node entry points the hook runs, then every module they import by a relative name. */
function modulesOf(checkout) {
  const hook = readFileSync(path.join(checkout, "tools", "corpus", "baseline.sh"), "utf8");
  const pending = [...hook.matchAll(/(?:tests\/families|\$modules)\/([\w.-]+\.mjs)/g)].map(
    ([, name]) => path.join(checkout, "tests", "families", name),
  );
  const files = new Set();
  while (pending.length > 0) {
    const file = pending.pop();
    if (files.has(file)) continue;
    files.add(file);
    const visit = (node) => {
      const specifier =
        ts.isImportDeclaration(node) || ts.isExportDeclaration(node)
          ? node.moduleSpecifier
          : ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword
            ? node.arguments[0]
            : undefined;
      if (literal(specifier)?.startsWith("."))
        pending.push(path.resolve(path.dirname(file), literal(specifier)));
      ts.forEachChild(node, visit);
    };
    visit(ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true));
  }
  return [...files].sort();
}

const isFunction = (node) =>
  ts.isFunctionDeclaration(node) ||
  ts.isFunctionExpression(node) ||
  ts.isArrowFunction(node) ||
  ts.isMethodDeclaration(node) ||
  ts.isAccessor(node) ||
  ts.isConstructorDeclaration(node);
const strip = (node) =>
  ts.isParenthesizedExpression(node) || ts.isAwaitExpression(node) || ts.isNonNullExpression(node)
    ? strip(node.expression)
    : node;
/** The function a node is in, or its module. */
const contextOf = (node) => {
  for (let at = node.parent; at !== undefined; at = at.parent) if (isFunction(at)) return at;
  return node.getSourceFile();
};
/** The name of a function, as its declaration or the constant it initialises names it. */
const nameNodeOf = (fn) =>
  ts.isFunctionDeclaration(fn)
    ? fn.name
    : ts.isVariableDeclaration(fn.parent) && ts.isIdentifier(fn.parent.name)
      ? fn.parent.name
      : undefined;
const isConstant = (declaration) =>
  ts.isVariableDeclaration(declaration) &&
  (declaration.parent.flags & ts.NodeFlags.Const) !== 0 &&
  declaration.initializer !== undefined;

/** The writes, child processes and computed imports of the tools in `checkout`. */
export function inventory(checkout = process.cwd()) {
  const files = modulesOf(checkout);
  const program = ts.createProgram(files, {
    allowJs: true,
    noEmit: true,
    noLib: true,
    types: [],
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
  });
  const checker = program.getTypeChecker();
  const sources = files.map((file) => program.getSourceFile(file));
  const local = (node) => checker.getSymbolAtLocation(node);
  const target = (symbol) => {
    if (symbol === undefined || (symbol.flags & ts.SymbolFlags.Alias) === 0) return symbol;
    const aliased = checker.getAliasedSymbol(symbol);
    return aliased.declarations?.length ? aliased : symbol;
  };
  const where = (node) => {
    const at = node.getSourceFile().getLineAndCharacterOfPosition(node.getStart());
    return `${path.relative(checkout, node.getSourceFile().fileName)}:${at.line + 1}:${at.character + 1}`;
  };
  const named = (node) => {
    for (let at = contextOf(node); !ts.isSourceFile(at); at = contextOf(at))
      if (nameNodeOf(at) !== undefined) return nameNodeOf(at).text;
    return "(top level)";
  };
  const text = (node) => node.getText().replace(/\s+/g, " ");
  const escapes = [];
  const escape = (node, why) =>
    escapes.push({ site: where(node), function: named(node), why, code: text(node) });

  // every identifier, by the symbol it names (an import by what it imports)
  const identifiers = [];
  for (const source of sources) {
    const visit = (node) => {
      if (ts.isIdentifier(node)) identifiers.push(node);
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  const declares = (node) =>
    (ts.isImportSpecifier(node.parent) ||
      ts.isExportSpecifier(node.parent) ||
      ts.isImportClause(node.parent) ||
      ts.isNamespaceImport(node.parent) ||
      ts.isBindingElement(node.parent) ||
      ts.isVariableDeclaration(node.parent) ||
      ts.isFunctionDeclaration(node.parent) ||
      ts.isParameter(node.parent)) &&
    node.parent.name === node;
  const references = new Map();
  for (const node of identifiers) {
    if (declares(node)) continue;
    const symbol = target(local(node));
    if (symbol !== undefined) references.set(symbol, [...(references.get(symbol) ?? []), node]);
  }

  // the bindings of the modules above: a module itself, or one function of it
  const bindings = new Map();
  const member = (of, key) =>
    of === "fs" && key === "promises"
      ? { module: "promises" }
      : of === "util" && key === "promisify"
        ? { promisify: true }
        : ["fs", "promises", "processes"].includes(of) && key !== "constants"
          ? { of, name: key }
          : undefined;
  const valueOf = (expression) => {
    const node = strip(expression);
    if (ts.isIdentifier(node)) return bindings.get(local(node));
    if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
      const key = ts.isPropertyAccessExpression(node)
        ? node.name.text
        : literal(node.argumentExpression);
      const base = valueOf(node.expression);
      return base?.module !== undefined && key !== undefined ? member(base.module, key) : undefined;
    }
    if (ts.isCallExpression(node)) {
      if (node.expression.kind === ts.SyntaxKind.ImportKeyword) {
        const from = Object.keys(MODULES).find((key) =>
          MODULES[key].includes(literal(node.arguments[0])),
        );
        return from === undefined ? undefined : { module: from };
      }
      if (valueOf(node.expression)?.promisify && node.arguments[0] !== undefined) {
        const promisified = valueOf(node.arguments[0]);
        return promisified?.name !== undefined ? promisified : undefined;
      }
    }
    return undefined;
  };
  for (const source of sources)
    for (const statement of source.statements) {
      if (!ts.isImportDeclaration(statement) || statement.importClause === undefined) continue;
      const from = Object.keys(MODULES).find((key) =>
        MODULES[key].includes(literal(statement.moduleSpecifier)),
      );
      const clause = statement.importClause;
      if (["module", "node:module"].includes(literal(statement.moduleSpecifier)))
        escape(statement, "a module loader, through which a module escapes this list");
      if (from === undefined) continue;
      if (clause.name !== undefined) bindings.set(local(clause.name), { module: from });
      const imported = clause.namedBindings;
      if (imported !== undefined && ts.isNamespaceImport(imported))
        bindings.set(local(imported.name), { module: from });
      if (imported !== undefined && ts.isNamedImports(imported))
        for (const element of imported.elements) {
          const value = member(from, (element.propertyName ?? element.name).text);
          if (value !== undefined) bindings.set(local(element.name), value);
        }
    }
  // constants that name a module or a function of one: an alias, a destructuring, a promisified function
  for (let more = true; more;) {
    more = false;
    for (const node of identifiers) {
      const declaration = node.parent;
      if (
        !ts.isVariableDeclaration(declaration) ||
        declaration.name !== node ||
        !declaration.initializer
      )
        continue;
      const value = valueOf(declaration.initializer);
      if (value !== undefined && !bindings.has(local(node))) {
        bindings.set(local(node), value);
        more = true;
      }
    }
    for (const node of identifiers) {
      const element = node.parent;
      if (!ts.isBindingElement(element) || element.name !== node) continue;
      const pattern = element.parent;
      const declaration = pattern.parent;
      const value =
        ts.isVariableDeclaration(declaration) &&
        declaration.initializer &&
        valueOf(declaration.initializer);
      const key = (element.propertyName ?? element.name).getText();
      if (value?.module !== undefined && member(value.module, key) && !bindings.has(local(node))) {
        bindings.set(local(node), member(value.module, key));
        more = true;
      }
    }
  }

  // each use of a binding: a call (a site, a child process), the start of a binding above, or an escape
  const calls = [];
  const use = (node, value) => {
    const parent = node.parent;
    if (ts.isParenthesizedExpression(parent) || ts.isAwaitExpression(parent))
      return use(parent, value);
    if (value.module !== undefined) {
      if (ts.isPropertyAccessExpression(parent) && parent.expression === node) {
        const inner = member(value.module, parent.name.text);
        if (inner !== undefined) use(parent, inner);
        return;
      }
      if (ts.isElementAccessExpression(parent) && parent.expression === node) {
        const key = literal(parent.argumentExpression);
        if (key === undefined) return escape(parent, "an fs module indexed by a computed name");
        const inner = member(value.module, key);
        if (inner !== undefined) use(parent, inner);
        return;
      }
    }
    if (value.name !== undefined && ts.isCallExpression(parent) && parent.expression === node)
      return calls.push({ call: parent, ...value });
    if (ts.isVariableDeclaration(parent) && parent.initializer === node) return;
    if (
      value.name !== undefined &&
      ts.isCallExpression(parent) &&
      parent.arguments[0] === node &&
      valueOf(parent.expression)?.promisify
    ) {
      if (ts.isVariableDeclaration(parent.parent)) return;
      return use(parent, value);
    }
    if (value.promisify) return;
    escape(node, "an fs or process binding used other than by a call");
  };
  for (const node of identifiers) {
    if (declares(node)) continue;
    const value = bindings.get(local(node));
    if (value !== undefined) use(node, value);
  }
  for (const node of identifiers)
    if (node.text === "require" && ts.isCallExpression(node.parent) && local(node) === undefined)
      escape(node.parent, "a module loader, through which a module escapes this list");

  // the gate, the functions passed to it, and the functions only those call
  const gate = sources
    .find((source) => path.basename(source.fileName) === "baselines.mjs")
    ?.statements.find(
      (statement) => ts.isFunctionDeclaration(statement) && statement.name?.text === "gate",
    );
  const functions = [];
  for (const source of sources) {
    const visit = (node) => {
      if (isFunction(node)) functions.push(node);
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  const referencesOf = (fn) => {
    const name = nameNodeOf(fn);
    return name === undefined ? [] : (references.get(target(local(name))) ?? []);
  };
  const gateCalls =
    gate === undefined
      ? []
      : referencesOf(gate).filter(
          (node) => ts.isCallExpression(node.parent) && node.parent.expression === node,
        );
  const gated = new Set(gate === undefined ? [] : [gate]);
  for (const node of gateCalls) {
    const action = node.parent.arguments[1];
    if (action !== undefined && isFunction(action)) gated.add(action);
  }
  for (let more = true; more;) {
    more = false;
    for (const fn of functions) {
      const refs = referencesOf(fn);
      if (
        !gated.has(fn) &&
        refs.length > 0 &&
        refs.every(
          (node) =>
            (ts.isCallExpression(node.parent) &&
              node.parent.expression === node &&
              gated.has(contextOf(node))) ||
            gateCalls.some((call) => call.parent.arguments[1] === node),
        )
      ) {
        gated.add(fn);
        more = true;
      }
    }
  }

  // where a path comes from: `outside(…)`, `beside(…)` or a path inside that, or no path (`undefined`); else null
  const ours = (call, name) => {
    const declaration = target(local(strip(call.expression)))?.declarations?.[0];
    return (
      declaration !== undefined &&
      ts.isFunctionDeclaration(declaration) &&
      declaration.name?.text === name &&
      path.basename(declaration.getSourceFile().fileName) === "baselines.mjs"
    );
  };
  const joins = (call) =>
    ts.isPropertyAccessExpression(call.expression) &&
    call.expression.name.text === "join" &&
    valueOf(call.expression.expression)?.module === "path";
  const originOf = (expression, seen = new Set()) => {
    const node = strip(expression);
    if (seen.has(node)) return null;
    seen.add(node);
    if (ts.isIdentifier(node) && node.text === "undefined" && !local(node)?.declarations?.length)
      return ["none"];
    if (ts.isCallExpression(node)) {
      if (ours(node, "outside")) return ["outside"];
      if (ours(node, "beside")) return ["beside"];
      const inside =
        joins(node) && node.arguments[0] !== undefined ? originOf(node.arguments[0], seen) : null;
      return inside?.every((origin) => origin === "beside") ? ["beside"] : null;
    }
    if (ts.isConditionalExpression(node)) {
      const [yes, no] = [node.whenTrue, node.whenFalse].map((branch) => originOf(branch, seen));
      return yes === null || no === null ? null : [...new Set([...yes, ...no])];
    }
    if (!ts.isIdentifier(node)) return null;
    const declaration = local(node)?.valueDeclaration;
    if (declaration !== undefined && isConstant(declaration))
      return originOf(declaration.initializer, seen);
    if (
      declaration === undefined ||
      !ts.isParameter(declaration) ||
      !ts.isIdentifier(declaration.name)
    )
      return null;
    const fn = declaration.parent;
    const index = fn.parameters.indexOf(declaration);
    const refs = referencesOf(fn);
    if (refs.length === 0) return null;
    const origins = new Set();
    for (const ref of refs) {
      if (!ts.isCallExpression(ref.parent) || ref.parent.expression !== ref) return null;
      const argument = ref.parent.arguments[index];
      const origin = argument === undefined ? ["none"] : originOf(argument, seen);
      if (origin === null) return null;
      for (const one of origin) origins.add(one);
    }
    return [...origins];
  };
  const madeIn = (fn, folder) =>
    calls.some(
      ({ call, of, name }) =>
        of !== "processes" &&
        opOf(name) === "mkdir" &&
        contextOf(call) === fn &&
        call.arguments[0] !== undefined &&
        ts.isIdentifier(strip(call.arguments[0])) &&
        local(strip(call.arguments[0])) === local(folder),
    );
  const intoBaselines = (expression) => {
    const node = strip(expression);
    const declaration = ts.isIdentifier(node) ? local(node)?.valueDeclaration : undefined;
    const join =
      declaration !== undefined && isConstant(declaration) ? strip(declaration.initializer) : node;
    return (
      ts.isCallExpression(join) &&
      joins(join) &&
      join.arguments.length === 2 &&
      originOf(join.arguments[0]) !== null
    );
  };
  const kindOf = (call, op) => {
    if (gated.has(contextOf(call))) return "gate";
    const origins = (WRITERS.get(op) ?? [0]).map((index) =>
      call.arguments[index] === undefined ? null : originOf(call.arguments[index]),
    );
    if (origins.every((origin) => origin !== null)) return "outside";
    const [from, to] = call.arguments.map(strip);
    if (
      op === "rename" &&
      origins[0]?.every((origin) => origin === "beside") &&
      ts.isIdentifier(from) &&
      madeIn(contextOf(call), from) &&
      intoBaselines(to)
    )
      return "creation";
    return "unproven";
  };

  const sites = [];
  const processes = [];
  for (const { call, of, name } of calls) {
    const callee = strip(call.expression);
    const at = where(
      ts.isIdentifier(callee) ? callee : (callee.name ?? callee.argumentExpression ?? callee),
    );
    const entry = { site: at, function: named(call), call: text(call) };
    if (of === "processes") processes.push({ ...entry, process: name });
    else if (writes(name, call))
      sites.push({ ...entry, write: name, kind: kindOf(call, opOf(name)) });
  }
  const loads = [];
  for (const source of sources) {
    const visit = (node) => {
      if (
        ts.isCallExpression(node) &&
        node.expression.kind === ts.SyntaxKind.ImportKeyword &&
        literal(node.arguments[0]) === undefined
      )
        loads.push({ site: where(node), function: named(node), call: text(node) });
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  const order = (a, b) => a.site.localeCompare(b.site, "en", { numeric: true });
  return {
    modules: files.map((file) => path.relative(checkout, file)),
    sites: sites.sort(order),
    escapes: escapes.sort(order),
    processes: processes.sort(order),
    loads: loads.sort(order),
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url))
  console.log(JSON.stringify(inventory(path.resolve(process.argv[2] ?? ".")), null, 1));
