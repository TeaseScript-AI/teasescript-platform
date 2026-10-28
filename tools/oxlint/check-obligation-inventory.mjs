import { relative, resolve, sep } from "node:path";
import { Project, ts } from "ts-morph";

/**
 * The derivation inventory's guard (TABLE r4.138, r4.143), read from the syntax tree with its types. `OBLIGATION_SITES`
 * (admission.ts) lists every derivation of admission's that creates an obligation; a stop before admission settled runs
 * each in the fresh pass. The check rejects:
 * - an `Admission` method that creates an obligation itself (a `boundaryCheck(…)` call, a push onto its `readChecks`, a
 *   call of a parameter named `error`) and is not an inventory entry;
 * - a call from a consumer method that creates an obligation (one that records a diagnostic or a check, or calls one
 *   that does, within `Consumers`) into an `Admission` method that is neither an inventory entry nor a read `READS`
 *   lists with why it creates none;
 * - an inventory entry whose `runs` names a derivation `Consumers.#freshStores` does not call;
 * - an `AdmissionHost` member, inherited ones included, that is not a host read `HOST_READS` lists with why it creates
 *   no obligation (a derivation returns what it leaves open to the consumers, which record it), so no new callback
 *   records one for admission whatever its wiring (Codex r23, r24 T1).
 * A listed host read is trusted by its reason, as a listed read is: a side effect inside `read` or `run` that records an
 * obligation is a review matter against that reason, not this check's (TABLE r4.152 (3)).
 * A commented-out call is no call, and a new method is caught whatever its name.
 */
const ADMISSION = "src/type-inference/core/admission.ts";
const CONSUMERS = "src/type-inference/core/consumers.ts";

/** The `Admission` methods those consumer methods call that create no obligation, each with why. */
export const READS = new Map([
  ["admitted", "the admitted type at a path: a decision's answer, recorded by `decide`"],
  ["atCopy", "whether A2 found copies meeting at a path: where the error goes, a test"],
  ["boundariesAt", "`boundaryFor` for each item: the obligation is that entry's"],
  ["boundaryAt", "records a store whose boundary `publish` forms: the obligation is that entry's"],
  ["cellSited", "C9's site for an item a store brings: a site, read"],
  ["compareLanded", "the member-answer oracle's comparison, a test seam inert outside it"],
  ["contributionSited", "C1's site for an item an add brings: a site, read"],
  ["groups", "the places and paths `decide` decides: its inputs"],
  ["ingressSiteOf", "C1's site for external data a store brings: a site, read"],
  ["literalChildren", "a literal's children at a step: syntax"],
  ["namedExternalSite", "where a store's named external data enters: a site, read"],
  ["offendingAt", "the innermost offending expression of a contribution: a site, read"],
  ["ownIngress", "whether an item is the store's own ingress: a test"],
  ["ownReadItem", "whether external data is an operation's own read's alone: a test"],
  [
    "readsStoppedDecision",
    "whether a read reaches a key whose decision stopped at its demand allowance: a test",
  ],
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
  for (const file of [ADMISSION, CONSUMERS]) project.addSourceFileAtPath(resolve(root, file));
  project.resolveSourceFileDependencies();
  return obligationInventoryDiagnostics(project.getProgram().compilerObject, root, {
    admission: ADMISSION,
    consumers: CONSUMERS,
    reads: READS,
    hostReads: HOST_READS,
  });
}

/**
 * @param {ts.Program} program
 * @param {string} root
 * @param {{ admission: string, consumers: string, reads: ReadonlyMap<string, string>, hostReads: ReadonlyMap<string, string> }} files
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
  const classOf = (sourceFile, name) => {
    let found = null;
    sourceFile.forEachChild((node) => {
      if (ts.isClassDeclaration(node) && node.name?.text === name) found = node;
    });
    if (found === null) throw new Error(`No class ${name} in ${sourceFile.fileName}.`);
    return found;
  };
  const interfaceOf = (sourceFile, name) => {
    let found = null;
    sourceFile.forEachChild((node) => {
      if (ts.isInterfaceDeclaration(node) && node.name.text === name) found = node;
    });
    if (found === null) throw new Error(`No interface ${name} in ${sourceFile.fileName}.`);
    return found;
  };
  const nameOf = (member) =>
    member.name === undefined
      ? null
      : ts.isPrivateIdentifier(member.name) || ts.isIdentifier(member.name)
        ? member.name.text
        : null;
  const methodsOf = (declaration) => {
    const out = new Map();
    for (const member of declaration.members)
      if (
        (ts.isMethodDeclaration(member) || ts.isGetAccessorDeclaration(member)) &&
        member.body !== undefined &&
        nameOf(member) !== null
      )
        out.set(nameOf(member), member);
    return out;
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
  const admissionFile = sourceOf(files.admission);
  const admission = classOf(admissionFile, "Admission");
  const consumers = classOf(sourceOf(files.consumers), "Consumers");
  const admissionMethods = methodsOf(admission);
  const consumerMethods = methodsOf(consumers);

  // the inventory: OBLIGATION_SITES' entries, by their method and the derivation the fresh pass runs
  const entries = new Map();
  admissionFile.forEachChild((node) => {
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
  if (entries.size === 0) report(admission, "OBLIGATION_SITES lists no derivation.");

  // the Admission method a call reaches, `null` for any other callee
  const admissionCallee = (call) => {
    const symbol = checker.getSymbolAtLocation(
      ts.isPropertyAccessExpression(call.expression) ? call.expression.name : call.expression,
    );
    const declaration = symbol?.declarations?.[0];
    return declaration !== undefined &&
      declaration.parent === admission &&
      ts.isMethodDeclaration(declaration)
      ? nameOf(declaration)
      : null;
  };

  // 1. an Admission method that creates an obligation itself
  const direct = new Set();
  for (const [name, method] of admissionMethods) {
    const errorParameters = new Set();
    for (const parameter of method.parameters)
      if (ts.isIdentifier(parameter.name) && parameter.name.text === "error")
        errorParameters.add(parameter.name.text);
    const creates = calls(method).some((call) => {
      const callee = call.expression;
      if (ts.isIdentifier(callee))
        return callee.text === "boundaryCheck" || errorParameters.has(callee.text);
      return (
        ts.isPropertyAccessExpression(callee) &&
        callee.name.text === "push" &&
        ts.isPropertyAccessExpression(callee.expression) &&
        callee.expression.name.text === "readChecks"
      );
    });
    if (creates) direct.add(name);
    if (creates && !entries.has(name))
      report(method, `Admission.${name} creates an obligation; list it in OBLIGATION_SITES.`);
  }

  // (a listed read creates none directly)
  for (const name of files.reads.keys())
    if (direct.has(name))
      report(admissionMethods.get(name), `Admission.${name} creates an obligation; it is no read.`);

  // 2. the consumer methods that create an obligation: those that record a diagnostic or a check, and their callers
  const recordsHere = (method) =>
    calls(method).some((call) => {
      const callee = call.expression;
      if (!ts.isPropertyAccessExpression(callee) || callee.name.text !== "push") return false;
      const target = callee.expression;
      const fields = [];
      const collect = (node) => {
        if (ts.isParenthesizedExpression(node)) collect(node.expression);
        else if (ts.isConditionalExpression(node)) {
          collect(node.whenTrue);
          collect(node.whenFalse);
        } else if (
          ts.isPropertyAccessExpression(node) &&
          node.expression.kind === ts.SyntaxKind.ThisKeyword
        )
          fields.push(node.name.text);
      };
      collect(target);
      return fields.some((field) => ["diagnostics", "deferred", "checks"].includes(field));
    });
  const creating = new Set(
    [...consumerMethods].filter(([, method]) => recordsHere(method)).map(([name]) => name),
  );
  for (let grown = true; grown;) {
    grown = false;
    for (const [name, method] of consumerMethods) {
      if (creating.has(name)) continue;
      const reaches = calls(method).some((call) => {
        const callee = call.expression;
        return (
          ts.isPropertyAccessExpression(callee) &&
          callee.expression.kind === ts.SyntaxKind.ThisKeyword &&
          creating.has(callee.name.text)
        );
      });
      if (reaches) {
        creating.add(name);
        grown = true;
      }
    }
  }
  // (and the consumer methods those call, whatever records the obligation: `#decide` asks admission's decision)
  for (let grown = true; grown;) {
    grown = false;
    for (const name of [...creating])
      for (const call of calls(consumerMethods.get(name))) {
        const callee = call.expression;
        if (
          ts.isPropertyAccessExpression(callee) &&
          callee.expression.kind === ts.SyntaxKind.ThisKeyword &&
          consumerMethods.has(callee.name.text) &&
          !creating.has(callee.name.text)
        ) {
          creating.add(callee.name.text);
          grown = true;
        }
      }
  }
  const asked = new Set();
  for (const name of creating)
    for (const call of calls(consumerMethods.get(name))) {
      const callee = admissionCallee(call);
      if (callee !== null) asked.add(callee);
      if (callee !== null && !entries.has(callee) && !files.reads.has(callee))
        report(
          call,
          `Consumers.${name} calls Admission.${callee}: list it in OBLIGATION_SITES or as a read with why it creates no obligation.`,
        );
    }

  // (a listed read the consumers no longer ask is stale)
  for (const name of files.reads.keys())
    if (!asked.has(name))
      report(admission, `READS lists Admission.${name}, which no consumer method asks.`);

  // 3. the fresh pass calls each listed derivation
  const fresh = consumerMethods.get("#freshStores");
  const called = new Set(
    fresh === undefined
      ? []
      : calls(fresh).flatMap((call) =>
          ts.isPropertyAccessExpression(call.expression) ? [call.expression.name.text] : [],
        ),
  );
  for (const [method, { node, runs }] of entries)
    if (runs !== null && runs !== "the walk" && !called.has(runs))
      report(
        node,
        `The fresh pass does not call ${runs}, which OBLIGATION_SITES lists for ${method}.`,
      );

  // 4. every host member is a listed host read, and every listed one a member: the members of its type, inherited ones
  // included (Codex r24 T1)
  const host = interfaceOf(admissionFile, "AdmissionHost");
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
