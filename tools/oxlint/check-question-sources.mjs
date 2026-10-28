import { globSync, readFileSync } from "node:fs";
import { resolve, sep } from "node:path";
import { ts } from "ts-morph";

/**
 * The question API's one source endpoint (TABLE r4.158; this check's scope, r4.165), read from the syntax alone:
 * `CoreAnswers.#items` answers every question's items, direct or composed, so in `src/type-inference/core/` the two
 * sources it alone reads after a stop, the finishing read's domains (`Consumers.finishedItems`) and the place's lazily
 * decided type (`#lazilyDecided`), are named only inside `#items`, and the finishing read itself
 * (`Consumers.#finishingRead`) only inside `finishedItems` and the consumers' own reads `FINISHING_READERS` lists, each
 * trusted by its reason, as the inventory check's host reads are (r4.152 (3)). Every reference by name counts: a call, a
 * property access, an alias, a destructured or quoted name. `#items` names both sources and `finishedItems` the
 * finishing read. A reference the syntax does not name (an inherited member reached through an inferred wrapper, a
 * generic receiver, a computed name) is outside this check, a review matter against r4.158 (r4.165).
 *
 * A class's members, for this check, are its own and the functions whose first parameter's type names the class: a
 * method whose body moved to a function in the class's folder (#1071). Names compare without `#`, so a member and the
 * function it moved to are one name. A public method that only forwards to the function of its name (`return f(this,
 * …)` or `f(this, …);`, its own parameters in order, none with an initializer, no decorator or other modifier) is that
 * function: its call names no reference. Neither does an import under the name's own name, whose uses are checked.
 * A site this check allows is one declaration: two members of one class and name there, but such a forwarder and its
 * function or a getter and its setter, are reported, so no other declaration takes the site's place.
 */
const CORE = "src/type-inference/core";

/** Each guarded name: the class declaring it, the class and member it may be named in, and where that is. */
const OWNERS = new Map([
  [
    "finishedItems",
    { declaredIn: "Consumers", owner: "CoreAnswers", member: "items", where: "CoreAnswers.#items" },
  ],
  [
    "lazilyDecided",
    {
      declaredIn: "CoreAnswers",
      owner: "CoreAnswers",
      member: "items",
      where: "CoreAnswers.#items",
    },
  ],
  [
    "finishingRead",
    {
      declaredIn: "Consumers",
      owner: "Consumers",
      member: "finishedItems",
      where: "Consumers.finishedItems and the reads FINISHING_READERS lists",
    },
  ],
]);

/** The consumers' own reads that name the finishing read beside `finishedItems`, each with why it is no question's. */
export const FINISHING_READERS = new Map([
  [
    "constructor",
    "admission's host read after a stop (`AdmissionHost.read`, the inventory check's `HOST_READS`)",
  ],
  ["valueItems", "every consumer's one read, unstopped or finishing (TABLE r4.99)"],
  ["finishingRead", "its own descent into a literal's children"],
  ["typedRead", "a typed default's domain, read where its own answer is missing (TABLE r4.144)"],
]);

export function checkQuestionSources(root) {
  const sources = globSync(`${CORE}/**/*.ts`, { cwd: root })
    .map((file) => file.split(sep).join("/"))
    .sort()
    .map((file) => ({ file, text: readFileSync(resolve(root, file), "utf8") }));
  return questionSourceDiagnostics(sources, FINISHING_READERS);
}

/** A name without its `#`: a member and the function its body moved to are one name. */
const bare = (name) => name.replace(/^#/, "");

/**
 * @param {readonly { file: string, text: string }[]} sources
 * @param {ReadonlyMap<string, string>} readers
 * @returns {{ fileName: string, line: number, column: number, message: string }[]}
 */
export function questionSourceDiagnostics(sources, readers) {
  const diagnostics = [];
  const parsed = sources.map(({ file, text }) => ({
    file,
    sourceFile: ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true),
  }));
  const reportIn = (file, sourceFile, node, message) => {
    const location = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
    diagnostics.push({
      fileName: file,
      line: location.line + 1,
      column: location.character + 1,
      message,
    });
  };
  const nameText = (name) =>
    name !== undefined &&
    (ts.isIdentifier(name) || ts.isPrivateIdentifier(name) || ts.isStringLiteralLike(name))
      ? name.text
      : null;
  // a top-level function's owner: the class its first parameter's type names, else null
  const functionOwner = (fn) => {
    const type = fn.parameters[0]?.type;
    return type !== undefined && ts.isTypeReferenceNode(type) && ts.isIdentifier(type.typeName)
      ? type.typeName.text
      : null;
  };
  // the member a node lies in, the innermost, with its class (a class's member, or a function the class owns)
  const memberOf = (node, sourceFile) => {
    let member = node;
    while (
      member.parent !== undefined &&
      !ts.isClassLike(member.parent) &&
      !(ts.isFunctionDeclaration(member) && member.parent === sourceFile)
    )
      member = member.parent;
    const owner = ts.isClassLike(member.parent ?? member)
      ? (member.parent?.name?.text ?? null)
      : ts.isFunctionDeclaration(member)
        ? functionOwner(member)
        : null;
    const name = ts.isConstructorDeclaration(member) ? "constructor" : nameText(member.name);
    return { member, owner, name: name === null ? null : bare(name) };
  };

  // every member with a body, by its class and bare name
  const members = new Map();
  const addMember = (owner, name, declaration, file, sourceFile) => {
    if (owner === null || name === null) return;
    const key = `${owner} ${bare(name)}`;
    members.set(key, [...(members.get(key) ?? []), { declaration, file, sourceFile }]);
  };
  for (const { file, sourceFile } of parsed)
    sourceFile.forEachChild((node) => {
      if (ts.isClassDeclaration(node) && node.name !== undefined)
        for (const member of node.members) {
          const body = ts.isFunctionLike(member) ? member.body : undefined;
          if (body === undefined) continue;
          const name = ts.isConstructorDeclaration(member) ? "constructor" : nameText(member.name);
          addMember(node.name.text, name, member, file, sourceFile);
        }
      else if (ts.isFunctionDeclaration(node) && node.body !== undefined)
        addMember(functionOwner(node), nameText(node.name), node, file, sourceFile);
    });
  // a public method that only forwards to the function of its name, with that function's name node: its callee
  const forwarders = new Map();
  for (const declarations of members.values())
    for (const { declaration } of declarations) {
      if (
        !ts.isMethodDeclaration(declaration) ||
        !ts.isIdentifier(declaration.name) ||
        (ts.getModifiers(declaration) ?? []).some(
          (modifier) => modifier.kind !== ts.SyntaxKind.PublicKeyword,
        ) ||
        (ts.getDecorators(declaration) ?? []).length > 0 ||
        declaration.parameters.some(
          (parameter) =>
            parameter.initializer !== undefined ||
            parameter.dotDotDotToken !== undefined ||
            !ts.isIdentifier(parameter.name),
        )
      )
        continue;
      const statements = declaration.body.statements;
      const only = statements.length === 1 ? statements[0] : undefined;
      const call =
        only !== undefined && (ts.isReturnStatement(only) || ts.isExpressionStatement(only))
          ? only.expression
          : undefined;
      if (
        call === undefined ||
        !ts.isCallExpression(call) ||
        !ts.isIdentifier(call.expression) ||
        call.expression.text !== declaration.name.text ||
        call.arguments[0]?.kind !== ts.SyntaxKind.ThisKeyword ||
        call.arguments.length !== declaration.parameters.length + 1 ||
        call.arguments
          .slice(1)
          .some(
            (argument, index) =>
              !ts.isIdentifier(argument) ||
              argument.text !== declaration.parameters[index].name.text,
          )
      )
        continue;
      const owner = declaration.parent.name?.text ?? null;
      const target = (members.get(`${owner} ${declaration.name.text}`) ?? []).find((candidate) =>
        ts.isFunctionDeclaration(candidate.declaration),
      );
      if (target !== undefined) forwarders.set(declaration, call.expression);
    }
  // the sites this check allows are one declaration each
  const allowed = new Set([
    ...[...OWNERS.values()].map((guarded) => `${guarded.owner} ${guarded.member}`),
    ...[...readers.keys()].map((reader) => `${OWNERS.get("finishingRead").owner} ${bare(reader)}`),
  ]);
  for (const key of allowed) {
    const declarations = members.get(key) ?? [];
    // (a forwarder and its function, a getter and its setter, are one)
    const distinct = declarations.filter(
      ({ declaration }) =>
        !forwarders.has(declaration) &&
        !(
          ts.isSetAccessorDeclaration(declaration) &&
          declarations.some((other) => ts.isGetAccessorDeclaration(other.declaration))
        ),
    );
    if (distinct.length > 1)
      for (const { declaration, file, sourceFile } of distinct)
        reportIn(
          file,
          sourceFile,
          declaration,
          `${key.replace(" ", ".")} has ${distinct.length} declarations: a site this check allows is one, so rename all but one.`,
        );
  }

  // the members that name each guarded name, by class
  const named = new Set();
  // (every file parsed: a name the source spells with escapes is the same name, Codex r29 B1)
  for (const { file, sourceFile } of parsed) {
    const visit = (node) => {
      const text =
        ts.isIdentifier(node) || ts.isPrivateIdentifier(node) || ts.isStringLiteralLike(node)
          ? node.text
          : null;
      const name = text === null ? null : bare(text);
      if (name !== null && OWNERS.has(name)) {
        const { member, owner, name: memberName } = memberOf(node, sourceFile);
        const guarded = OWNERS.get(name);
        // (its own declaration names no reference; nor a forwarder's call of its function, nor an import under the
        // name's own name, whose uses are checked)
        if (member.name === node && owner === guarded.declaredIn);
        else if (forwarders.get(member) === node && owner === guarded.declaredIn);
        else if (ts.isImportSpecifier(node.parent) && node.parent.propertyName === undefined);
        else if (
          owner === guarded.owner &&
          (memberName === guarded.member || (name === "finishingRead" && readers.has(memberName)))
        )
          named.add(`${name} ${memberName}`);
        else
          reportIn(
            file,
            sourceFile,
            node,
            `${text} is named only in ${guarded.where} (TABLE r4.158, r4.165): every question's items come from CoreAnswers.#items.`,
          );
      }
      node.forEachChild(visit);
    };
    sourceFile.forEachChild(visit);
  }
  // the endpoint names both sources, `finishedItems` the finishing read, and every listed reader names it
  const anchor = sources.find((source) => source.file === `${CORE}/answers.ts`) ?? sources[0];
  const at = (message) =>
    diagnostics.push({ fileName: anchor?.file ?? CORE, line: 1, column: 1, message });
  for (const name of ["finishedItems", "lazilyDecided"])
    if (!named.has(`${name} items`)) at(`CoreAnswers.#items does not name ${name}.`);
  if (!named.has("finishingRead finishedItems"))
    at("Consumers.finishedItems does not name the finishing read.");
  for (const reader of readers.keys())
    if (!named.has(`finishingRead ${bare(reader)}`))
      at(`FINISHING_READERS lists Consumers.${reader}, which does not name the finishing read.`);
  return diagnostics;
}
