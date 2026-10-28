import { existsSync, readdirSync } from "node:fs";
import { relative, resolve, sep } from "node:path";
import { Project, ts } from "ts-morph";

/**
 * The derivation inventory's guard (TABLE r4.138, r4.143), read from the syntax tree with its types. `OBLIGATION_SITES`
 * lists every derivation of admission's that creates an obligation; a stop before admission settled runs each in the
 * fresh pass. What a derivation of `Admission`'s or `Consumers`' is, is decided in one place, `derivationsOf`: a member
 * of the class with a body (a method, a getter and setter pair as one, a property holding a function), or a function of
 * the class's files (the entry, and the parts in the folder beside it) with a parameter whose type is the class or
 * names it (a union, an intersection, a type parameter's constraint), declared or held by a variable. A public method
 * that only forwards to the function of its name (`return f(this, a, b);` or `f(this, a, b);`, its own parameters in
 * order, none with an initializer, no decorator or other modifier) is that function. Wrappers that change nothing
 * (parentheses, `satisfies`, `as`, `!`) and a member's static name (quoted, or a computed literal) are seen through;
 * anything else the model has not shown is reported as unproved rather than exempted. The check rejects:
 * - a name that names more than one derivation, and a member holding a function under no static name;
 * - an `Admission` derivation that creates an obligation itself (a `boundaryCheck(…)` call, a push onto `readChecks`, a
 *   call of a parameter named `error`) and is not an inventory entry, and such a creation outside every derivation;
 * - a call from a consumer derivation that creates an obligation (one that records a diagnostic or a check through the
 *   instance, or calls one that does) into an `Admission` derivation, through the instance, directly, through an
 *   alias, `call` or `apply`, that is neither an inventory entry nor a read `READS` lists with why it creates none; and
 *   from such a consumer derivation, a call into the admission files that reaches no derivation, a call on the
 *   `Admission` instance the check cannot resolve, and a derivation of admission's read as a value; and any such call,
 *   or one handing the instance on, outside every consumer derivation;
 * - an inventory entry whose `runs` names no derivation, or one the fresh pass does not call;
 * - an `AdmissionHost` member, inherited ones included, that is not a host read `HOST_READS` lists with why it creates
 *   no obligation (a derivation returns what it leaves open to the consumers, which record it), so no new callback
 *   records one for admission whatever its wiring (Codex r23, r24 T1).
 * A listed host read is trusted by its reason, as a listed read is: a side effect inside `read` or `run` that records an
 * obligation is a review matter against that reason, not this check's (TABLE r4.152 (3)). Data flow past these forms (a
 * function value passed on and called elsewhere) is outside a syntactic guard (TABLE r4.165), a review matter.
 */
const ADMISSION = "src/type-inference/core/admission.ts";
const CONSUMERS = "src/type-inference/core/consumers.ts";

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
  ["decisionStopped", "whether a key's decision stopped at its demand allowance: a test"],
  ["groups", "the places and paths `decide` decides: its inputs"],
  ["ingressSiteOf", "C1's site for external data a store brings: a site, read"],
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

export function checkObligationInventory(root) {
  const project = new Project({
    tsConfigFilePath: resolve(root, "tsconfig.json"),
    skipAddingFilesFromTsConfig: true,
  });
  const admission = admissionFiles(root);
  const consumers = consumersFiles(root);
  for (const file of [...admission, ...consumers]) project.addSourceFileAtPath(resolve(root, file));
  project.resolveSourceFileDependencies();
  return obligationInventoryDiagnostics(project.getProgram().compilerObject, root, {
    admission,
    consumers,
    reads: READS,
    hostReads: HOST_READS,
  });
}

/**
 * @param {ts.Program} program
 * @param {string} root
 * @param {{ admission: readonly string[], consumers: readonly string[], reads: ReadonlyMap<string, string>, hostReads: ReadonlyMap<string, string> }} files
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

  // (wrappers that change nothing: parentheses, `satisfies`, `as`, a type assertion, `!`)
  const unwrap = (node) => {
    while (
      node !== undefined &&
      (ts.isParenthesizedExpression(node) ||
        ts.isSatisfiesExpression(node) ||
        ts.isAsExpression(node) ||
        ts.isTypeAssertionExpression(node) ||
        ts.isNonNullExpression(node))
    )
      node = node.expression;
    return node;
  };
  // a declaration's static name: an identifier's or a private name's, a quoted one, or a computed literal; else null
  const nameOf = (declaration) => {
    const name = declaration.name;
    if (name === undefined) return ts.isConstructorDeclaration(declaration) ? "constructor" : null;
    if (ts.isIdentifier(name) || ts.isPrivateIdentifier(name) || ts.isStringLiteralLike(name))
      return name.text;
    if (ts.isNumericLiteral(name)) return name.text;
    if (ts.isComputedPropertyName(name)) {
      const key = unwrap(name.expression);
      return key !== undefined && (ts.isStringLiteralLike(key) || ts.isNumericLiteral(key))
        ? key.text
        : null;
    }
    return null;
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
      const value = unwrap(declaration.initializer);
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
  const typedAs = (node, cls) => mentions(checker.getTypeAtLocation(node), cls);

  /**
   * A class's derivations, each by its declaration (Codex r1 B1, r2 B1, B2, r3 B1, N1): a member of the class with a
   * body (a method, a getter and setter pair as one, a property holding a function), or a function of its files with a
   * parameter typed as the class, declared or held by a variable. A public method that only forwards to such a function
   * of its name is that function. Anything not shown so is a derivation of its own; every name names one derivation.
   */
  const derivationsOf = (cls, sourceFiles, label) => {
    const declarations = [];
    for (const member of cls.members)
      if (functionOf(member) !== undefined) {
        if (nameOf(member) === null)
          report(
            member,
            `${label} holds a function under no static name: name it so the inventory can.`,
          );
        else declarations.push(member);
      }
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
    // the declaration a name or member access resolves to, followed through an alias
    const declarationAt = (node) => {
      // (an element access names a member only by a literal key)
      if (ts.isElementAccessExpression(node)) {
        const key = unwrap(node.argumentExpression);
        if (!ts.isStringLiteralLike(key) && !ts.isNumericLiteral(key)) return [];
      }
      let symbol = checker.getSymbolAtLocation(
        ts.isPropertyAccessExpression(node)
          ? node.name
          : ts.isElementAccessExpression(node)
            ? unwrap(node.argumentExpression)
            : node,
      );
      if (symbol !== undefined && symbol.flags & ts.SymbolFlags.Alias)
        symbol = checker.getAliasedSymbol(symbol);
      return symbol?.declarations ?? [];
    };
    const forwardsTo = (member) => {
      if (
        !ts.isMethodDeclaration(member) ||
        member.parent !== cls ||
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
      const fn = declarationAt(call.expression).find((declaration) => known.has(declaration));
      const first = fn === undefined ? undefined : functionOf(fn)?.parameters[0];
      return fn !== undefined &&
        fn.parent !== cls &&
        nameOf(fn) === nameOf(member) &&
        first !== undefined &&
        typedAs(first, cls)
        ? fn
        : undefined;
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
    // the derivation a declaration is part of, its identity
    const derivationOfDeclarations = (found) => {
      const declaration = found.find((candidate) => known.has(candidate));
      return declaration === undefined ? undefined : identity.get(declaration);
    };
    return {
      derivations: [...parts.keys()],
      // the derivation of each name, `undefined` for none or several
      named: (name) => (byName.get(name)?.length === 1 ? byName.get(name)[0] : undefined),
      // whether a node lies inside one of a derivation's declarations
      within: (node) => {
        for (let at = node; at !== undefined; at = at.parent) if (known.has(at)) return true;
        return false;
      },
      // the calls in a derivation's every declaration, a setter's beside its getter's
      callsIn: (derivation) => parts.get(derivation).flatMap((declaration) => calls(declaration)),
      nodesIn: (derivation) => parts.get(derivation),
      parametersOf: (derivation) =>
        parts.get(derivation).flatMap((declaration) => [...functionOf(declaration).parameters]),
      // the derivation a callee reaches: through the instance or directly, through an alias, a quoted member, `call` or
      // `apply`, wrappers seen through
      calleeOf: (callee) => {
        let target = unwrap(callee);
        if (
          ts.isPropertyAccessExpression(target) &&
          ["call", "apply"].includes(target.name.text) &&
          derivationOfDeclarations(declarationAt(unwrap(target.expression))) !== undefined
        )
          target = unwrap(target.expression);
        return derivationOfDeclarations(declarationAt(target));
      },
      // the derivation a name or member access denotes, wherever it stands
      denoted: (node) => derivationOfDeclarations(declarationAt(node)),
      declarationsAt: declarationAt,
    };
  };

  const admission = derivationsOf(admissionClass, admissionFiles, "Admission");
  const consumer = derivationsOf(consumersClass, consumerFiles, "Consumers");

  // the inventory: OBLIGATION_SITES' entries, by their method and the derivation the fresh pass runs
  const entries = new Map();
  for (const sourceFile of admissionFiles)
    sourceFile.forEachChild((node) => {
      if (!ts.isVariableStatement(node)) return;
      for (const declaration of node.declarationList.declarations) {
        if (declaration.name.getText() !== "OBLIGATION_SITES") continue;
        let list = unwrap(declaration.initializer);
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

  // 1. an obligation created: a `boundaryCheck(…)` call, a push onto `readChecks`, a call of a parameter named `error`
  const creates = (call) => {
    const callee = unwrap(call.expression);
    if (ts.isIdentifier(callee))
      return (
        callee.text === "boundaryCheck" ||
        admission
          .declarationsAt(callee)
          .some((declaration) => ts.isParameter(declaration) && nameOf(declaration) === "error")
      );
    return (
      ts.isPropertyAccessExpression(callee) &&
      callee.name.text === "push" &&
      ts.isPropertyAccessExpression(unwrap(callee.expression)) &&
      unwrap(callee.expression).name.text === "readChecks"
    );
  };
  const direct = new Map();
  for (const derivation of admission.derivations) {
    const name = nameOf(derivation);
    if (!admission.callsIn(derivation).some(creates)) continue;
    direct.set(name, derivation);
    if (!entries.has(name))
      report(derivation, `Admission.${name} creates an obligation; list it in OBLIGATION_SITES.`);
  }
  // (and outside every derivation: unproved, so no form is exempt)
  for (const sourceFile of admissionFiles)
    for (const call of calls(sourceFile))
      if (creates(call) && !admission.within(call))
        report(
          call,
          "An obligation is created outside every derivation of admission's: move it into one the inventory can name.",
        );

  // (a listed read creates none directly)
  for (const name of files.reads.keys())
    if (direct.has(name))
      report(direct.get(name), `Admission.${name} creates an obligation; it is no read.`);

  // 2. the consumer derivations that create an obligation: those that record a diagnostic or a check through the
  // instance (`this`, a parameter or any alias of it typed as the class, or those fields destructured from it), and
  // their callers
  const RECORDS = ["diagnostics", "deferred", "checks"];
  const consumersTyped = (node) => node !== undefined && typedAs(node, consumersClass);
  const recordsHere = (derivation) =>
    consumer.nodesIn(derivation).some((declaration) => {
      let found = false;
      const visit = (node) => {
        if (found) return;
        if (ts.isCallExpression(node)) {
          const callee = unwrap(node.expression);
          if (ts.isPropertyAccessExpression(callee) && callee.name.text === "push") {
            const targets = [];
            const collect = (target) => {
              target = unwrap(target);
              if (ts.isConditionalExpression(target)) {
                collect(target.whenTrue);
                collect(target.whenFalse);
              } else targets.push(target);
            };
            collect(callee.expression);
            if (
              targets.some(
                (target) =>
                  ts.isPropertyAccessExpression(target) &&
                  RECORDS.includes(target.name.text) &&
                  consumersTyped(target.expression),
              )
            )
              found = true;
          }
        } else if (
          ts.isVariableDeclaration(node) &&
          ts.isObjectBindingPattern(node.name) &&
          consumersTyped(node.initializer) &&
          node.name.elements.some((element) =>
            RECORDS.includes((element.propertyName ?? element.name).getText()),
          )
        )
          found = true;
        node.forEachChild(visit);
      };
      visit(declaration);
      return found;
    });
  const creating = new Set(consumer.derivations.filter(recordsHere));
  for (let grown = true; grown;) {
    grown = false;
    for (const derivation of consumer.derivations)
      if (
        !creating.has(derivation) &&
        consumer
          .callsIn(derivation)
          .some((call) => creating.has(consumer.calleeOf(call.expression)))
      ) {
        creating.add(derivation);
        grown = true;
      }
  }
  // (and the consumer derivations those call, whatever records the obligation: `#decide` asks admission's decision)
  for (let grown = true; grown;) {
    grown = false;
    for (const derivation of [...creating])
      for (const call of consumer.callsIn(derivation)) {
        const callee = consumer.calleeOf(call.expression);
        if (callee !== undefined && !creating.has(callee)) {
          creating.add(callee);
          grown = true;
        }
      }
  }
  const admissionTyped = (node) => node !== undefined && typedAs(node, admissionClass);
  const asked = new Set();
  for (const derivation of creating) {
    const label = `Consumers.${nameOf(derivation)}`;
    for (const declaration of consumer.nodesIn(derivation)) {
      const visit = (node) => {
        if (ts.isCallExpression(node)) {
          const reached = admission.calleeOf(node.expression);
          const callee = unwrap(node.expression);
          if (reached !== undefined) {
            const name = nameOf(reached);
            asked.add(name);
            if (!entries.has(name) && !files.reads.has(name))
              report(
                node,
                `${label} calls Admission.${name}: list it in OBLIGATION_SITES or as a read with why it creates no obligation.`,
              );
          } else if (
            consumer.calleeOf(node.expression) === undefined &&
            node.arguments.some((argument) => admissionTyped(argument))
          )
            report(
              node,
              `${label} hands the Admission instance to a call the inventory cannot follow: call admission's derivation itself.`,
            );
          else if (
            (ts.isPropertyAccessExpression(callee) || ts.isElementAccessExpression(callee)) &&
            admissionTyped(callee.expression) &&
            admission.declarationsAt(callee).length === 0
          )
            report(
              node,
              `${label} calls the Admission instance in a way the inventory cannot resolve.`,
            );
        } else if (
          (ts.isIdentifier(node) || ts.isPropertyAccessExpression(node)) &&
          !(ts.isPropertyAccessExpression(node.parent) && node.parent.name === node) &&
          admission.denoted(node) !== undefined
        ) {
          // a derivation of admission's read as a value: called elsewhere, it escapes the inventory
          let outer = node;
          while (
            outer.parent !== undefined &&
            unwrap(outer.parent) === unwrap(node) &&
            outer.parent !== node
          )
            outer = outer.parent;
          const use = outer.parent;
          const called =
            (ts.isCallExpression(use) && use.expression === outer) ||
            (ts.isPropertyAccessExpression(use) &&
              use.expression === outer &&
              ["call", "apply"].includes(use.name.text) &&
              ts.isCallExpression(use.parent) &&
              use.parent.expression === use) ||
            ts.isImportSpecifier(use) ||
            ts.isExportSpecifier(use);
          if (!called)
            report(
              node,
              `${label} reads Admission.${nameOf(admission.denoted(node))} as a value: call it so the inventory can see the call.`,
            );
        } else if (
          ts.isBindingElement(node) &&
          ts.isObjectBindingPattern(node.parent) &&
          admissionTyped(node.parent.parent.initializer) &&
          admission.named((node.propertyName ?? node.name).getText()) !== undefined
        )
          report(
            node,
            `${label} reads Admission.${(node.propertyName ?? node.name).getText()} as a value: call it so the inventory can see the call.`,
          );
        node.forEachChild(visit);
      };
      visit(declaration);
    }
  }

  // (and outside every consumer derivation: a call into admission's derivations, or handing or calling the instance,
  // is unproved, so no form is exempt)
  for (const sourceFile of consumerFiles)
    for (const call of calls(sourceFile)) {
      if (consumer.within(call)) continue;
      const callee = unwrap(call.expression);
      if (
        admission.calleeOf(call.expression) !== undefined ||
        call.arguments.some((argument) => admissionTyped(argument)) ||
        ((ts.isPropertyAccessExpression(callee) || ts.isElementAccessExpression(callee)) &&
          admissionTyped(callee.expression))
      )
        report(
          call,
          "An Admission call is made outside every consumer derivation: make it in one the inventory can weigh.",
        );
    }

  // (a listed read the consumers no longer ask is stale)
  for (const name of files.reads.keys())
    if (!asked.has(name))
      report(admissionClass, `READS lists Admission.${name}, which no consumer method asks.`);

  // 3. the fresh pass calls each listed derivation: the one `runs` names, by identity, through the instance or directly
  const fresh = consumer.named("#freshStores") ?? consumer.named("freshStores");
  const called = new Set(
    fresh === undefined
      ? []
      : consumer
          .callsIn(fresh)
          .flatMap((call) => [
            consumer.calleeOf(call.expression),
            admission.calleeOf(call.expression),
          ])
          .filter((derivation) => derivation !== undefined),
  );
  for (const [method, { node, runs }] of entries) {
    if (runs === null || runs === "the walk") continue;
    const runsDerivation = consumer.named(runs) ?? admission.named(runs);
    if (runsDerivation === undefined)
      report(node, `OBLIGATION_SITES lists ${runs} for ${method}, which names no one derivation.`);
    else if (!called.has(runsDerivation))
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
