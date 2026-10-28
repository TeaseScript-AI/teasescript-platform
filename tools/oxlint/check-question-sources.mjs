import { globSync, readFileSync } from "node:fs";
import { resolve, sep } from "node:path";
import { ts } from "ts-morph";

/**
 * The question API's one source endpoint (TABLE r4.158; this check's scope, r4.165), read from the syntax alone:
 * `CoreAnswers.#items` answers every question's items, direct or composed, so in `src/type-inference/core/` the two
 * sources it alone reads after a stop, the finishing read's domains (`Consumers.finishedItems`) and the place's lazily
 * decided type (`#lazilyDecided`), are named only inside `#items`, and the finishing read itself
 * (`Consumers.#finishingRead`) only inside `finishedItems` and the consumers' own reads `FINISHING_READERS` lists. Every
 * reference by name counts: a call, a property access, an alias, a destructured or quoted name. `#items` names both
 * sources and `finishedItems` the finishing read. A reference the syntax does not name (an inherited member reached
 * through an inferred wrapper, a generic receiver, a computed name) is outside this check, a review matter against
 * r4.158 (r4.165).
 */
const CORE = "src/type-inference/core";

/** Each guarded name: the class declaring it, the class and member it may be named in, and where that is. */
const OWNERS = new Map([
  [
    "finishedItems",
    {
      declaredIn: "Consumers",
      owner: "CoreAnswers",
      member: "#items",
      where: "CoreAnswers.#items",
    },
  ],
  [
    "#lazilyDecided",
    {
      declaredIn: "CoreAnswers",
      owner: "CoreAnswers",
      member: "#items",
      where: "CoreAnswers.#items",
    },
  ],
  [
    "#finishingRead",
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
  ["#valueItems", "every consumer's one read, unstopped or finishing (TABLE r4.99)"],
  ["#finishingRead", "its own descent into a literal's children"],
  ["#typedRead", "a typed default's domain, read where its own answer is missing (TABLE r4.144)"],
]);

export function checkQuestionSources(root) {
  const sources = globSync(`${CORE}/**/*.ts`, { cwd: root })
    .map((file) => file.split(sep).join("/"))
    .sort()
    .map((file) => ({ file, text: readFileSync(resolve(root, file), "utf8") }));
  return questionSourceDiagnostics(sources, FINISHING_READERS);
}

/**
 * @param {readonly { file: string, text: string }[]} sources
 * @param {ReadonlyMap<string, string>} readers
 * @returns {{ fileName: string, line: number, column: number, message: string }[]}
 */
export function questionSourceDiagnostics(sources, readers) {
  const diagnostics = [];
  // the members that name each guarded name, by class
  const named = new Set();
  for (const { file, text } of sources) {
    if (![...OWNERS.keys()].some((name) => text.includes(name.replace("#", "")))) continue;
    const sourceFile = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
    const report = (node, message) => {
      const location = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
      diagnostics.push({
        fileName: file,
        line: location.line + 1,
        column: location.character + 1,
        message,
      });
    };
    const visit = (node) => {
      const name =
        ts.isIdentifier(node) || ts.isPrivateIdentifier(node) || ts.isStringLiteralLike(node)
          ? node.text
          : null;
      if (name !== null && OWNERS.has(name)) {
        // the class member the name lies in, the innermost
        let member = node;
        while (member.parent !== undefined && !ts.isClassLike(member.parent))
          member = member.parent;
        const owner = member.parent?.name?.text ?? null;
        const memberName = ts.isConstructorDeclaration(member)
          ? "constructor"
          : (member.name?.text ?? null);
        const guarded = OWNERS.get(name);
        // (its own declaration names no reference)
        if (member.name === node && owner === guarded.declaredIn);
        else if (
          owner === guarded.owner &&
          (memberName === guarded.member || (name === "#finishingRead" && readers.has(memberName)))
        )
          named.add(`${name} ${memberName}`);
        else
          report(
            node,
            `${name} is named only in ${guarded.where} (TABLE r4.158, r4.165): every question's items come from CoreAnswers.#items.`,
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
  for (const name of ["finishedItems", "#lazilyDecided"])
    if (!named.has(`${name} #items`)) at(`CoreAnswers.#items does not name ${name}.`);
  if (!named.has("#finishingRead finishedItems"))
    at("Consumers.finishedItems does not name #finishingRead.");
  for (const reader of readers.keys())
    if (!named.has(`#finishingRead ${reader}`))
      at(`FINISHING_READERS lists Consumers.${reader}, which does not name #finishingRead.`);
  return diagnostics;
}
