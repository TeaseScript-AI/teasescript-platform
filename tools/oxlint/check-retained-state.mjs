import { relative, resolve, sep } from "node:path";
import { Project, ts } from "ts-morph";

/**
 * #1072 step 1b: the type core's owners of retained state make each kind they change in place through `Retained`
 * (`src/type-inference/core/retained/retained.ts`), so the retained-state instrument makes it in tests
 * (`tests/helpers/retained-instrument.ts`). The checked files are the program `tsconfig.json` defines, as the compiler
 * reads it (`rootProgram`): each source file of `src/type-inference/` and `tests/helpers/` it compiles, a module
 * reached only through another module included (#1072 R46). A call of the retained API is the call the checker
 * resolves to its declaration there, however it is spelled; a call that resolves to none is not one.
 * In the scoped files, a native `Map`, `Set`, `WeakMap` or `WeakSet` (the constructor the checker resolves to the
 * standard library's) stands only where it cannot be kept by an owner as made, which is the closed set below; any other
 * place (a class field, a private field, a member's or a module's variable's assignment, a module's mutable variable, a
 * parameter property's default) is refused.
 * - inside a function: a variable's initializer or an assignment to a variable bound inside a function (not passed on
 *   by a chained assignment to anything else), a `return`'s value or an arrow's body, an argument of a call or of a
 *   `new`, a spread, a `for…of`'s source, the object of a member access;
 * - at a module's top level: a `const` annotated `ReadonlyMap` or `ReadonlySet` (a constant table);
 * - a parameter's default, where the parameter is no parameter property or is annotated `ReadonlyMap` or `ReadonlySet`;
 * each through parentheses, `as`, `satisfies`, `!`, a conditional's branch, a `??` or `||`'s operand, and an array's
 * element or an object literal's property: such a literal is judged where it stands.
 * What the check does not see is the instrument's: a local stored in retained state is checked and frozen there.
 * A private instance field (`#x`), which no walk of its owner can see, is closed at its declaration: in a file scoped
 * `file`, each is `readonly` and either made by one of `Retained`'s makers (`MAKERS`) or named in the object its class's
 * `Retained.owner(this, name, hidden)` returns (read once, at the switch after the owner is made), `hidden` an arrow
 * written there or a static `#hidden` arrow of the class, whose object literal gives the field itself (`x: owner.#x`); or
 * it is listed in `OUTSIDE_FIELDS`. In the indexed program's own files (`PROGRAM_FILES`) each is `readonly` and named by
 * its class's `Retained.programPart(this, hidden)`, which the instrument's walk of the program reads. Any other private
 * field is refused, whatever its initializer: what an owner fills later goes in a record.
 * Every file of the type core is checked, a new one too, unless `TOP_LEVEL` names it (its top level alone is checked)
 * or `OUTSIDE` does, each with its reason; the reasons match the instrument's domain.
 *
 * Three more lines hold what the instrument's guarantee leans on, in every file of `src/type-inference/` but the
 * retained API's own, which is its trusted implementation:
 * - the meta-object layer is closed (#1072 R30, R34): a property changes only by assignment or by a kind's own method.
 *   `Object` stands only as `Object.freeze`, `hasOwn`, `keys`, `values`, `entries`, `fromEntries`, `assign` or `is`;
 *   `Reflect`, `globalThis`, `Function`, `eval`, the `delete` operator, `.prototype`, `__proto__`, `.constructor` and a
 *   constructor's `return <value>` are refused, and so is a definer by its name in any position (`defineProperty`,
 *   `defineProperties`, `__defineGetter__`, `__defineSetter__`). What they reach (a descriptor, a prototype, an
 *   integrity level, a deletion) could change a locked owner's field or a kind's writer unseen;
 * - a `catch` handles only the errors of type inference's own classes (#1072 R55, R60): each `instanceof` test of its
 *   binding names a class declared under `src/type-inference/` that extends `Error` directly, and the `catch` either
 *   ends in `throw <binding>` with every earlier exit under such a test, or holds a top-level guard
 *   `if (!(<binding> instanceof C) …) throw <binding>` before any exit; a `finally` holds no `yield`, `return`,
 *   `break`, `continue` or `throw`. So a refusal (the instrument's, or V8's at a write to frozen data) is never handled
 *   in type inference. The two catches that forward an error as `yield*` does are listed (`FORWARDERS`);
 * - a `Retained.closure` registration (and in the test helpers too) stands right below its comment, which names what
 *   the function captures (`#1072 R26: captures …`, or `#1072 R26: as …` for one capturing as a named neighbour does):
 *   the instrument does not see the captures, and that comment is what review reads (#1072 R26).
 */
const INFERENCE = "src/type-inference/";
const CORE = "src/type-inference/core/";

/** The files checked at their top level only (their module captures), each with why its classes are not. */
const TOP_LEVEL = new Map([
  [
    "answers.ts",
    "its classes are the finished analysis' answers (`CoreAnswers`), made after its runs",
  ],
  [
    "consumers.ts",
    "its classes are the questions' driver (`Consumers`), outside the instrument's domain by name",
  ],
  [
    "contract-descriptors.ts",
    "its classes are the result's descriptors (`ContractDescriptors`), made after the runs they describe",
  ],
]);

/**
 * The files and folders (`…/`) the check leaves out, each with why: outside the instrument's domain by name, compared by
 * identity, or made where no later run follows.
 */
const OUTSIDE = new Map([
  ["admission.ts", "the admission's own state: outside 1b-i's domain, #1072 1b part ii"],
  ["admission/", "the admission's own state: outside 1b-i's domain, #1072 1b part ii"],
  [
    "inherited/",
    "A4's receiving domain (`ReceivingDomain`), which admission makes and writes: outside 1b-i's domain, #1072 1b part ii",
  ],
  [
    "touch.ts",
    "the admission's candidate discovery (`Touches`): outside 1b-i's domain, #1072 1b part ii",
  ],
  ["narrowing/", "narrowing's indexes: outside the instrument's domain by name"],
  ["retained/", "the retained API itself"],
  ["consumers/", "the questions' driver (`Consumers`): outside the instrument's domain by name"],
  ["check-result/", "the result made from the finished analysis: no run follows it"],
  ["solver.ts", "the solver: compared by identity (`IDENTITY_CLASSES`)"],
  ["budget.ts", "the work ledger: compared by identity (`IDENTITY_CLASSES`)"],
  ["items.ts", "the ingress graph: compared by identity (`IDENTITY_CLASSES`)"],
  [
    "contract/objects.ts",
    "what a query gathers (`Gathered`) becomes its proof, which the solver holds; its collections' shapes are closed by its own language (tools/oxlint/objects-language.mjs)",
  ],
  [
    "contract/contributions.ts",
    "a run's flow (`FlowSink`) is the solver's record of the run, published with its answer",
  ],
]);

/**
 * The indexed program's own files, built before any run and held as they are from the indexing on
 * (`Retained.program`, whose graph the instrument walks and locks): checked for their private fields alone, which each
 * class gives that walk (`Retained.programPart`).
 */
const PROGRAM_FILES = new Map([
  ["program.ts", "the program (`CoreProgram`)"],
  ["flow-graph.ts", "the program's flow graph (`FlowGraph`), built with it"],
]);

/** How a core file is checked: `file`, `module` (its top level), `program`, or `null` (not at all). */
function levelOf(file) {
  const inner = file.slice(CORE.length);
  if (TOP_LEVEL.has(inner)) return "module";
  if (PROGRAM_FILES.has(inner)) return "program";
  for (const name of OUTSIDE.keys())
    if (name.endsWith("/") ? inner.startsWith(name) : inner === name) return null;
  return "file";
}

/** The private fields the check leaves out, each with why the instrument's domain does not hold it. */
const OUTSIDE_FIELDS = new Map([
  [
    "PathSteps.#contract",
    "fixed when made (`readonly`, set in the constructor alone): steps are held by identity (`IDENTITY_CLASSES`), what they find later in their record `#memo`",
  ],
  [
    "PathSteps.#find",
    "fixed when made (`readonly`, set in the constructor alone): steps are held by identity (`IDENTITY_CLASSES`), what they find later in their record `#memo`",
  ],
  [
    "PathSteps.#of",
    "fixed when made (`readonly`, set in the constructor alone): steps are held by identity (`IDENTITY_CLASSES`), what they find later in their record `#memo`",
  ],
  [
    "PathSteps.#offset",
    "fixed when made (`readonly`, set in the constructor alone): steps are held by identity (`IDENTITY_CLASSES`), what they find later in their record `#memo`",
  ],
  [
    "GuardIndex.#narrowing",
    "narrowing's index (`NarrowingIndex`), outside the instrument's domain by name",
  ],
  [
    "GuardIndex.#queries",
    "narrowing's queries over that index, outside the instrument's domain by name",
  ],
  [
    "CoreProgram.#indexed",
    "set once, in `index`, before the program registers; `index` returns at once on every later call",
  ],
]);

const COLLECTIONS = new Set(["Map", "Set", "WeakMap", "WeakSet"]);
const READONLY = new Set(["ReadonlyMap", "ReadonlySet"]);

/** The test helpers the closure-comment line reads: all of them but the instrument, the writers' owner. */
const HELPERS = "tests/helpers/";
const INSTRUMENT = "tests/helpers/retained-instrument.ts";
/** The retained API, the declarations a call of it resolves to, and its folder, its trusted implementation. */
const RETAINED_API = "src/type-inference/core/retained/";
const API_FILE = `${RETAINED_API}retained.ts`;

/**
 * The program `tsconfig.json` defines, through ts-morph, whose project gives the standard declarations its bundled
 * compiler does not find on disk (the native constructors resolve there): what the root build compiles, a module
 * reached only through another module included.
 */
function rootProgram(root) {
  return new Project({ tsConfigFilePath: resolve(root, "tsconfig.json") }).getProgram()
    .compilerObject;
}

export function checkRetainedState(root) {
  return retainedStateDiagnostics(rootProgram(root), root);
}

/** Per root, the project the scratch programs share (its standard declarations parsed once) and its last scratch files. */
const scratchProjects = new Map();

/**
 * Test-only: a program of `files` (each `{ file, text }`, `file` a path from `root`) placed beside the repository's own
 * files, which they may import, with the root program's options and the standard declarations.
 */
export function scratchProgram(root, files) {
  let scratch = scratchProjects.get(root);
  if (scratch === undefined) {
    const project = new Project({
      tsConfigFilePath: resolve(root, "tsconfig.json"),
      skipAddingFilesFromTsConfig: true,
    });
    scratch = { project, files: [] };
    scratchProjects.set(root, scratch);
  }
  for (const file of scratch.files) scratch.project.removeSourceFile(file);
  scratch.files = files.map(({ file, text }) =>
    scratch.project.createSourceFile(resolve(root, file), text, { overwrite: true }),
  );
  return scratch.project.getProgram().compilerObject;
}

/** `file`'s path from `root`, with `/`. */
const pathFrom = (root, file) => relative(root, file).split(sep).join("/");

/** How the check reads `file` (a path from the root): its core level, `meta` outside the core, `helper`, or `undefined`. */
function scopeOf(file) {
  if (file.startsWith(INFERENCE)) return file.startsWith(CORE) ? levelOf(file) : "meta";
  if (file.startsWith(HELPERS) && file !== INSTRUMENT) return "helper";
  return undefined;
}

/** What a refusal in type inference would do if a check let it through. */
const DIFFERS = "so a frozen run would differ from production";
const IN_PLACE =
  "it can redefine a field in place, reopening a locked owner's field or making it an accessor past the instrument";
/**
 * The meta-object layer, closed in the checked core files (#1072 R30): a property changes only by assignment or by a
 * kind's own method. `Object` stands only as one of these members; `Reflect`, `globalThis`, `Function`, `eval`, the
 * `delete` operator, `.prototype`, `__proto__`, `.constructor` and a constructor's `return <value>` not at all.
 */
const OBJECT_MEMBERS = new Set([
  "freeze",
  "hasOwn",
  "keys",
  "values",
  "entries",
  "fromEntries",
  "assign",
  "is",
]);
const META_GLOBALS = new Set(["Reflect", "globalThis", "Function", "eval"]);
const META_PROPERTIES = new Set(["prototype", "__proto__", "constructor"]);
const META =
  "it reaches past assignment and a kind's own methods (a descriptor, a prototype, an integrity level, a deletion), " +
  `which the retained-state instrument does not see, ${DIFFERS} or a locked owner's field could change unseen`;
/**
 * The definers refused in the checked core files by their name in any position (a call, an alias, a computed key, a
 * destructuring), not by their call alone: one taken out of `Object` or `Reflect` defines as well.
 */
const IN_PLACE_DEFINERS = new Set([
  "defineProperty",
  "defineProperties",
  "__defineGetter__",
  "__defineSetter__",
]);

/** The meta-object, `catch` and closure-comment lines' diagnostics in `source` (`level` its `scopeOf`). */
function guardLines(program, checker, source, file, level) {
  const found = [];
  const visit = (node) => {
    // (the retained API's own forwarding of a registration to the recorder is no registration)
    if (
      !file.startsWith(RETAINED_API) &&
      ts.isCallExpression(node) &&
      apiMember(checker, node) === "closure" &&
      !capturesNamed(source, node)
    )
      found.push({
        node,
        message:
          "`Retained.closure` stands right below a comment naming what the function captures (`#1072 R26: captures …`): " +
          "the instrument does not see the captures, review reads that comment (#1072 R26)",
      });
    // (the closed meta-object layer and the `catch` rule: every file of `src/type-inference/`, the core's left-out files
    // included, since a retained owner reaches no code outside it while runs remain; the retained API is their trusted
    // implementation)
    if (level !== "helper" && !file.startsWith(RETAINED_API)) {
      const meta = metaReach(node);
      if (meta !== null)
        found.push({ node, message: `${meta} in type inference: ${META} (#1072 R30)` });
      if (
        (ts.isIdentifier(node) || ts.isStringLiteralLike(node)) &&
        IN_PLACE_DEFINERS.has(node.text)
      )
        found.push({
          node,
          message: `\`${node.text}\` in type inference: ${IN_PLACE} (#1072 R30)`,
        });
      if (ts.isCatchClause(node)) {
        const refused = catchRefusal(program, checker, source, file, node);
        if (refused !== null) found.push({ node, message: `${refused}: ${CAUGHT} (#1072 R60)` });
      }
      if (ts.isTryStatement(node) && node.finallyBlock !== undefined) {
        const exit = abrupt(node.finallyBlock, true)[0];
        if (exit !== undefined)
          found.push({
            node: exit,
            message: `${exitName(exit)} in a \`finally\`: ${CAUGHT} (#1072 R60)`,
          });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

/** The member of the retained API that `call` resolves to (its declaration's name in `API_FILE`), or `null`. */
function apiMember(checker, call) {
  const declaration = checker.getResolvedSignature(call)?.getDeclaration();
  const file = declaration?.getSourceFile?.()?.fileName.split(sep).join("/");
  if (file === undefined || !file.endsWith(`/${API_FILE}`)) return null;
  const name = declaration.name;
  return name !== undefined && ts.isIdentifier(name) ? name.text : null;
}

/** The native collection a `new` expression makes, by the constructor the checker resolves it to, or `null`. */
function nativeCollection(checker, program, node) {
  const declaration = checker.getResolvedSignature(node)?.getDeclaration();
  const parent = declaration?.parent;
  if (parent === undefined || !ts.isInterfaceDeclaration(parent)) return null;
  const kind = parent.name.text.replace(/Constructor$/u, "");
  return COLLECTIONS.has(kind) && program.isSourceFileDefaultLibrary(declaration.getSourceFile())
    ? kind
    : null;
}

const CAUGHT =
  "type inference handles only its own errors, so a refusal (the instrument's, or V8's at a write to frozen data) is " +
  "never caught there; test the binding `instanceof` a class declared under `src/type-inference/` that extends `Error`, " +
  "rethrow everything else, and let a `finally` complete normally";

/** The catches that forward their error as `yield*` does, by file and enclosing function, each with why. */
const FORWARDERS = new Map([
  [
    "src/type-inference/core/solver.ts #advance",
    "a demand's error goes into its parent frame's generator, whose `catch` and `finally` run as `yield*` runs them; at the root it is thrown again",
  ],
  [
    "src/type-inference/core/budget.ts sharedStructure",
    "a shared structure's error goes into the generator it delegates to, as `yield*` sends it",
  ],
]);

/** The name of the function, method or accessor nearest above `node`, or `<top>`. */
function enclosingName(node) {
  for (let at = node.parent; at !== undefined; at = at.parent)
    if (
      (ts.isFunctionDeclaration(at) ||
        ts.isMethodDeclaration(at) ||
        ts.isGetAccessorDeclaration(at) ||
        ts.isSetAccessorDeclaration(at)) &&
      at.name !== undefined
    )
      return at.name.getText();
  return "<top>";
}

/**
 * The exits of `block` that leave it: a `return`, a `throw` (but of `binding`, unless `all`), a `yield` (with `all`),
 * and a `break` or `continue` whose target lies outside it; not inside a nested function or class.
 */
function abrupt(block, all, binding = null) {
  const exits = [];
  const visit = (node, loops, labels) => {
    if (ts.isFunctionLike(node) || ts.isClassLike(node)) return;
    if (ts.isReturnStatement(node) || (all && ts.isYieldExpression(node))) exits.push(node);
    else if (ts.isThrowStatement(node)) {
      if (all || !(ts.isIdentifier(node.expression) && node.expression.text === binding))
        exits.push(node);
    } else if (ts.isBreakStatement(node) || ts.isContinueStatement(node)) {
      const inside =
        node.label === undefined
          ? loops > 0 || (ts.isBreakStatement(node) && labels.has(""))
          : labels.has(node.label.text);
      if (!inside) exits.push(node);
    }
    const loop = ts.isIterationStatement(node, false);
    const nextLabels = ts.isLabeledStatement(node)
      ? new Set([...labels, node.label.text])
      : ts.isSwitchStatement(node)
        ? new Set([...labels, ""])
        : labels;
    ts.forEachChild(node, (child) => visit(child, loop ? loops + 1 : loops, nextLabels));
  };
  ts.forEachChild(block, (child) => visit(child, 0, new Set()));
  return exits;
}

/** An exit's name for a diagnostic. */
function exitName(node) {
  if (ts.isReturnStatement(node)) return "a `return`";
  if (ts.isThrowStatement(node)) return "a `throw` of another error";
  if (ts.isYieldExpression(node)) return "a `yield`";
  return ts.isBreakStatement(node) ? "a `break`" : "a `continue`";
}

/** `node` without the parentheses around it. */
function bare(node) {
  let at = node;
  while (ts.isParenthesizedExpression(at)) at = at.expression;
  return at;
}

/**
 * Whether `test` holds only where `binding` is an instance of a class it names (a positive test): `b instanceof C`, an
 * `||` of such tests, or an `&&` with one; each class collected into `classes`.
 */
function positive(test, binding, classes) {
  const node = bare(test);
  if (
    ts.isBinaryExpression(node) &&
    node.operatorToken.kind === ts.SyntaxKind.InstanceOfKeyword &&
    ts.isIdentifier(bare(node.left)) &&
    bare(node.left).text === binding
  ) {
    classes.push(node.right);
    return true;
  }
  if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.BarBarToken)
    return positive(node.left, binding, classes) && positive(node.right, binding, classes);
  if (
    ts.isBinaryExpression(node) &&
    node.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken
  )
    return positive(node.left, binding, classes) || positive(node.right, binding, classes);
  return false;
}

/** Whether `test` is false only where `binding` is an instance of a class it names: a guard's negated test. */
function negative(test, binding, classes) {
  const node = bare(test);
  if (ts.isPrefixUnaryExpression(node) && node.operator === ts.SyntaxKind.ExclamationToken)
    return positive(node.operand, binding, classes);
  if (
    ts.isBinaryExpression(node) &&
    node.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken
  )
    return negative(node.left, binding, classes) && negative(node.right, binding, classes);
  if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.BarBarToken)
    return negative(node.left, binding, classes) || negative(node.right, binding, classes);
  return false;
}

/** Whether `statement` is `throw <binding>;`, alone or as a block's one statement. */
function rethrows(statement, binding) {
  const node =
    ts.isBlock(statement) && statement.statements.length === 1
      ? statement.statements[0]
      : statement;
  return (
    ts.isThrowStatement(node) &&
    ts.isIdentifier(node.expression) &&
    node.expression.text === binding
  );
}

/**
 * Why `clause` may handle an error that is not type inference's own (R55's closed form, #1072 R60), or `null`: each
 * `instanceof` test of its binding names a class declared under `src/type-inference/` that extends `Error` directly;
 * and either it holds, before any exit, a top-level guard `if (<negated tests>) throw <binding>`, or it ends in
 * `throw <binding>` with every earlier exit under a positive test. A forwarder (`FORWARDERS`) is let through.
 */
function catchRefusal(program, checker, source, file, clause) {
  if (FORWARDERS.has(`${file} ${enclosingName(clause)}`)) return null;
  const declaration = clause.variableDeclaration;
  if (declaration === undefined || !ts.isIdentifier(declaration.name))
    return "a `catch` without a binding handles every error";
  const binding = declaration.name.text;
  const classes = [];
  const statements = clause.block.statements;
  let closed = false;
  for (const statement of statements) {
    if (
      ts.isIfStatement(statement) &&
      statement.elseStatement === undefined &&
      rethrows(statement.thenStatement, binding) &&
      negative(statement.expression, binding, classes)
    ) {
      closed = true;
      break;
    }
    if (abrupt(statement, false, binding).length > 0 || ts.isTryStatement(statement)) break;
  }
  if (!closed) {
    const last = statements.at(-1);
    if (last === undefined || !rethrows(last, binding))
      return "a `catch` that neither ends in `throw <binding>` nor guards its exits by a type inference class";
    for (const exit of abrupt(clause.block, false, binding)) {
      let guarded = false;
      for (let at = exit; at !== clause.block; at = at.parent) {
        const parent = at.parent;
        if (
          ts.isIfStatement(parent) &&
          parent.thenStatement === at &&
          positive(parent.expression, binding, classes)
        ) {
          guarded = true;
          break;
        }
      }
      if (!guarded)
        return `${exitName(exit)} in a \`catch\` not under an \`instanceof\` test of its binding`;
    }
  }
  // (every `instanceof` test of the binding, the ones no form above used included)
  const visit = (node) => {
    if (ts.isFunctionLike(node)) return;
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.InstanceOfKeyword &&
      ts.isIdentifier(bare(node.left)) &&
      bare(node.left).text === binding
    )
      classes.push(node.right);
    ts.forEachChild(node, visit);
  };
  visit(clause.block);
  for (const named of classes) {
    const reason = ownError(program, checker, named);
    if (reason !== null) return reason;
  }
  return null;
}

/** Why the class `named` resolves to is not one of type inference's own errors, or `null`. */
function ownError(program, checker, named) {
  let symbol = checker.getSymbolAtLocation(named);
  if (symbol !== undefined && symbol.flags & ts.SymbolFlags.Alias)
    symbol = checker.getAliasedSymbol(symbol);
  const declaration = symbol?.declarations?.find((each) => ts.isClassDeclaration(each));
  const text = named.getText();
  if (declaration === undefined) return `\`${text}\` is no class declared in type inference`;
  if (!declaration.getSourceFile().fileName.split(sep).join("/").includes(`/${INFERENCE}`))
    return `\`${text}\` is declared outside \`src/type-inference/\``;
  const extended = declaration.heritageClauses?.find(
    (clause) => clause.token === ts.SyntaxKind.ExtendsKeyword,
  )?.types[0]?.expression;
  if (extended === undefined || !ts.isIdentifier(extended) || extended.text !== "Error")
    return `\`${text}\` does not extend \`Error\` directly`;
  const declared = checker.getSymbolAtLocation(extended)?.declarations ?? [];
  if (!declared.some((each) => program.isSourceFileDefaultLibrary(each.getSourceFile())))
    return `\`${text}\` extends an \`Error\` that is not the standard one`;
  return null;
}

/** What of the closed meta-object layer `node` reaches, named for its diagnostic, or `null` (`OBJECT_MEMBERS`). */
function metaReach(node) {
  if (ts.isDeleteExpression(node)) return "the `delete` operator";
  if (ts.isIdentifier(node) && valueReference(node)) {
    if (META_GLOBALS.has(node.text)) return `\`${node.text}\``;
    if (node.text === "Object") {
      const parent = node.parent;
      if (!ts.isPropertyAccessExpression(parent) || parent.expression !== node)
        return "`Object` taken whole";
      return OBJECT_MEMBERS.has(parent.name.text) ? null : `\`Object.${parent.name.text}\``;
    }
  }
  const taken = ts.isBindingElement(node) ? (node.propertyName ?? node.name) : null;
  const name = ts.isPropertyAccessExpression(node)
    ? node.name.text
    : ts.isElementAccessExpression(node) && ts.isStringLiteralLike(node.argumentExpression)
      ? node.argumentExpression.text
      : taken !== null && (ts.isIdentifier(taken) || ts.isStringLiteralLike(taken))
        ? taken.text
        : null;
  if (name !== null && META_PROPERTIES.has(name)) return `\`.${name}\``;
  if (ts.isReturnStatement(node) && node.expression !== undefined) {
    let at = node.parent;
    while (at !== undefined && !ts.isFunctionLike(at)) at = at.parent;
    if (at !== undefined && ts.isConstructorDeclaration(at))
      return "a constructor's `return <value>`";
  }
  return null;
}

/** Whether identifier `node` stands for a value, not a member's, key's, type's or import's name. */
function valueReference(node) {
  const parent = node.parent;
  if (ts.isPropertyAccessExpression(parent)) return parent.expression === node;
  if (ts.isBindingElement(parent)) return parent.propertyName !== node;
  if (
    ts.isPropertyAssignment(parent) ||
    ts.isPropertyDeclaration(parent) ||
    ts.isMethodDeclaration(parent) ||
    ts.isPropertySignature(parent) ||
    ts.isMethodSignature(parent) ||
    ts.isGetAccessorDeclaration(parent) ||
    ts.isSetAccessorDeclaration(parent) ||
    ts.isEnumMember(parent)
  )
    return parent.name !== node;
  return !(
    ts.isTypeReferenceNode(parent) ||
    ts.isQualifiedName(parent) ||
    ts.isImportSpecifier(parent) ||
    ts.isExportSpecifier(parent) ||
    ts.isTypeQueryNode(parent)
  );
}

/** Whether the comment lines right above `node`'s line name its captures (`#1072 R26: captures …` or `… as …`). */
function capturesNamed(source, node) {
  const lines = source.text.split("\n");
  let line = source.getLineAndCharacterOfPosition(node.getStart(source)).line - 1;
  for (; line >= 0 && /^\s*(\/\/|\*|\/\*)/u.test(lines[line]); line -= 1)
    if (/#1072 R26: (captures|as) /u.test(lines[line])) return true;
  return false;
}

/** The node a collection's value goes to: its parent past the wrappers that pass it on unchanged. */
function holder(node) {
  let at = node;
  for (;;) {
    const parent = at.parent;
    if (
      ts.isParenthesizedExpression(parent) ||
      ts.isAsExpression(parent) ||
      ts.isSatisfiesExpression(parent) ||
      ts.isNonNullExpression(parent) ||
      (ts.isConditionalExpression(parent) && parent.condition !== at) ||
      (ts.isBinaryExpression(parent) &&
        (parent.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken ||
          parent.operatorToken.kind === ts.SyntaxKind.BarBarToken)) ||
      ts.isArrayLiteralExpression(parent)
    ) {
      at = parent;
      continue;
    }
    if (ts.isPropertyAssignment(parent) && parent.initializer === at) {
      at = parent.parent;
      continue;
    }
    return { child: at, parent };
  }
}

/** Whether `node` stands inside a function's body. */
function inFunction(node) {
  for (let at = node.parent; at !== undefined; at = at.parent)
    if (ts.isFunctionLike(at)) return true;
  return false;
}

/** Whether an assignment's value goes no further than its variable: not on into another assignment's target. */
function unchained(assignment) {
  const { child, parent } = holder(assignment);
  return (
    !(
      ts.isBinaryExpression(parent) &&
      parent.right === child &&
      parent.operatorToken.kind === ts.SyntaxKind.EqualsToken
    ) || admitted(child, parent)
  );
}

/** Whether `type` is written `ReadonlyMap<…>` or `ReadonlySet<…>`. */
function readonlyType(type) {
  return (
    type !== undefined && ts.isTypeReferenceNode(type) && READONLY.has(type.typeName.getText())
  );
}

/** Whether a collection made at `child` (whose holder is `parent`) stands where the closed set admits it. */
function admitted(child, parent) {
  if (ts.isVariableDeclaration(parent) && parent.initializer === child) {
    if (inFunction(parent)) return true;
    const list = parent.parent;
    const constant = ts.isVariableDeclarationList(list) && (list.flags & ts.NodeFlags.Const) !== 0;
    return constant && readonlyType(parent.type);
  }
  if (
    ts.isBinaryExpression(parent) &&
    parent.right === child &&
    parent.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
    ts.isIdentifier(parent.left)
  )
    return localBinding(parent.left.text, parent) && unchained(parent);
  if (ts.isReturnStatement(parent)) return true;
  if (ts.isArrowFunction(parent) && parent.body === child) return true;
  if (
    (ts.isCallExpression(parent) || ts.isNewExpression(parent)) &&
    parent.arguments?.includes(child)
  )
    return true;
  if (ts.isSpreadElement(parent)) return true;
  if (ts.isForOfStatement(parent) && parent.expression === child) return true;
  if (ts.isPropertyAccessExpression(parent) && parent.expression === child) return true;
  if (ts.isParameter(parent) && parent.initializer === child)
    return (
      readonlyType(parent.type) ||
      !ts
        .getModifiers(parent)
        ?.some(
          (modifier) =>
            modifier.kind === ts.SyntaxKind.ReadonlyKeyword ||
            modifier.kind === ts.SyntaxKind.PublicKeyword ||
            modifier.kind === ts.SyntaxKind.PrivateKeyword ||
            modifier.kind === ts.SyntaxKind.ProtectedKeyword,
        )
    );
  return false;
}

/**
 * The check's diagnostics over `program`'s source files under `root`, each read by its `scopeOf`: `file` or `module`
 * for a checked core file, `program` for the indexed program's own, `null` for a core file left out, `meta` for a file
 * of `src/type-inference/` outside the core, `helper` for a test helper. `levels`, where given, names the files to read
 * and their levels instead (the check's own tests).
 */
export function retainedStateDiagnostics(program, root, levels = null) {
  const checker = program.getTypeChecker();
  const diagnostics = [];
  for (const source of program.getSourceFiles()) {
    if (source.isDeclarationFile) continue;
    const file = pathFrom(root, source.fileName);
    const level = levels === null ? scopeOf(file) : levels.get(file);
    if (level === undefined) continue;
    for (const { node, message } of guardLines(program, checker, source, file, level))
      diagnostics.push({ ...at(source, file, node), message });
    if (level === "program")
      for (const { node, message } of privateFields(checker, source, "program"))
        diagnostics.push({ ...at(source, file, node), message });
    if (level !== "file" && level !== "module") continue;
    const visit = (node) => {
      const kind = ts.isNewExpression(node) ? nativeCollection(checker, program, node) : null;
      if (kind !== null && !(level === "module" && inFunctionOrClass(node))) {
        const { child, parent } = holder(node);
        if (!admitted(child, parent)) {
          diagnostics.push({
            ...at(source, file, node),
            message:
              `a ${kind} made where an owner can keep it: make it through \`Retained\` ` +
              "(src/type-inference/core/retained/retained.ts), so the retained-state instrument makes it (#1072)",
          });
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
    if (level === "file")
      for (const { node, message } of privateFields(checker, source, "owner"))
        diagnostics.push({ ...at(source, file, node), message });
  }
  return diagnostics;
}

/** A diagnostic's place: `node`'s line and column in `source`. */
function at(source, file, node) {
  const { line, character } = source.getLineAndCharacterOfPosition(node.getStart(source));
  return { fileName: file, line: line + 1, column: character + 1 };
}

/** `Retained`'s makers: each makes a kind the instrument makes (`Retained.held` makes nothing). */
const MAKERS = new Set(["map", "set", "weakMap", "weakSet", "record", "arena", "array"]);

/** Whether `node` is a call the checker resolves to one of `Retained`'s makers (`MAKERS`): one that resolves to none is not. */
function retainedCall(checker, node) {
  return node !== undefined && ts.isCallExpression(node) && MAKERS.has(apiMember(checker, node));
}

/**
 * The private fields a `hidden` arrow exposes: the body an object literal, each property whose value is the parameter's
 * private field itself (`(owner) => ({ x: owner.#x })`). A field read any other way (`owner.#x.size`) is not exposed.
 */
function exposedBy(arrow) {
  const names = new Set();
  const [parameter] = arrow.parameters;
  let body = arrow.body;
  while (ts.isParenthesizedExpression(body)) body = body.expression;
  if (
    parameter === undefined ||
    !ts.isIdentifier(parameter.name) ||
    !ts.isObjectLiteralExpression(body)
  )
    return names;
  for (const property of body.properties) {
    const value = ts.isPropertyAssignment(property) ? property.initializer : undefined;
    if (
      value !== undefined &&
      ts.isPropertyAccessExpression(value) &&
      ts.isPrivateIdentifier(value.name) &&
      ts.isIdentifier(value.expression) &&
      value.expression.text === parameter.name.text
    )
      names.add(value.name.text);
  }
  return names;
}

/**
 * Each private instance field of a class in `source` that is neither a readonly `Retained` collection nor exposed: by
 * its class's `Retained.owner` hidden arrow (`registration` `owner`), or, in the indexed program's own files, by its
 * `Retained.programPart` one alone (`program`).
 */
function privateFields(checker, source, registration) {
  const registers = registration === "owner" ? "owner" : "programPart";
  const found = [];
  const visit = (node) => {
    if (ts.isClassLike(node)) {
      const statics = new Map();
      for (const member of node.members)
        if (
          ts.isPropertyDeclaration(member) &&
          ts.isPrivateIdentifier(member.name) &&
          member.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.StaticKeyword)
        )
          statics.set(member.name.text, member.initializer);
      const exposed = new Set();
      const owners = (inner) => {
        const hiddenAt = registers === "owner" ? 2 : 1;
        if (
          ts.isCallExpression(inner) &&
          inner.arguments.length === hiddenAt + 1 &&
          apiMember(checker, inner) === registers
        ) {
          const hidden = inner.arguments[hiddenAt];
          const arrow = ts.isArrowFunction(hidden)
            ? hidden
            : ts.isPropertyAccessExpression(hidden) && ts.isPrivateIdentifier(hidden.name)
              ? statics.get(hidden.name.text)
              : undefined;
          if (arrow !== undefined && ts.isArrowFunction(arrow))
            for (const name of exposedBy(arrow)) exposed.add(name);
        }
        ts.forEachChild(inner, owners);
      };
      for (const member of node.members)
        if (
          (ts.isConstructorDeclaration(member) || registers === "programPart") &&
          "body" in member &&
          member.body !== undefined
        )
          owners(member.body);
      for (const member of node.members) {
        if (!ts.isPropertyDeclaration(member) || !ts.isPrivateIdentifier(member.name)) continue;
        const modifiers = member.modifiers ?? [];
        if (modifiers.some((modifier) => modifier.kind === ts.SyntaxKind.StaticKeyword)) continue;
        const readonly = modifiers.some(
          (modifier) => modifier.kind === ts.SyntaxKind.ReadonlyKeyword,
        );
        const made = registers === "owner" && retainedCall(checker, member.initializer);
        if (
          (readonly && (made || exposed.has(member.name.text))) ||
          OUTSIDE_FIELDS.has(`${node.name?.text}.${member.name.text}`)
        )
          continue;
        found.push({
          node: member,
          message:
            registers === "owner"
              ? `a private field \`${member.name.text}\` of ${node.name?.text ?? "a class"} that the retained-state instrument ` +
                "cannot see: make it `readonly`, made through `Retained` or exposed in its class's `Retained.owner` hidden " +
                "function, which is read once; what changes later goes in a record (`Retained.record`) (#1072)"
              : `a private field \`${member.name.text}\` of the indexed program's ${node.name?.text ?? "class"} that the ` +
                "instrument's walk of the program cannot reach: make it `readonly` and give it in its class's " +
                "`Retained.programPart` hidden function (#1072 R61)",
        });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

/**
 * Whether `name`, assigned at `use`, is bound inside a function: by its nearest declaration (a variable, a parameter)
 * in a scope holding the use. A name bound at the module's top level, or not found, is not.
 */
function localBinding(name, use) {
  const binds = (binding) => ts.isIdentifier(binding) && binding.text === name;
  for (let scope = use.parent; scope !== undefined; scope = scope.parent) {
    if (ts.isFunctionLike(scope) && scope.parameters.some((each) => binds(each.name))) return true;
    const statements = ts.isSourceFile(scope) || ts.isBlock(scope) ? scope.statements : [];
    for (const statement of statements)
      if (
        ts.isVariableStatement(statement) &&
        statement.declarationList.declarations.some((each) => binds(each.name))
      )
        return !ts.isSourceFile(scope);
    if (
      (ts.isForStatement(scope) || ts.isForOfStatement(scope)) &&
      scope.initializer !== undefined &&
      ts.isVariableDeclarationList(scope.initializer) &&
      scope.initializer.declarations.some((each) => binds(each.name))
    )
      return true;
  }
  return false;
}

/** Whether `node` stands inside a function or a class: not at its module's top level. */
function inFunctionOrClass(node) {
  for (let at = node.parent; at !== undefined; at = at.parent)
    if (ts.isFunctionLike(at) || ts.isClassLike(at)) return true;
  return false;
}
