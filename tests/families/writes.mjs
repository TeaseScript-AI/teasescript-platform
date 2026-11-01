// node tests/families/writes.mjs [<checkout>]
// The filesystem writes of the stored baselines' tools (#1542) as their source shows them: an advisory check, which
// catches the plain forms of a write outside the gate. It is no proof that the tools write nowhere else; that is
// enforced at the boundary, by the sandbox each store runs in (`sx-sandbox`, tools/corpus/baseline.sh), whose only
// writable places are the baseline's folder and the process's scratch.
// The modules are the node entry points tools/corpus/baseline.sh runs and every module they import by a relative name.
// In them, a site is every call through a binding of `fs`, `fs/promises`, `child_process` or `process`, every import of
// another module (`module`, `vm`, `worker_threads` among them) and every module loader, unless its exact form is one of
// `ALLOWED`, each with the reason it writes nothing. A site that writes is named as a stack frame names its call
// (`<file>:<line>:<column>`) and has a kind:
// - `gate`: in the gate's `try` that holds the lock (baselines.mjs), in a function passed to `gate`, or in a function
//   only those call;
// - `outside`: each path it writes is `pathOf(…, "outside")`, a path checked at run time to lie outside every baseline
//   (baselines.mjs), through constants;
// - `creation`: in `owned`, each path it writes is `pathOf(…, "baseline")` or one plain name in it (its MANIFEST, made
//   while the folder holds nothing else);
// - `unproven`: none of these, as is every other site.
// Any other use of a binding (passed on, exported, aliased by `let`, destructured other than into plain names, indexed
// by a computed or quoted name) is an escape. Prints the sites, escapes and allowed forms used as one JSON object.
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

/** The modules whose bindings are followed. */
const MODULES = {
  fs: ["fs", "node:fs"],
  promises: ["fs/promises", "node:fs/promises"],
  processes: ["child_process", "node:child_process"],
  util: ["util", "node:util"],
  path: ["path", "node:path"],
};
/** The other modules the tools may import: they reach no file and run no code given to them. */
const INERT = ["crypto", "node:crypto", "url", "node:url", "readline", "node:readline"];

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
    chmod: [0],
    chown: [0],
    lchown: [0],
    utimes: [0],
    lutimes: [0],
  }),
);
const opOf = (name) => (name.endsWith("Sync") ? name.slice(0, -4) : name);
const literal = (node) =>
  node !== undefined && ts.isStringLiteralLike(node) ? node.text : undefined;

/** Options that cannot make a read write: a string, or an object literal of plain named entries but `flag`/`flags`. */
const plainOptions = (node) =>
  literal(node) !== undefined ||
  (ts.isObjectLiteralExpression(node) &&
    node.properties.every(
      (property) =>
        (ts.isPropertyAssignment(property) || ts.isShorthandPropertyAssignment(property)) &&
        ts.isIdentifier(property.name) &&
        !["flag", "flags"].includes(property.name.text),
    ));
const optionsFrom = (index) => (call) => call.arguments.slice(index).every(plainOptions);
const exactly = (count) => (call) => call.arguments.length === count;

/**
 * The lock holder's script (baselines.mjs `gate`): it opens its one argument for reading only (`9<` fails on an absent
 * path and creates none), locks that descriptor, and writes nothing but to /dev/null.
 */
const LOCK_HOLDER = 'exec 9< "$0" && flock 9 && echo held && exec cat > /dev/null';

/**
 * The calls that write nothing, in exactly these forms, each with the reason; every other call through a followed
 * binding, process call and module loader is a site. `fs` names its reads (also as `fs/promises` without `Sync`),
 * `process` the calls of the global `process` (its data, `PROCESS_DATA`, is read freely), `processes` the child
 * processes, `loads` the modules loaded by a computed name.
 */
const ALLOWED = {
  fs: {
    existsSync: [exactly(1), "tells whether a path exists"],
    statSync: [optionsFrom(1), "reads a path's metadata"],
    lstatSync: [optionsFrom(1), "reads a path's metadata"],
    readFileSync: [optionsFrom(1), "reads a file"],
    readdirSync: [optionsFrom(1), "lists a folder"],
    readlinkSync: [optionsFrom(1), "reads a link's target"],
    openSync: [
      (call) => exactly(2)(call) && literal(call.arguments[1]) === "r",
      "opens a file to read",
    ],
    readSync: [() => true, "reads from an open descriptor into memory"],
    closeSync: [exactly(1), "closes a descriptor"],
    createReadStream: [optionsFrom(1), "reads a file as a stream"],
  },
  process: {
    exit: [() => true, "ends this process"],
    kill: [() => true, "sends a signal to a process"],
    on: [() => true, "registers an event handler"],
    once: [() => true, "registers an event handler"],
    send: [() => true, "sends a message to the parent process"],
    cwd: [exactly(0), "reads the working folder"],
  },
  processes: {
    "the gate's lock holder": [
      (call, { importedFrom }) => {
        const [command, args, options] = call.arguments;
        const elements =
          args !== undefined && ts.isArrayLiteralExpression(args) ? args.elements : [];
        return (
          importedFrom(call.expression) !== undefined &&
          literal(command) === "bash" &&
          elements.length === 3 &&
          literal(elements[0]) === "-c" &&
          literal(elements[1]) === LOCK_HOLDER &&
          !ts.isSpreadElement(elements[2]) &&
          onlyOptions(options, (key) => key === "stdio")
        );
      },
      "`bash -c` of LOCK_HOLDER (above), with no option but `stdio`",
    ],
    "the runner's own child": [
      (call, { importedFrom }) => {
        const [command, args, options] = call.arguments;
        const self = command === undefined ? undefined : strip(command);
        const elements =
          args !== undefined && ts.isArrayLiteralExpression(args) ? args.elements : [];
        return (
          self !== undefined &&
          ts.isCallExpression(self) &&
          ts.isIdentifier(self.expression) &&
          self.expression.text === "fileURLToPath" &&
          ["url", "node:url"].includes(importedFrom(self.expression)) &&
          self.arguments.length === 1 &&
          self.arguments[0].getText() === "import.meta.url" &&
          literal(elements[0]) === "--child" &&
          onlyOptions(
            options,
            (key, value) =>
              ["serialization", "stdio"].includes(key) ||
              (key === "execArgv" &&
                ts.isArrayLiteralExpression(value) &&
                value.elements.every((element) =>
                  /^`--max-old-space-size=\$\{\w+\}`$/.test(element.getText()),
                )),
          )
        );
      },
      "the runner's own module (`--child`), whose writes are this module's and so listed, with a heap limit as its only `execArgv`",
    ],
  },
  loads: {
    "a tree's oracle library": [
      (call, { named, file }) => file === "run.mjs" && named === "oracles",
      "the built tree's own library, the code under test that the runner exists to run, not the tools",
    ],
    "a tree's work ledger": [
      (call, { named, file }) => file === "run.mjs" && named === "ledgerOf",
      "the built tree's own budget module, the code under test whose charges `--work` counts, not the tools",
    ],
    "an area's generators": [
      (call, { named, file }) => file === "sources.mjs" && named === "generatorsOf",
      "an area's generator modules, the cases under test that the runner exists to run, not the tools",
    ],
  },
};
/** The global `process`'s data, read freely: no call through it reaches a file. */
const PROCESS_DATA = [
  "argv",
  "env",
  "pid",
  "ppid",
  "version",
  "versions",
  "platform",
  "arch",
  "exitCode",
  "execPath",
];

/** Whether `options` (of a child process) is an object literal whose every entry `allowed(name, value)` accepts. */
function onlyOptions(options, allowed) {
  return (
    options !== undefined &&
    ts.isObjectLiteralExpression(options) &&
    options.properties.every(
      (property) =>
        ts.isPropertyAssignment(property) &&
        ts.isIdentifier(property.name) &&
        allowed(property.name.text, property.initializer),
    )
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

/** The sites, escapes and allowed forms of the tools in `checkout` (see above). */
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
  const isGlobal = (node) => !local(node)?.declarations?.length;
  const escapes = [];
  const escape = (node, why) =>
    escapes.push({ site: where(node), function: named(node), why, code: text(node) });
  const sites = [];
  /** A site of no proof: `what` is the call or the form denied. */
  const unproven = (node, what, why) =>
    sites.push({
      site: where(node),
      function: named(node),
      call: text(node),
      write: what,
      kind: "unproven",
      why,
    });
  const used = { reads: new Map(), process: new Map(), processes: [], loads: [] };
  const importedFrom = (identifier) => {
    const declaration = ts.isIdentifier(identifier)
      ? local(identifier)?.declarations?.[0]
      : undefined;
    const statement =
      declaration !== undefined && ts.isImportSpecifier(declaration)
        ? declaration.parent.parent.parent
        : undefined;
    return statement === undefined ? undefined : literal(statement.moduleSpecifier);
  };

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

  // the bindings of the followed modules: a module itself, or one member of it
  const bindings = new Map();
  const member = (of, key) =>
    of === "fs" && key === "promises"
      ? { module: "promises" }
      : of === "util" && key === "promisify"
        ? { promisify: true }
        : ["fs", "promises", "processes"].includes(of) && key !== "constants"
          ? { of, name: key }
          : { inert: true };
  const bindingOf = (node) => bindings.get(local(node)) ?? bindings.get(target(local(node)));
  /** `process.<name>` of the global `process`, or undefined. */
  const processMember = (node) =>
    ts.isPropertyAccessExpression(node) &&
    ts.isIdentifier(node.expression) &&
    node.expression.text === "process" &&
    isGlobal(node.expression)
      ? node.name.text
      : undefined;
  const moduleNamed = (specifier) =>
    Object.keys(MODULES).find((key) => MODULES[key].includes(literal(specifier)));
  const valueOf = (expression) => {
    const node = strip(expression);
    if (ts.isIdentifier(node)) return bindingOf(node);
    if (ts.isPropertyAccessExpression(node)) {
      const base = valueOf(node.expression);
      return base?.module !== undefined ? member(base.module, node.name.text) : undefined;
    }
    if (ts.isCallExpression(node)) {
      if (
        (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
          processMember(node.expression) === "getBuiltinModule") &&
        moduleNamed(node.arguments[0]) !== undefined
      )
        return { module: moduleNamed(node.arguments[0]) };
      if (valueOf(node.expression)?.promisify && node.arguments[0] !== undefined) {
        const promisified = valueOf(node.arguments[0]);
        return promisified?.name !== undefined ? promisified : undefined;
      }
    }
    return undefined;
  };
  for (const source of sources)
    for (const statement of source.statements) {
      const specifier =
        ts.isImportDeclaration(statement) || ts.isExportDeclaration(statement)
          ? statement.moduleSpecifier
          : undefined;
      if (specifier === undefined) continue;
      const from = moduleNamed(specifier);
      if (literal(specifier)?.startsWith(".") || INERT.includes(literal(specifier))) continue;
      if (from === undefined) {
        unproven(
          statement,
          `import ${literal(specifier) ?? "(computed)"}`,
          "a module this list does not follow",
        );
        continue;
      }
      if (ts.isExportDeclaration(statement)) {
        escape(statement, "a followed module exported on");
        continue;
      }
      const clause = statement.importClause;
      if (clause === undefined) continue;
      if (clause.name !== undefined) bindings.set(local(clause.name), { module: from });
      const imported = clause.namedBindings;
      if (imported !== undefined && ts.isNamespaceImport(imported))
        bindings.set(local(imported.name), { module: from });
      if (imported !== undefined && ts.isNamedImports(imported))
        for (const element of imported.elements) {
          const key = element.propertyName ?? element.name;
          if (!ts.isIdentifier(key))
            escape(element, "a followed module's member imported by a quoted name");
          else bindings.set(local(element.name), member(from, key.text));
        }
    }
  // constants that name a module or a member of one: an alias, a destructuring into plain names, a promisified
  // function; any other form of binding escapes
  const declared = new Set();
  for (let more = true; more;) {
    more = false;
    for (const node of identifiers) {
      const declaration = node.parent;
      if (!ts.isVariableDeclaration(declaration) || declaration.name !== node || declared.has(node))
        continue;
      const value = declaration.initializer && valueOf(declaration.initializer);
      if (value === undefined || value.inert) continue;
      declared.add(node);
      more = true;
      if (!isConstant(declaration))
        escape(declaration, "a binding bound by `let` or `var`, which may change");
      else bindings.set(local(node), value);
    }
    for (const source of sources) {
      const visit = (node) => {
        if (
          ts.isVariableDeclaration(node) &&
          !ts.isIdentifier(node.name) &&
          node.initializer !== undefined &&
          !declared.has(node)
        ) {
          const value = valueOf(node.initializer);
          if (value !== undefined && !value.inert) {
            declared.add(node);
            more = true;
            const plain =
              isConstant(node) &&
              value.module !== undefined &&
              ts.isObjectBindingPattern(node.name) &&
              node.name.elements.every(
                (element) =>
                  element.dotDotDotToken === undefined &&
                  element.initializer === undefined &&
                  ts.isIdentifier(element.name) &&
                  (element.propertyName === undefined || ts.isIdentifier(element.propertyName)),
              );
            if (!plain) escape(node, "a followed binding destructured other than into plain names");
            else
              for (const element of node.name.elements)
                bindings.set(
                  local(element.name),
                  member(value.module, (element.propertyName ?? element.name).text),
                );
          }
        }
        ts.forEachChild(node, visit);
      };
      visit(source);
    }
  }

  // each use of a binding: a call, the start of a binding above, data, or an escape
  const calls = [];
  const use = (node, value) => {
    const parent = node.parent;
    if (ts.isParenthesizedExpression(parent) || ts.isAwaitExpression(parent))
      return use(parent, value);
    if (value.inert) return;
    if (ts.isVariableDeclaration(parent) && parent.initializer === node) return;
    if (value.module !== undefined) {
      if (ts.isPropertyAccessExpression(parent) && parent.expression === node)
        return use(parent, member(value.module, parent.name.text));
      if (ts.isElementAccessExpression(parent) && parent.expression === node) {
        const key = literal(parent.argumentExpression) ?? "(computed)";
        if (ts.isCallExpression(parent.parent) && parent.parent.expression === parent)
          return unproven(
            parent.parent,
            key,
            "a followed module's member called by a quoted or computed name",
          );
        return escape(parent, "a followed module indexed by a quoted or computed name");
      }
      return escape(node, "a followed module used other than by its members");
    }
    if (value.name !== undefined && ts.isCallExpression(parent) && parent.expression === node)
      return calls.push({ call: parent, ...value });
    if (
      value.name !== undefined &&
      ts.isCallExpression(parent) &&
      parent.arguments[0] === node &&
      valueOf(parent.expression)?.promisify
    )
      return use(parent, value);
    if (value.promisify && ts.isCallExpression(parent) && parent.expression === node) return;
    escape(node, "a followed binding used other than by a call");
  };
  for (const node of identifiers) {
    if (declares(node)) continue;
    const value = bindingOf(node);
    if (value !== undefined) use(node, value);
  }
  // the global `process`, module loaders and code from text
  for (const source of sources) {
    const visit = (node) => {
      if (ts.isCallExpression(node) && valueOf(node)?.module !== undefined)
        use(node, valueOf(node));
      if (
        ts.isIdentifier(node) &&
        isGlobal(node) &&
        !(ts.isPropertyAccessExpression(node.parent) && node.parent.name === node) &&
        !(ts.isPropertyAssignment(node.parent) && node.parent.name === node)
      ) {
        const call =
          ts.isCallExpression(node.parent) && node.parent.expression === node
            ? node.parent
            : undefined;
        if (["require", "eval", "Function", "globalThis", "global"].includes(node.text))
          unproven(
            call ?? node,
            node.text,
            "a module loader, code from text or the global object, which this list does not see",
          );
        if (node.text === "process") {
          const name = processMember(node.parent);
          const called =
            name !== undefined &&
            ts.isCallExpression(node.parent.parent) &&
            node.parent.parent.expression === node.parent;
          if (name === undefined)
            escape(node, "the global `process` used other than by its members");
          else if (PROCESS_DATA.includes(name)) {
            // (its data, read freely)
          } else if (
            name === "getBuiltinModule" &&
            called &&
            moduleNamed(node.parent.parent.arguments[0]) !== undefined
          ) {
            // (a followed module loaded by a literal name: followed above)
          } else if (
            name === "getBuiltinModule" &&
            called &&
            INERT.includes(literal(node.parent.parent.arguments[0]))
          ) {
            // (an inert module)
          } else if (called && ALLOWED.process[name]?.[0](node.parent.parent)) {
            used.process.set(name, ALLOWED.process[name][1]);
          } else
            unproven(
              called ? node.parent.parent : node.parent,
              `process.${name}`,
              "a process member or call this list does not allow",
            );
        }
      }
      if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
        const specifier = literal(node.arguments[0]);
        if (specifier === undefined) {
          const file = path.basename(node.getSourceFile().fileName);
          const load = Object.entries(ALLOWED.loads).find(([, [allowed]]) =>
            allowed(node, { named: named(node), file }),
          );
          if (load !== undefined)
            used.loads.push({ site: where(node), function: named(node), allowed: load[0] });
          else
            unproven(
              node,
              "import()",
              "a module loaded by a computed name this list does not allow",
            );
        } else if (
          !specifier.startsWith(".") &&
          moduleNamed(node.arguments[0]) === undefined &&
          !INERT.includes(specifier)
        )
          unproven(node, `import(${specifier})`, "a module this list does not follow");
      }
      if (
        ts.isExportDeclaration(node) &&
        node.moduleSpecifier === undefined &&
        node.exportClause !== undefined &&
        ts.isNamedExports(node.exportClause)
      )
        for (const element of node.exportClause.elements)
          if (bindings.has(checker.getExportSpecifierLocalTargetSymbol(element)))
            escape(element, "a followed binding exported on");
      ts.forEachChild(node, visit);
    };
    visit(source);
  }

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
  // (in the gate itself, only what runs once it holds the lock: the `try` whose `finally` lets it go)
  const locked = gate?.body.statements.find(
    (statement) => ts.isTryStatement(statement) && statement.finallyBlock !== undefined,
  )?.tryBlock;
  const inGate = (node) =>
    gated.has(contextOf(node)) &&
    (contextOf(node) !== gate ||
      (locked !== undefined && node.pos >= locked.pos && node.end <= locked.end));
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
            (ts.isCallExpression(node.parent) && node.parent.expression === node && inGate(node)) ||
            gateCalls.some((call) => call.parent.arguments[1] === node),
        )
      ) {
        gated.add(fn);
        more = true;
      }
    }
  }

  // where a path written outside the gate comes from: `pathOf(…, "outside")`, `pathOf(…, "baseline")` or one plain
  // name inside the latter, or no path (`undefined`), through constants only; else null
  const pathOfCall = (expression, kind) => {
    const node = strip(expression);
    if (!ts.isCallExpression(node)) return undefined;
    const declaration = target(local(strip(node.expression)))?.declarations?.[0];
    return declaration !== undefined &&
      ts.isFunctionDeclaration(declaration) &&
      declaration.name?.text === "pathOf" &&
      path.basename(declaration.getSourceFile().fileName) === "baselines.mjs" &&
      literal(node.arguments[1]) === kind &&
      node.arguments.length === 2
      ? strip(node.arguments[0])
      : undefined;
  };
  const ours = (call, name) => {
    const declaration = target(local(strip(call.expression)))?.declarations?.[0];
    return (
      declaration !== undefined &&
      nameNodeOf(declaration.initializer ?? declaration)?.text === name &&
      path.basename(declaration.getSourceFile().fileName) === "baselines.mjs"
    );
  };
  const plainName = (expression) => {
    const node = strip(expression);
    const name = literal(node);
    if (name !== undefined) return /^[^/]+$/.test(name) && ![".", ".."].includes(name);
    // (a temporary file of a plain name: `<name>.<writer>.tmp`)
    return ts.isCallExpression(node) && ours(node, "temporaryName") && plainName(node.arguments[0]);
  };
  const joins = (call) =>
    ts.isPropertyAccessExpression(call.expression) &&
    call.expression.name.text === "join" &&
    valueOf(call.expression.expression)?.module === "path";
  const seen = new Set();
  const originOf = (expression) => {
    const node = strip(expression);
    if (seen.has(node)) return null;
    seen.add(node);
    try {
      if (ts.isIdentifier(node) && node.text === "undefined" && isGlobal(node)) return ["none"];
      if (pathOfCall(node, "outside") !== undefined) return ["outside"];
      if (pathOfCall(node, "baseline") !== undefined) return ["baseline"];
      if (
        ts.isCallExpression(node) &&
        joins(node) &&
        node.arguments.length === 2 &&
        plainName(node.arguments[1])
      )
        return originOf(node.arguments[0])?.every((origin) => origin === "baseline")
          ? ["baseline"]
          : null;
      const declaration = ts.isIdentifier(node) ? local(node)?.valueDeclaration : undefined;
      return declaration !== undefined && isConstant(declaration)
        ? originOf(declaration.initializer)
        : null;
    } finally {
      seen.delete(node);
    }
  };
  const kindOf = (call, op) => {
    if (inGate(call)) return "gate";
    const origins = (WRITERS.get(op) ?? [0]).map((index) =>
      call.arguments[index] === undefined ? null : originOf(call.arguments[index]),
    );
    if (origins.some((origin) => origin === null)) return "unproven";
    const all = new Set(origins.flat());
    if ([...all].every((origin) => origin === "outside" || origin === "none")) return "outside";
    if ([...all].every((origin) => origin === "baseline") && named(call) === "owned")
      return "creation";
    return "unproven";
  };

  for (const { call, of, name } of calls) {
    const callee = strip(call.expression);
    const at = where(
      ts.isIdentifier(callee) ? callee : (callee.name ?? callee.argumentExpression ?? callee),
    );
    const entry = { site: at, function: named(call), call: text(call) };
    if (of === "processes") {
      const allowed = Object.entries(ALLOWED.processes).find(([, [check]]) =>
        check(call, { importedFrom }),
      );
      if (allowed !== undefined)
        used.processes.push({ ...entry, process: name, allowed: allowed[0] });
      else
        sites.push({
          ...entry,
          write: name,
          kind: "unproven",
          why: "a child process this list does not allow",
        });
      continue;
    }
    const op = opOf(name);
    if (WRITERS.has(op) && !(op === "open" && ALLOWED.fs.openSync[0](call)))
      sites.push({ ...entry, write: name, kind: kindOf(call, op) });
    else {
      const read = ALLOWED.fs[name] ?? ALLOWED.fs[`${name}Sync`];
      if (read !== undefined && read[0](call)) used.reads.set(name, read[1]);
      else
        sites.push({
          ...entry,
          write: name,
          kind: "unproven",
          why: "a call this list does not allow as a read",
        });
    }
  }
  const order = (a, b) => a.site.localeCompare(b.site, "en", { numeric: true });
  return {
    modules: files.map((file) => path.relative(checkout, file)),
    sites: sites.sort(order),
    escapes: escapes.sort(order),
    processes: used.processes.sort(order),
    loads: used.loads.sort(order),
    reads: Object.fromEntries([...used.reads].sort()),
    process: Object.fromEntries([...used.process].sort()),
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url))
  console.log(JSON.stringify(inventory(path.resolve(process.argv[2] ?? ".")), null, 1));
