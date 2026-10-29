import { existsSync, readdirSync } from "node:fs";
import { relative, resolve, sep } from "node:path";
import { Project, ts } from "ts-morph";

/**
 * The derivation inventory's guard (TABLE r4.138, r4.143), syntactic and scoped by name (TABLE r4.182). `OBLIGATION_SITES`
 * lists every derivation of admission's that creates an obligation; a stop before admission settled runs each in the
 * fresh pass. A derivation of `Admission`'s or `Consumers`' is a member of the class with a body (a method, a getter and
 * setter pair as one, a property holding a function), or a function of its files (the entry, and the parts in the
 * folder beside it) with a parameter typed as the class: a method whose body moved there, known by its declaration. A
 * public method whose one statement forwards to the function of its name is that function, its arguments its own
 * parameters. The guarded members are known by the compiler's symbols: every member of `Admission` per the type
 * checker (a constructor's parameter properties, accessors and overloads, each with all its declarations), `readChecks`
 * and `Consumers`' recording arrays among them, `boundaryCheck`, a parameter named `error` in admission's files, and a
 * derivation moved to a function. A reference is every name whose symbol is one, or an alias of one: an import, a
 * namespace's member, a destructuring's key in a declaration or an assignment, a shorthand property; in a value
 * position, a class's `extends` expression included, not a type's (an annotation, a type argument, an interface's or an
 * `implements` heritage). The check
 * recognises a closed list of its forms: a direct call of a derivation, `R.m(…)` or `f(…)` as written, and an exact
 * forwarder's call; inside a derivation of admission's, a push `R.readChecks.push(…)`, a call `boundaryCheck(…)` or a
 * call of a parameter named `error` (each creating an obligation); inside a consumer derivation, a push onto a
 * recording array (`diagnostics`, `deferred`, `checks`), a conditional of them included; admission's own code using its
 * own state; a dot read of a `get` accessor `READS` lists, a read (no write, no `delete`); and the reads `LISTED_READS`
 * lists. Every other
 * reference, anywhere in `src/type-inference/core/`, is reported as unproved by the name it contains, whatever flows
 * from it. The check rejects:
 * - a name that names more than one derivation;
 * - an `Admission` derivation that creates an obligation and is not an inventory entry, and a creation outside every
 *   derivation;
 * - a call from a consumer derivation that creates an obligation (one that records a diagnostic or a check, or calls
 *   one that does, directly) into an `Admission` derivation that is neither an inventory entry nor a read `READS` lists
 *   with why it creates none; a call of an `Admission` member that is no derivation; outside admission and every
 *   consumer derivation, a call of a derivation that is no listed read, and a recording;
 * - an inventory entry whose `runs` names other than one derivation across admission and the consumers, or one the
 *   fresh pass does not call directly; a fresh pass that is not one derivation;
 * - an `AdmissionHost` member, inherited ones included, that is not a host read `HOST_READS` lists with why it creates
 *   no obligation (a derivation returns what it leaves open to the consumers, which record it), so no new callback
 *   records one for admission whatever its wiring (Codex r23, r24 T1).
 * A listed host read or read is trusted by its reason (TABLE r4.152 (3)). A reference the syntax does not name (an
 * inherited member reached through an inferred wrapper, a generic receiver, a computed name, a value passed through an
 * aggregate or a copy) is outside this check, a review matter against r4.182, as r4.165 states it for the question
 * sources. Known miss (#1401): instantiation expressions can hide named value references; interface computed keys can
 * be reported as values.
 */
const ADMISSION = "src/type-inference/core/admission.ts";
const CONSUMERS = "src/type-inference/core/consumers.ts";
const CORE = "src/type-inference/core";

/** A split file's files: the entry, which holds the class, and its parts in the folder beside it, where there is one. */
function splitFiles(root, entry) {
  const parts = entry.replace(/\.ts$/, "");
  return [
    entry,
    ...(existsSync(resolve(root, parts))
      ? readdirSync(resolve(root, parts))
          .filter((name) => name.endsWith(".ts"))
          .sort()
          .map((name) => `${parts}/${name}`)
      : []),
  ];
}

/** The admission files: the entry and its parts. */
export const admissionFiles = (root) => splitFiles(root, ADMISSION);

/** The consumers files: the entry and its parts. */
export const consumersFiles = (root) => splitFiles(root, CONSUMERS);

/** The `Admission` derivations those consumer derivations call that create no obligation, each with why. */
export const READS = new Map([
  ["admitted", "the admitted type at a path: a decision's answer, recorded by `decide`"],
  ["atCopy", "whether A2 found copies meeting at a path: where the error goes, a test"],
  ["boundariesAt", "`boundaryFor` for each item: the obligation is that entry's"],
  ["boundaryAt", "records a store whose boundary `publish` forms: the obligation is that entry's"],
  ["cellSited", "C9's site for an item a store brings: a site, read"],
  ["compareLanded", "the member-answer oracle's comparison, a test seam inert outside it"],
  ["contributionSited", "C1's site for an item an add brings: a site, read"],
  [
    "copiedAt",
    "the written type a copy decides a key by: a decision's answer, recorded by `decide`",
  ],
  ["decisionStopped", "whether a key's decision stopped at its demand allowance: a test"],
  ["groups", "the places and paths `decide` decides: its inputs"],
  ["ingressSiteOf", "C1's site for external data a store brings: a site, read"],
  [
    "kindsAt",
    "the kinds a key's decision decided or settled it by: a decision's answer, recorded by `decide`",
  ],
  ["literalChildren", "a literal's children at a step: syntax"],
  ["namedExternalSite", "where a store's named external data enters: a site, read"],
  ["offendingAt", "the innermost offending expression of a contribution: a site, read"],
  ["ownIngress", "whether an item is the store's own ingress: a test"],
  ["ownReadItem", "whether external data is an operation's own read's alone: a test"],
  ["reject", "records a rejected store (A6): the C1 error that rejects it is the consumer's own"],
  ["retained", "the decision admission retained before a stop: a decision's answer"],
  ["siteAt", "the site of an error for a store's contribution: a site, read"],
  ["sourceOrder", "a definition's place in source order"],
  [
    "stopDecision",
    "takes back what a decision stopped at its demand allowance made of its key: each read of the key owes its own check",
  ],
  [
    "storeRequirement",
    "the complete type a store above a stopped decision is checked against: a decision's answer, recorded by `decide`",
  ],
  ["storesAt", "the stores reaching a key: `decide`'s inputs"],
  ["takeBackReadChecks", "takes the running unit's read checks back at a stop: creates none"],
  ["typedByDefault", "whether an ingress is typed by its default alone (F18): a test"],
  ["valueAt", "a store's value at a path: the items C1 compares"],
  ["wholeBelow", "the whole value a stored path lies below: a read"],
]);

/** The `AdmissionHost` members, each with why it creates no obligation. */
export const HOST_READS = new Map([
  ["run", "runs a solver demand: an answer"],
  ["read", "the finishing read after a stop: an answer"],
]);

/**
 * The members read outside admission's own code, by the forms the inventory recognises (TABLE r4.182): [member, form,
 * file, why it creates no obligation]. A form is `length` (its `.length`), `for-of` (iterated), `spread` (spread into
 * an array), `operand` (an operand of arithmetic or a comparison), `variable` (a variable's whole initializer),
 * `argument` (a call's argument), `property` (an object literal's property value), `.<method>` (a call of the value's
 * own method), or `call` (a direct call of the derivation outside every consumer derivation). `readChecks` and the
 * recording arrays are listed here too: any other form of them is unproved.
 */
const LISTED_READS = [
  [
    "readChecks",
    "length",
    "boundaries.ts",
    "the running unit's read checks taken back after a stop (D4 a′): truncated to a count",
  ],
  ["readChecks", "length", "consumers.ts", "how many read checks a unit made: a count"],
  ["readChecks", "length", "stores.ts", "how many read checks a unit made: a count"],
  ["readChecks", "for-of", "answers.ts", "the published read checks, read after the walk"],
  [
    "newlyRejected",
    "variable",
    "answers.ts",
    "the stores this pass rejected, which A6's next pass takes",
  ],
  [
    "newlyRejected",
    "argument",
    "consumers.ts",
    "the stores this pass rejected, compared before a finishing walk",
  ],
  ["newlyRejected", ".get", "fresh.ts", "whether a store was rejected: a test"],
  [
    "refused",
    ".has",
    "enclosing.ts",
    "whether the pass rejected a store above a stop, whose error stands: a test",
  ],
  [
    "boundaries",
    ".clear",
    "consumers.ts",
    "the published boundary checks, dropped before a finishing walk",
  ],
  ["boundaries", ".values", "answers.ts", "the published boundary checks, read after the walk"],
  ["boundaries", ".get", "answers.ts", "a key's published boundary checks, read after the walk"],
  [
    "rejections",
    "operand",
    "stores.ts",
    "a count of rejections, summed into a unit's emitted count",
  ],
  ["diagnostics", "length", "consumers.ts", "how many diagnostics a unit recorded: a count"],
  ["diagnostics", "length", "stores.ts", "how many diagnostics a unit recorded: a count"],
  ["diagnostics", "spread", "answers.ts", "the recorded diagnostics, read after the walk"],
  ["deferred", "length", "answers.ts", "whether checks were deferred: a count"],
  ["deferred", "argument", "answers.ts", "the deferred checks, read after the walk"],
  ["deferred", ".map", "answers.ts", "the deferred checks, read after the walk"],
  ["deferred", "property", "answers.ts", "the deferred checks, published after the walk"],
  [
    "cycling",
    ".has",
    "stores.ts",
    "whether a store is in a rejection cycle (A6): the constructor's input, read",
  ],
  [
    "deciderAt",
    "call",
    "answers.ts",
    "the site that decided an answer, read where the answer asks it",
  ],
  ["inheritsWritten", "call", "answers.ts", "whether a copy decides an answer, read with it"],
  [
    "stored",
    ".along",
    "enclosing.ts",
    "the keys whole stores and adds reach above a stopped key: the stores the stop stands for, read",
  ],
];

export function checkObligationInventory(root) {
  const project = new Project({
    tsConfigFilePath: resolve(root, "tsconfig.json"),
    skipAddingFilesFromTsConfig: true,
  });
  const admission = admissionFiles(root);
  const consumers = consumersFiles(root);
  const core = readdirSync(resolve(root, CORE), { recursive: true, encoding: "utf8" })
    .filter((name) => name.endsWith(".ts"))
    .sort()
    .map((name) => `${CORE}/${name.split(sep).join("/")}`);
  for (const file of core) project.addSourceFileAtPath(resolve(root, file));
  project.resolveSourceFileDependencies();
  return obligationInventoryDiagnostics(project.getProgram().compilerObject, root, {
    admission,
    consumers,
    scope: core,
    reads: READS,
    hostReads: HOST_READS,
    listedReads: LISTED_READS,
  });
}

/**
 * @param {ts.Program} program
 * @param {string} root
 * @param {{ admission: readonly string[], consumers: readonly string[], scope?: readonly string[], reads: ReadonlyMap<string, string>, hostReads: ReadonlyMap<string, string>, listedReads?: readonly (readonly string[])[] }} files
 * @returns {{ fileName: string, line: number, column: number, message: string }[]}
 */
export function obligationInventoryDiagnostics(program, root, files) {
  const checker = program.getTypeChecker();
  const diagnostics = [];
  const report = (node, message) => {
    const sourceFile = node.getSourceFile();
    const location = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
    diagnostics.push({
      fileName: relative(root, sourceFile.fileName).split(sep).join("/"),
      line: location.line + 1,
      column: location.character + 1,
      message,
    });
  };
  const sourceOf = (file) => {
    const found = program.getSourceFile(resolve(root, file));
    if (found === undefined) throw new Error(`The inventory check reads ${file}.`);
    return found;
  };
  const declarationIn = (sourceFiles, test, what) => {
    let found = null;
    for (const sourceFile of sourceFiles)
      sourceFile.forEachChild((node) => {
        if (test(node)) found = node;
      });
    if (found === null) throw new Error(`No ${what} in ${sourceFiles[0].fileName} or beside it.`);
    return found;
  };
  const admissionFiles = files.admission.map(sourceOf);
  const consumerFiles = files.consumers.map(sourceOf);
  const scopeFiles = [
    ...new Set([...admissionFiles, ...consumerFiles, ...(files.scope ?? []).map(sourceOf)]),
  ];
  const listedReads = files.listedReads ?? LISTED_READS;
  const admissionClass = declarationIn(
    admissionFiles,
    (node) => ts.isClassDeclaration(node) && node.name?.text === "Admission",
    "class Admission",
  );
  const consumersClass = declarationIn(
    consumerFiles,
    (node) => ts.isClassDeclaration(node) && node.name?.text === "Consumers",
    "class Consumers",
  );

  // a declaration's static name: an identifier's or a private name's, a quoted one or a computed literal's; else null
  const nameOf = (declaration) => {
    const name = declaration.name;
    if (name === undefined) return ts.isConstructorDeclaration(declaration) ? "constructor" : null;
    if (ts.isIdentifier(name) || ts.isPrivateIdentifier(name) || ts.isStringLiteralLike(name))
      return name.text;
    const key = ts.isComputedPropertyName(name) ? name.expression : undefined;
    return key !== undefined && (ts.isStringLiteralLike(key) || ts.isNumericLiteral(key))
      ? key.text
      : null;
  };
  const calls = (node) => {
    const out = [];
    const visit = (at) => {
      if (ts.isCallExpression(at)) out.push(at);
      at.forEachChild(visit);
    };
    visit(node);
    return out;
  };
  // the function a declaration is or holds: a method's, an accessor's, a function's; a property's or a variable's value
  const functionOf = (declaration) => {
    if (ts.isPropertyDeclaration(declaration) || ts.isVariableDeclaration(declaration)) {
      const value = declaration.initializer;
      return value !== undefined && (ts.isArrowFunction(value) || ts.isFunctionExpression(value))
        ? value
        : undefined;
    }
    return ts.isFunctionLike(declaration) && declaration.body !== undefined
      ? declaration
      : undefined;
  };
  // whether a type is the class's instance, or names it (a union's or an intersection's member, a constraint)
  const mentions = (type, cls, seen = new Set()) => {
    if (type === undefined || seen.has(type)) return false;
    seen.add(type);
    if (type.getSymbol()?.declarations?.[0] === cls) return true;
    if (type.isUnionOrIntersection()) return type.types.some((part) => mentions(part, cls, seen));
    if (type.isTypeParameter()) return mentions(type.getConstraint(), cls, seen);
    return false;
  };
  const typedAs = (node, cls) =>
    node !== undefined && mentions(checker.getTypeAtLocation(node), cls);
  // a symbol, an alias (an import, a namespace's export) followed to what it stands for
  const resolved = (symbol) =>
    symbol !== undefined && symbol.flags & ts.SymbolFlags.Alias
      ? checker.getAliasedSymbol(symbol)
      : symbol;
  // the symbol a name stands for, by the compiler
  const symbolOf = (name) => resolved(checker.getSymbolAtLocation(name));
  // every declaration of a symbol: its overloads, a getter and its setter
  const declarationsOf = (symbol) => symbol?.declarations ?? [];

  /**
   * A class's derivations, each by its declaration: a member of the class with a body (a method, a getter and setter
   * pair as one, a property holding a function), or a function of its files with a parameter typed as the class (a
   * method whose body moved there), declared or held by a variable. A public method whose one statement is
   * `return f(this, a, b);` or `f(this, a, b);`, its own parameters in order, none with an initializer, no decorator or
   * other modifier, `f` that function of its name, is that function. Every name names one derivation.
   */
  const derivationsOf = (cls, sourceFiles, label) => {
    const declarations = [];
    for (const member of cls.members)
      if (functionOf(member) !== undefined && nameOf(member) !== null) declarations.push(member);
    const consider = (declaration) => {
      const fn = functionOf(declaration);
      if (
        fn !== undefined &&
        nameOf(declaration) !== null &&
        fn.parameters.some((parameter) => typedAs(parameter, cls))
      )
        declarations.push(declaration);
    };
    for (const sourceFile of sourceFiles)
      sourceFile.forEachChild((node) => {
        if (ts.isFunctionDeclaration(node)) consider(node);
        else if (ts.isVariableStatement(node))
          for (const declaration of node.declarationList.declarations) consider(declaration);
      });
    const known = new Set(declarations);
    // (the calls of the forwarders proved: their arguments are their own parameters)
    const forwarderCalls = new Set();
    const forwardsTo = (member) => {
      if (
        !ts.isMethodDeclaration(member) ||
        !ts.isIdentifier(member.name) ||
        (ts.getModifiers(member) ?? []).some(
          (modifier) => modifier.kind !== ts.SyntaxKind.PublicKeyword,
        ) ||
        (ts.getDecorators(member) ?? []).length > 0 ||
        member.parameters.some(
          (parameter) =>
            parameter.initializer !== undefined ||
            parameter.dotDotDotToken !== undefined ||
            !ts.isIdentifier(parameter.name),
        )
      )
        return undefined;
      const statements = member.body?.statements ?? [];
      const only = statements.length === 1 ? statements[0] : undefined;
      const call =
        only !== undefined && (ts.isReturnStatement(only) || ts.isExpressionStatement(only))
          ? only.expression
          : undefined;
      if (call === undefined || !ts.isCallExpression(call) || !ts.isIdentifier(call.expression))
        return undefined;
      const [instance, ...rest] = call.arguments;
      if (
        instance?.kind !== ts.SyntaxKind.ThisKeyword ||
        rest.length !== member.parameters.length ||
        rest.some(
          (argument, index) =>
            !ts.isIdentifier(argument) ||
            checker.getSymbolAtLocation(argument)?.declarations?.[0] !== member.parameters[index],
        )
      )
        return undefined;
      const fn = declarationsOf(symbolOf(call.expression)).find((declaration) =>
        known.has(declaration),
      );
      const first = fn === undefined ? undefined : functionOf(fn)?.parameters[0];
      if (
        !known.has(fn) ||
        fn.parent === cls ||
        nameOf(fn) !== nameOf(member) ||
        first === undefined ||
        !typedAs(first, cls)
      )
        return undefined;
      forwarderCalls.add(call);
      return fn;
    };
    // (a getter and a setter of one name are one property)
    const accessors = new Map();
    for (const declaration of declarations)
      if (ts.isAccessor(declaration) && !accessors.has(nameOf(declaration)))
        accessors.set(nameOf(declaration), declaration);
    const identity = new Map(
      declarations.map((declaration) => [
        declaration,
        forwardsTo(declaration) ??
          (ts.isAccessor(declaration) ? accessors.get(nameOf(declaration)) : declaration),
      ]),
    );
    const parts = new Map();
    for (const declaration of declarations)
      parts.set(identity.get(declaration), [
        ...(parts.get(identity.get(declaration)) ?? []),
        declaration,
      ]);
    const byName = new Map();
    for (const derivation of parts.keys())
      byName.set(nameOf(derivation), [...(byName.get(nameOf(derivation)) ?? []), derivation]);
    for (const declaration of declarations) {
      const named = byName.get(nameOf(declaration));
      if (named.length > 1)
        report(
          declaration,
          `${label}.${nameOf(declaration)} names ${named.length} derivations: an inventory name names one, so rename all but one.`,
        );
    }
    return {
      derivations: [...parts.keys()],
      namedAll: (name) => byName.get(name) ?? [],
      // whether a call is a proved forwarder's
      forwards: (call) => forwarderCalls.has(call),
      // the derivation a declaration is part of
      of: (declaration) => (known.has(declaration) ? identity.get(declaration) : undefined),
      // the declaration of a derivation a node lies in, the innermost
      around: (node) => {
        for (let at = node; at !== undefined; at = at.parent) if (known.has(at)) return at;
        return undefined;
      },
      nodesIn: (derivation) => parts.get(derivation),
      parametersOf: (derivation) =>
        parts.get(derivation).flatMap((declaration) => [...functionOf(declaration).parameters]),
      callsIn: (derivation) => parts.get(derivation).flatMap((declaration) => calls(declaration)),
    };
  };

  const admission = derivationsOf(admissionClass, admissionFiles, "Admission");
  const consumer = derivationsOf(consumersClass, consumerFiles, "Consumers");
  // admission's own code: the class, and its derivations moved to functions
  const inAdmissionCode = (node) =>
    admission.around(node) !== undefined ||
    (() => {
      for (let at = node; at !== undefined; at = at.parent) if (at === admissionClass) return true;
      return false;
    })();

  /**
   * The direct callee of a call (TABLE r4.182's closed forms): `R.m(…)` or `f(…)`, the callee a member access or a
   * name as written, no wrapper, no `call` or `apply`; the symbol it stands for, an import followed.
   */
  const directCallee = (call) => {
    const callee = call.expression;
    if (ts.isPropertyAccessExpression(callee)) return symbolOf(callee.name);
    if (ts.isIdentifier(callee)) return symbolOf(callee);
    return undefined;
  };
  // the derivation of a model a symbol names, by any of its declarations (an overload's implementation, an accessor's
  // pair), else undefined
  const derivationIn = (model, symbol) =>
    declarationsOf(symbol)
      .map((declaration) => model.of(declaration))
      .find((derivation) => derivation !== undefined);

  // the inventory: OBLIGATION_SITES' entries, by their method and the derivation the fresh pass runs
  const entries = new Map();
  for (const sourceFile of admissionFiles)
    sourceFile.forEachChild((node) => {
      if (!ts.isVariableStatement(node)) return;
      for (const declaration of node.declarationList.declarations) {
        if (declaration.name.getText() !== "OBLIGATION_SITES") continue;
        let list = declaration.initializer;
        while (list !== undefined && (ts.isAsExpression(list) || ts.isSatisfiesExpression(list)))
          list = list.expression;
        if (list === undefined || !ts.isArrayLiteralExpression(list)) continue;
        for (const element of list.elements) {
          if (!ts.isObjectLiteralExpression(element)) continue;
          const field = (key) =>
            element.properties.find(
              (property) => ts.isPropertyAssignment(property) && property.name.getText() === key,
            )?.initializer;
          const method = field("method");
          const runs = field("runs");
          if (method !== undefined && ts.isStringLiteral(method))
            entries.set(method.text, {
              node: element,
              runs: runs !== undefined && ts.isStringLiteral(runs) ? runs.text : null,
            });
        }
      }
    });
  if (entries.size === 0) report(admissionClass, "OBLIGATION_SITES lists no derivation.");

  /*
   * The guarded members, by the compiler's symbols (TABLE r4.182, Codex r6): every member of `Admission` per the type
   * checker (its properties, a constructor's parameter properties, its methods and accessors, each with all their
   * declarations), `readChecks` the creation channel among them; `Consumers`' recording arrays; `boundaryCheck`; every
   * parameter named `error` in admission's files; and every derivation of admission's moved to a function. Each reference
   * to one, every name whose symbol is one or an alias of one, wherever it stands in the scope, is in a recognised form
   * or is reported as unproved, by the name it contains, whatever flows from it.
   */
  const RECORDS = ["diagnostics", "deferred", "checks"];
  const guarded = new Map(); // symbol → { kind, name, label }
  const guard = (symbol, kind, name, label) => {
    if (symbol !== undefined && !guarded.has(symbol)) guarded.set(symbol, { kind, name, label });
  };
  const MEMBER = ts.SymbolFlags.Property | ts.SymbolFlags.Method | ts.SymbolFlags.Accessor;
  const membersOf = (cls) => {
    const symbol = checker.getSymbolAtLocation(cls.name);
    return [...(symbol?.members?.values() ?? []), ...(symbol?.exports?.values() ?? [])].filter(
      (member) => member.flags & MEMBER && !(member.flags & ts.SymbolFlags.Prototype),
    );
  };
  const memberName = (symbol) => nameOf(declarationsOf(symbol)[0] ?? {}) ?? symbol.getName();
  for (const member of membersOf(admissionClass))
    guard(member, "admission", memberName(member), `Admission.${memberName(member)}`);
  for (const member of membersOf(consumersClass))
    if (RECORDS.includes(memberName(member)))
      guard(member, "record", memberName(member), `Consumers.${memberName(member)}`);
  for (const sourceFile of admissionFiles) {
    const visit = (node) => {
      if (ts.isFunctionDeclaration(node) && node.name?.text === "boundaryCheck")
        guard(checker.getSymbolAtLocation(node.name), "boundary", "boundaryCheck", "boundaryCheck");
      if (ts.isParameter(node) && ts.isIdentifier(node.name) && node.name.text === "error")
        guard(checker.getSymbolAtLocation(node.name), "error", "error", "an error parameter");
      node.forEachChild(visit);
    };
    visit(sourceFile);
  }
  for (const derivation of admission.derivations)
    for (const declaration of admission.nodesIn(derivation))
      if (declaration.parent !== admissionClass && declaration.name !== undefined)
        guard(
          checker.getSymbolAtLocation(declaration.name),
          "moved",
          nameOf(declaration),
          `Admission.${nameOf(declaration)}`,
        );
  // (a transient symbol, a union's or an instantiation's property, stands for the members it is made of)
  const byDeclaration = new Map();
  for (const [symbol, entry] of guarded)
    for (const declaration of declarationsOf(symbol)) byDeclaration.set(declaration, entry);
  const guardOf = (symbol) =>
    symbol === undefined
      ? undefined
      : (guarded.get(symbol) ??
        (symbol.flags & ts.SymbolFlags.Transient
          ? declarationsOf(symbol)
              .map((declaration) => byDeclaration.get(declaration))
              .find((entry) => entry !== undefined)
          : undefined));

  const baseName = (sourceFile) => sourceFile.fileName.split("/").pop();
  // whether an expression is written: an assignment's or an update's target, a for-in/of's, or part of a destructuring
  // assignment's pattern
  const assignedTo = (expression) => {
    let at = expression;
    for (;;) {
      const parent = at.parent;
      if (
        ts.isParenthesizedExpression(parent) ||
        ts.isArrayLiteralExpression(parent) ||
        ts.isSpreadElement(parent) ||
        ts.isSpreadAssignment(parent) ||
        ts.isShorthandPropertyAssignment(parent) ||
        ts.isObjectLiteralExpression(parent) ||
        (ts.isPropertyAssignment(parent) && parent.initializer === at)
      ) {
        at = parent;
        continue;
      }
      if (ts.isBinaryExpression(parent))
        return (
          parent.left === at &&
          parent.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
          parent.operatorToken.kind <= ts.SyntaxKind.LastAssignment
        );
      if (ts.isPrefixUnaryExpression(parent) || ts.isPostfixUnaryExpression(parent))
        return (
          parent.operator === ts.SyntaxKind.PlusPlusToken ||
          parent.operator === ts.SyntaxKind.MinusMinusToken
        );
      if (ts.isForOfStatement(parent) || ts.isForInStatement(parent))
        return parent.initializer === at;
      return false;
    }
  };
  // whether an expression is `delete`'s operand: no read
  const deleted = (expression) => {
    let at = expression;
    while (ts.isParenthesizedExpression(at.parent)) at = at.parent;
    return ts.isDeleteExpression(at.parent);
  };
  // whether a dot reference reads: neither written nor deleted
  const reads = (access) => !assignedTo(access) && !deleted(access);
  // the listed read form a dot reference `R.m` stands in, else null
  const readForm = (access) => {
    const parent = access.parent;
    if (ts.isPropertyAccessExpression(parent) && parent.expression === access)
      return parent.name.text === "length"
        ? "length"
        : ts.isCallExpression(parent.parent) && parent.parent.expression === parent
          ? `.${parent.name.text}`
          : null;
    if (ts.isForOfStatement(parent) && parent.expression === access) return "for-of";
    if (ts.isSpreadElement(parent)) return "spread";
    if (
      ts.isBinaryExpression(parent) &&
      [
        ts.SyntaxKind.PlusToken,
        ts.SyntaxKind.MinusToken,
        ts.SyntaxKind.LessThanToken,
        ts.SyntaxKind.GreaterThanToken,
        ts.SyntaxKind.LessThanEqualsToken,
        ts.SyntaxKind.GreaterThanEqualsToken,
        ts.SyntaxKind.EqualsEqualsEqualsToken,
        ts.SyntaxKind.ExclamationEqualsEqualsToken,
      ].includes(parent.operatorToken.kind)
    )
      return "operand";
    if (
      ts.isVariableDeclaration(parent) &&
      parent.initializer === access &&
      ts.isIdentifier(parent.name)
    )
      return "variable";
    if (ts.isCallExpression(parent) && parent.arguments.includes(access)) return "argument";
    if (ts.isPropertyAssignment(parent) && parent.initializer === access) return "property";
    return null;
  };
  const listed = (name, form, sourceFile) =>
    listedReads.some(
      ([member, at, file]) => member === name && at === form && file === baseName(sourceFile),
    );
  // a push onto `R.m`, or onto a conditional of such arrays: the push call, else undefined
  const pushOf = (access) => {
    let at = access;
    while (ts.isConditionalExpression(at.parent) && at.parent.condition !== at) at = at.parent;
    while (ts.isParenthesizedExpression(at.parent)) at = at.parent;
    const method = at.parent;
    return ts.isPropertyAccessExpression(method) &&
      method.expression === at &&
      method.name.text === "push" &&
      ts.isCallExpression(method.parent) &&
      method.parent.expression === method
      ? method.parent
      : undefined;
  };
  // a key's static text: an identifier's, a quoted one's, a computed literal's; else null
  const keyText = (key) => {
    const literal = ts.isComputedPropertyName(key) ? key.expression : key;
    return ts.isIdentifier(literal) ||
      ts.isPrivateIdentifier(literal) ||
      ts.isStringLiteralLike(literal) ||
      ts.isNumericLiteral(literal)
      ? literal.text
      : null;
  };
  /**
   * The guarded members a node names, by the compiler (Codex r6 B1): the symbol of a name (an alias followed), the
   * property a destructuring's key reads, in a declaration (`const { m } = R`, a parameter's, nested) or an assignment
   * (`({ m } = R)`, `for ({ m } of …)`), and a shorthand property's value or target. Each is [the node reported, the
   * entry, the symbol].
   */
  const namedBy = (node) => {
    const parent = node.parent;
    const found = [];
    const add = (symbol, at = node) => {
      const named = resolved(symbol);
      const entry = guardOf(named);
      if (entry !== undefined && !found.some(([, seen]) => seen === entry))
        found.push([at, entry, named]);
    };
    if (ts.isBindingElement(node) && ts.isObjectBindingPattern(parent)) {
      const text = keyText(node.propertyName ?? node.name);
      if (text !== null) add(checker.getTypeAtLocation(parent).getProperty(text));
      return found;
    }
    if (
      (ts.isPropertyAssignment(node) || ts.isShorthandPropertyAssignment(node)) &&
      ts.isObjectLiteralExpression(parent) &&
      assignedTo(parent)
    ) {
      const text = keyText(node.name);
      if (text !== null) add(checker.getTypeOfAssignmentPattern(parent).getProperty(text));
      // (a shorthand one's name is also the target it assigns)
      if (ts.isShorthandPropertyAssignment(node))
        add(checker.getShorthandAssignmentValueSymbol(node), node.name);
      return found;
    }
    if (ts.isIdentifier(node) || ts.isPrivateIdentifier(node) || ts.isStringLiteralLike(node)) {
      // (a destructuring's keys are read above, by the property they name)
      if (
        (ts.isBindingElement(parent) && (parent.propertyName === node || parent.name === node)) ||
        ((ts.isPropertyAssignment(parent) || ts.isShorthandPropertyAssignment(parent)) &&
          parent.name === node &&
          ts.isObjectLiteralExpression(parent.parent) &&
          assignedTo(parent.parent))
      )
        return found;
      add(checker.getSymbolAtLocation(node));
      if (ts.isShorthandPropertyAssignment(parent) && parent.name === node)
        add(checker.getShorthandAssignmentValueSymbol(parent));
    }
    return found;
  };

  // every reference in the scope, classified: what it creates or records, what it calls, or what is unproved
  const creations = []; // [the call, the admission derivation around it, or undefined]
  const recordings = []; // [the push, the consumer derivation around it, or undefined]
  const admissionCalls = []; // [the call, the admission derivation called, the consumer derivation around it]
  const readsAsked = new Set();
  const unproved = (node, entry, form) =>
    report(
      node,
      `Unproved: ${entry.label} is named in a form the inventory does not recognise (${form}): use a listed form, or list it.`,
    );
  // a reference, by its syntactic form against the closed list
  const classify = (node, entry, symbol, sourceFile) => {
    const { kind, name } = entry;
    const parent = node.parent;
    if (
      ts.isBindingElement(node) ||
      ts.isPropertyAssignment(node) ||
      ts.isShorthandPropertyAssignment(node)
    ) {
      unproved(node, entry, "a destructuring");
      return;
    }
    // (its own declaration: a property, a method, an accessor, a parameter property, an overload, a function)
    if (
      declarationsOf(symbol).some(
        (declaration) =>
          declaration.name === node ||
          (declaration.name !== undefined &&
            ts.isComputedPropertyName(declaration.name) &&
            declaration.name.expression === node),
      )
    )
      return;
    // (an import is named once, by what it imports: an unrenamed one is the binding, its uses checked)
    if (ts.isImportSpecifier(parent) || ts.isExportSpecifier(parent)) {
      if (parent.propertyName !== undefined && parent.name === node) return;
      if (ts.isImportSpecifier(parent) && parent.propertyName === undefined) return;
      unproved(node, entry, ts.isImportSpecifier(parent) ? "an import alias" : "an export");
      return;
    }
    if (ts.isElementAccessExpression(parent) && parent.argumentExpression === node) {
      unproved(parent, entry, "an element access");
      return;
    }
    if (ts.isPropertyAccessExpression(parent) && parent.name === node) {
      const access = parent;
      const callee = ts.isCallExpression(access.parent) && access.parent.expression === access;
      const form = assignedTo(access)
        ? "a write"
        : deleted(access)
          ? "a deletion"
          : (readForm(access) ?? "a value");
      if (kind === "moved" || kind === "boundary" || kind === "error")
        unproved(access, entry, "a namespace member");
      else if (kind === "record") {
        const push = pushOf(access);
        if (push !== undefined) recordings.push([push, consumer.around(access)]);
        else if (!listed(name, form, sourceFile)) unproved(access, entry, form);
      } else if (name === "readChecks") {
        const push = pushOf(access);
        if (push !== undefined) creations.push([push, admission.around(access)]);
        else if (!listed(name, form, sourceFile)) unproved(access, entry, form);
      } else if (inAdmissionCode(access));
      else if (callee) {
        const derivation = derivationIn(admission, symbol);
        if (derivation === undefined)
          report(
            access,
            `Unproved: Admission.${name} is called but is no derivation the inventory can name: make it one.`,
          );
        else admissionCalls.push([access.parent, derivation, consumer.around(access)]);
      } else if (
        // (a listed getter's dot read, nothing else: a read, no setter alone, N1, Codex r6 B4, r7 B2)
        reads(access) &&
        files.reads.has(name) &&
        declarationsOf(symbol).some((declaration) => ts.isGetAccessorDeclaration(declaration))
      ) {
        readsAsked.add(name);
        admissionCalls.push([access, derivationIn(admission, symbol), consumer.around(access)]);
      } else if (!listed(name, form, sourceFile)) unproved(access, entry, form);
      return;
    }
    if (ts.isIdentifier(node) && (kind === "moved" || kind === "boundary" || kind === "error")) {
      // (an exact forwarder's argument: its own parameter, handed to the function it is)
      if (
        ts.isCallExpression(parent) &&
        parent.arguments.includes(node) &&
        (admission.forwards(parent) || consumer.forwards(parent))
      )
        return;
      if (ts.isCallExpression(parent) && parent.expression === node) {
        if (kind !== "moved") creations.push([parent, admission.around(node)]);
        else if (!inAdmissionCode(node)) {
          const derivation = derivationIn(admission, symbol);
          if (derivation === undefined)
            report(
              node,
              `Unproved: Admission.${name} is called but is no derivation the inventory can name: make it one.`,
            );
          else admissionCalls.push([parent, derivation, consumer.around(node)]);
        }
        return;
      }
      unproved(node, entry, "a value");
      return;
    }
    if (inAdmissionCode(node) && kind === "admission" && name !== "readChecks") return;
    unproved(node, entry, "a reference");
  };
  for (const sourceFile of scopeFiles) {
    const visit = (node) => {
      // (a class's `extends` expression is a value, its type arguments types, Codex r7 B1; every other type node is a type
      // position: an annotation, a type argument, an interface's or an `implements` heritage)
      if (
        ts.isExpressionWithTypeArguments(node) &&
        ts.isHeritageClause(node.parent) &&
        node.parent.token === ts.SyntaxKind.ExtendsKeyword &&
        ts.isClassLike(node.parent.parent)
      ) {
        visit(node.expression);
        return;
      }
      if (ts.isTypeNode(node)) return;
      for (const [at, entry, symbol] of namedBy(node)) classify(at, entry, symbol, sourceFile);
      node.forEachChild(visit);
    };
    visit(sourceFile);
  }

  // 1. an Admission derivation that creates an obligation itself must be listed; a creation outside every derivation
  // is unproved
  const direct = new Map();
  for (const [call, around] of creations) {
    const derivation = around === undefined ? undefined : admission.of(around);
    if (derivation === undefined) {
      report(
        call,
        "An obligation is created outside every derivation of admission's: move it into one the inventory can name.",
      );
      continue;
    }
    const name = nameOf(derivation);
    if (direct.has(name)) continue;
    direct.set(name, derivation);
    if (!entries.has(name))
      report(derivation, `Admission.${name} creates an obligation; list it in OBLIGATION_SITES.`);
  }
  // (a listed read creates none directly)
  for (const name of files.reads.keys())
    if (direct.has(name))
      report(direct.get(name), `Admission.${name} creates an obligation; it is no read.`);

  // 2. the consumer derivations that create an obligation: those that record a diagnostic or a check, and, through
  // direct calls, their callers and the consumer derivations they call
  const creating = new Set();
  for (const [push, around] of recordings)
    if (around === undefined)
      report(
        push,
        "Unproved: a diagnostic or a check is recorded outside every consumer derivation: record it in one.",
      );
    else creating.add(consumer.of(around));
  // (a consumer derivation's direct calls of others, and its dot reads of a getter, which run it)
  const directCalls = (derivation) => {
    const out = consumer
      .callsIn(derivation)
      .map((call) => derivationIn(consumer, directCallee(call)))
      .filter((callee) => callee !== undefined);
    for (const declaration of consumer.nodesIn(derivation)) {
      const visit = (node) => {
        if (ts.isPropertyAccessExpression(node) && reads(node)) {
          // (a getter's read, its pair found by symbol whatever the order of its declarations, Codex r6 B3)
          const read = symbolOf(node.name);
          if (declarationsOf(read).some((at) => ts.isGetAccessorDeclaration(at))) {
            const getter = derivationIn(consumer, read);
            if (getter !== undefined) out.push(getter);
          }
        }
        node.forEachChild(visit);
      };
      visit(declaration);
    }
    return out;
  };
  for (let grown = true; grown;) {
    grown = false;
    for (const derivation of consumer.derivations)
      if (
        !creating.has(derivation) &&
        directCalls(derivation).some((callee) => creating.has(callee))
      ) {
        creating.add(derivation);
        grown = true;
      }
  }
  for (let grown = true; grown;) {
    grown = false;
    for (const derivation of [...creating])
      for (const callee of directCalls(derivation))
        if (!creating.has(callee)) {
          creating.add(callee);
          grown = true;
        }
  }
  const asked = new Set(readsAsked);
  for (const [call, derivation, around] of admissionCalls) {
    const from = around === undefined ? undefined : consumer.of(around);
    const name = nameOf(derivation);
    // (outside admission and every consumer derivation, only a listed read is called, Codex r4)
    if (from === undefined && !files.reads.has(name) && !listed(name, "call", call.getSourceFile()))
      report(
        call,
        `Unproved: Admission.${name} is called outside every consumer derivation: call it from one the inventory can weigh.`,
      );
    if (from === undefined || !creating.has(from)) continue;
    asked.add(name);
    if (!entries.has(name) && !files.reads.has(name))
      report(
        call,
        `Consumers.${nameOf(from)} calls Admission.${name}: list it in OBLIGATION_SITES or as a read with why it creates no obligation.`,
      );
  }

  // (a listed read the consumers no longer ask is stale)
  for (const name of files.reads.keys())
    if (!asked.has(name))
      report(admissionClass, `READS lists Admission.${name}, which no consumer method asks.`);

  // 3. the fresh pass calls each listed derivation: the one derivation `runs` names across admission and the
  // consumers, by identity, a direct call
  const freshes = [...consumer.namedAll("#freshStores"), ...consumer.namedAll("freshStores")];
  if (freshes.length !== 1)
    report(consumersClass, `The fresh pass is ${freshes.length} derivations: it must be one.`);
  const fresh = freshes.length === 1 ? freshes[0] : undefined;
  const called = new Set(
    fresh === undefined
      ? []
      : consumer
          .callsIn(fresh)
          .map(directCallee)
          .flatMap((symbol) => [derivationIn(consumer, symbol), derivationIn(admission, symbol)])
          .filter((derivation) => derivation !== undefined),
  );
  for (const [method, { node, runs }] of entries) {
    if (runs === null || runs === "the walk") continue;
    const candidates = [...consumer.namedAll(runs), ...admission.namedAll(runs)];
    if (candidates.length !== 1)
      report(
        node,
        `OBLIGATION_SITES lists ${runs} for ${method}, which names ${candidates.length} derivations across admission and the consumers: it must name one.`,
      );
    else if (!called.has(candidates[0]))
      report(
        node,
        `The fresh pass does not call ${runs}, which OBLIGATION_SITES lists for ${method}.`,
      );
  }

  // 4. every host member is a listed host read, and every listed one a member: the members of its type, inherited ones
  // included (Codex r24 T1)
  const host = declarationIn(
    admissionFiles,
    (node) => ts.isInterfaceDeclaration(node) && node.name.text === "AdmissionHost",
    "interface AdmissionHost",
  );
  const members = new Set();
  for (const member of checker.getTypeAtLocation(host).getProperties()) {
    const name = member.getName();
    members.add(name);
    if (!files.hostReads.has(name))
      report(
        member.declarations?.[0] ?? host,
        `AdmissionHost.${name} is no listed host read: list it with why it creates no obligation, or return what it decides to the consumers.`,
      );
  }
  for (const name of files.hostReads.keys())
    if (!members.has(name))
      report(host, `HOST_READS lists AdmissionHost.${name}, which the interface does not have.`);
  return diagnostics;
}
