import { globSync, readFileSync } from "node:fs";
import { relative, resolve, sep } from "node:path";
import { Project, ts } from "ts-morph";

/**
 * The question API's one source endpoint (TABLE r4.158), read from the syntax tree with its types: `CoreAnswers.#items`
 * answers every question's items, direct or composed, so the two sources it alone reads after a stop, the finishing
 * read's domains (`Consumers.finishedItems`) and the place's lazily decided type (`#lazilyDecided`), are named in the
 * source only as the callee of a call in `#items`' own body. The check rejects:
 * - any other mention of either name in `src/`: a call elsewhere, a call inside a function `#items` makes, a reference
 *   kept or passed on, a destructured or quoted name;
 * - a `CoreAnswers` call into any other `Consumers` method, which would be a second way to the consumers' reads;
 * - an `#items` that calls either source nowhere.
 * Its scope is the ordinary forms: a member reached by a computed name is not seen.
 */
const ANSWERS = "src/type-inference/core/answers.ts";
const CONSUMERS = "src/type-inference/core/consumers.ts";

/** The sources `#items` alone reads. */
const ENDPOINT_SOURCES = ["finishedItems", "#lazilyDecided"];

export function checkQuestionSources(root) {
  const project = new Project({
    tsConfigFilePath: resolve(root, "tsconfig.json"),
    skipAddingFilesFromTsConfig: true,
  });
  for (const file of [ANSWERS, CONSUMERS]) project.addSourceFileAtPath(resolve(root, file));
  // (any other source file that names either, read as syntax)
  const others = globSync("src/**/*.ts", { cwd: root })
    .map((file) => file.split(sep).join("/"))
    .filter((file) => {
      if (file === ANSWERS || file === CONSUMERS) return false;
      const text = readFileSync(resolve(root, file), "utf8");
      return ENDPOINT_SOURCES.some((name) => text.includes(name));
    });
  for (const file of others) project.addSourceFileAtPath(resolve(root, file));
  project.resolveSourceFileDependencies();
  return questionSourceDiagnostics(project.getProgram().compilerObject, root, {
    answers: ANSWERS,
    consumers: CONSUMERS,
    others,
  });
}

/**
 * @param {ts.Program} program
 * @param {string} root
 * @param {{ answers: string, consumers: string, others: readonly string[] }} files
 * @returns {{ fileName: string, line: number, column: number, message: string }[]}
 */
export function questionSourceDiagnostics(program, root, files) {
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
    if (found === undefined) throw new Error(`The question-source check reads ${file}.`);
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
  const consumersFile = sourceOf(files.consumers);
  const answers = classOf(sourceOf(files.answers), "CoreAnswers");
  const consumers = classOf(consumersFile, "Consumers");
  const items = answers.members.find(
    (member) =>
      ts.isMethodDeclaration(member) &&
      ts.isPrivateIdentifier(member.name) &&
      member.name.text === "#items",
  );
  if (items === undefined) {
    report(answers, "CoreAnswers has no #items, every question's one source endpoint.");
    return diagnostics;
  }
  const sources = new Set(ENDPOINT_SOURCES);
  const enclosingFunction = (node) => {
    for (let at = node.parent; at !== undefined; at = at.parent)
      if (ts.isFunctionLike(at)) return at;
    return null;
  };

  // 1. each mention of a source's name: its declaration, or the callee of a call in #items' own body; else a failure
  const called = new Set();
  const visit = (node) => {
    const name =
      ts.isIdentifier(node) || ts.isPrivateIdentifier(node) || ts.isStringLiteralLike(node)
        ? node.text
        : null;
    if (name !== null && sources.has(name)) {
      const parent = node.parent;
      const declared =
        ts.isMethodDeclaration(parent) &&
        parent.name === node &&
        parent.parent === (name === "finishedItems" ? consumers : answers);
      const call =
        ts.isPropertyAccessExpression(parent) &&
        parent.name === node &&
        ts.isCallExpression(parent.parent) &&
        parent.parent.expression === parent
          ? parent.parent
          : null;
      if (call !== null && enclosingFunction(call) === items) called.add(name);
      else if (!declared)
        report(
          node,
          `${name} is read by CoreAnswers.#items alone, every question's one source endpoint (TABLE r4.158): ask #items.`,
        );
    }
    node.forEachChild(visit);
  };
  for (const file of [files.answers, files.consumers, ...files.others])
    sourceOf(file).forEachChild(visit);

  // 2. CoreAnswers reaches the consumers' reads through finishedItems alone
  const visitCalls = (node) => {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
      const declaration = checker.getSymbolAtLocation(node.expression.name)?.declarations?.[0];
      if (
        declaration !== undefined &&
        declaration.parent === consumers &&
        ts.isMethodDeclaration(declaration) &&
        !sources.has(declaration.name.getText())
      )
        report(
          node,
          `CoreAnswers calls Consumers.${declaration.name.getText()}: the questions read the consumers through finishedItems in #items alone.`,
        );
    }
    node.forEachChild(visitCalls);
  };
  answers.forEachChild(visitCalls);

  // 3. #items reads both
  for (const name of sources)
    if (!called.has(name)) report(items, `CoreAnswers.#items does not call ${name}.`);
  return diagnostics;
}
