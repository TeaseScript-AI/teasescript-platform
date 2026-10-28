import { globSync, readFileSync } from "node:fs";
import { relative, resolve, sep } from "node:path";
import { Project, ts } from "ts-morph";

/**
 * The question API's one source endpoint (TABLE r4.158), read from the syntax tree with its types: `CoreAnswers.#items`
 * answers every question's items, direct or composed, so the two sources it alone reads after a stop, the finishing
 * read's domains (`Consumers.finishedItems`) and the place's lazily decided type (`#lazilyDecided`), are named in the
 * source only as the callee of a call in `#items`' own body; and the consumers and admission, whose members could read
 * the finishing read another way, are reached from elsewhere only through the members `QUESTION_READS` lists, each with
 * why it reads no value's items. The check rejects:
 * - any other mention of either source's name in `src/`: a call elsewhere, a call inside a function `#items` makes, a
 *   reference kept or passed on, a destructured or quoted name;
 * - outside consumers.ts and admission.ts, a reference to a `Consumers` or `Admission` member the list lacks, whatever
 *   its form (a call, an alias, `.bind`, a destructured or quoted name, a helper's, another module's), so a new wrapper of
 *   the finishing read, a method or a function-valued field, fails wherever it is read (Codex r26 B1);
 * - there, a `Consumers` or `Admission` value (any expression of either type, a union's or an intersection's member) used
 *   whole as another type, whose members the check could not see: where the place it flows to expects another type (a
 *   structural parameter, field or return, a cast, a generic's type parameter), or spread or rest-destructured into a
 *   copy; a value kept as it is (a binding of its own type, an array or a map of it, a comparison) is checked where it is
 *   read again (Codex r27 B1);
 * - an `#items` that calls either source nowhere, and a listed member nothing reads.
 * A listed member is trusted by its reason, as the inventory check's reads are (TABLE r4.152 (3)). A member reached by a
 * computed name is not seen.
 */
const ANSWERS = "src/type-inference/core/answers.ts";
const CONSUMERS = "src/type-inference/core/consumers.ts";
const ADMISSION = "src/type-inference/core/admission.ts";

/** The sources `#items` alone reads. */
const ENDPOINT_SOURCES = ["finishedItems", "#lazilyDecided"];

/** The `Consumers` and `Admission` members read outside their own files, each with why it reads no value's items. */
export const QUESTION_READS = new Map([
  ["Consumers.admission", "the admission the walk decided with: its members are this list's own"],
  ["Consumers.check", "runs the walk: returns nothing"],
  ["Consumers.deferred", "the stop's marks: obligations"],
  ["Consumers.diagnostics", "the consumers' findings"],
  ["Consumers.finish", "finishes the walk after a stop: returns nothing"],
  ["Consumers.published", "whether the walk published the boundaries"],
  ["Consumers.quiet", "the reads the consumers proved quiet: a route"],
  ["Consumers.reads", "the demands the walk asked: work"],
  ["Consumers.rules", "each finding's rank among a site's"],
  ["Consumers.settled", "whether admission had settled"],
  ["Consumers.stopPhase", "the phase a stop came in"],
  ["Consumers.stopped", "the limit a stop came at"],
  [
    "Admission.admitted",
    "the admitted type at a path: a decision's answer, `#lazilyDecided`'s own",
  ],
  ["Admission.boundaries", "the published boundaries: obligations"],
  ["Admission.deciderAt", "a decision's site"],
  ["Admission.inheritsWritten", "whether a decision is a written type's: a test"],
  ["Admission.literalChildren", "a literal's children at a step: syntax"],
  ["Admission.newlyRejected", "the stores a pass rejected: places"],
  ["Admission.readChecks", "the read checks: obligations"],
]);

export function checkQuestionSources(root) {
  const project = new Project({
    tsConfigFilePath: resolve(root, "tsconfig.json"),
    skipAddingFilesFromTsConfig: true,
  });
  for (const file of [ANSWERS, CONSUMERS, ADMISSION])
    project.addSourceFileAtPath(resolve(root, file));
  // (any other source file that names either source or either class, read with its types)
  const others = globSync("src/**/*.ts", { cwd: root })
    .map((file) => file.split(sep).join("/"))
    .filter((file) => {
      if (file === ANSWERS || file === CONSUMERS || file === ADMISSION) return false;
      const text = readFileSync(resolve(root, file), "utf8");
      return [...ENDPOINT_SOURCES, "Consumers", "Admission"].some((name) => text.includes(name));
    });
  for (const file of others) project.addSourceFileAtPath(resolve(root, file));
  project.resolveSourceFileDependencies();
  return questionSourceDiagnostics(project.getProgram().compilerObject, root, {
    answers: ANSWERS,
    consumers: CONSUMERS,
    admission: ADMISSION,
    others,
    reads: QUESTION_READS,
  });
}

/**
 * @param {ts.Program} program
 * @param {string} root
 * @param {{ answers: string, consumers: string, admission: string, others: readonly string[], reads: ReadonlyMap<string, string> }} files
 * @returns {{ fileName: string, line: number, column: number, message: string }[]}
 */
export function questionSourceDiagnostics(program, root, files) {
  const checker = program.getTypeChecker();
  const diagnostics = [];
  const reported = new Set();
  const report = (node, message) => {
    const sourceFile = node.getSourceFile();
    const start = node.getStart(sourceFile);
    // (once per site: an expression and the one around it that starts there are one use)
    const key = `${sourceFile.fileName}:${start}:${message}`;
    if (reported.has(key)) return;
    reported.add(key);
    const location = sourceFile.getLineAndCharacterOfPosition(start);
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
  const answers = classOf(sourceOf(files.answers), "CoreAnswers");
  const consumers = classOf(sourceOf(files.consumers), "Consumers");
  const admission = classOf(sourceOf(files.admission), "Admission");
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
  // the guarded classes, by their instance types; a member's class name, `null` for any other declaration
  const guarded = [consumers, admission].map((declaration) => ({
    declaration,
    name: declaration.name.text,
    type: checker.getDeclaredTypeOfSymbol(checker.getSymbolAtLocation(declaration.name)),
  }));
  const ownerOf = (declaration) =>
    guarded.find((each) => declaration?.parent === each.declaration)?.name ?? null;

  // 1. each mention of a source's name: its declaration, or the callee of a call in #items' own body; else a failure
  const called = new Set();
  const visitSources = (node) => {
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
    node.forEachChild(visitSources);
  };
  for (const file of [files.answers, files.consumers, files.admission, ...files.others])
    sourceOf(file).forEachChild(visitSources);

  // 2. outside the two classes' files, their members only as listed, their values only through members or as themselves
  const read = new Set();
  // the member a name node refers to, through a property access, a quoted element access or a destructuring
  const memberOf = (node) => {
    let symbol = checker.getSymbolAtLocation(node);
    const parent = node.parent;
    if (ts.isBindingElement(parent) && ts.isObjectBindingPattern(parent.parent)) {
      const named = parent.propertyName ?? parent.name;
      if (named === node)
        symbol = checker
          .getTypeAtLocation(parent.parent)
          .getProperty(ts.isIdentifier(named) || ts.isStringLiteralLike(named) ? named.text : "");
    } else if (
      ts.isShorthandPropertyAssignment(parent) &&
      ts.isObjectLiteralExpression(parent.parent) &&
      ts.isBinaryExpression(parent.parent.parent) &&
      parent.parent.parent.left === parent.parent &&
      parent.parent.parent.operatorToken.kind === ts.SyntaxKind.EqualsToken
    )
      // (a destructuring assignment's shorthand name)
      symbol = checker.getPropertySymbolOfDestructuringAssignment(node) ?? symbol;
    const declaration = symbol?.declarations?.[0];
    const owner = ownerOf(declaration);
    return owner === null ? null : `${owner}.${declaration.name?.getText() ?? "constructor"}`;
  };
  // a type that is a guarded class, or a union or intersection holding one
  const holds = (type) =>
    type !== undefined &&
    (type.isUnionOrIntersection()
      ? type.types.some(holds)
      : guarded.some((each) => each.type === type));
  const AS_ANOTHER_TYPE =
    "A Consumers or Admission value is used here as another type: read its listed members instead.";
  // its context: a member read (above), the value kept as it is (an expression around it that holds it too, a binding
  // of its own type, a comparison), or a place expecting its own type; never spread, rest-destructured, or expected as
  // another type (a structural parameter or field, a cast, a generic's type parameter)
  const whole = (expression) => {
    const parent = expression.parent;
    if (
      (ts.isPropertyAccessExpression(parent) || ts.isElementAccessExpression(parent)) &&
      parent.expression === expression
    )
      return;
    if (ts.isSpreadAssignment(parent) || ts.isSpreadElement(parent)) {
      report(expression, AS_ANOTHER_TYPE);
      return;
    }
    // (destructured: its names are member reads, above; a rest element copies the rest as another type)
    const pattern =
      ts.isVariableDeclaration(parent) && parent.initializer === expression
        ? parent.name
        : ts.isBinaryExpression(parent) &&
            parent.right === expression &&
            parent.operatorToken.kind === ts.SyntaxKind.EqualsToken
          ? parent.left
          : null;
    if (
      pattern !== null &&
      (ts.isObjectBindingPattern(pattern) || ts.isObjectLiteralExpression(pattern))
    ) {
      const elements = ts.isObjectBindingPattern(pattern) ? pattern.elements : pattern.properties;
      if (
        elements.some((element) =>
          ts.isBindingElement(element)
            ? element.dotDotDotToken !== undefined
            : ts.isSpreadAssignment(element),
        )
      )
        report(expression, AS_ANOTHER_TYPE);
      return;
    }
    const expected = checker.getContextualType(expression);
    if (expected !== undefined && !holds(expected)) report(expression, AS_ANOTHER_TYPE);
  };
  const visitMembers = (node) => {
    if (ts.isIdentifier(node) || ts.isPrivateIdentifier(node) || ts.isStringLiteralLike(node)) {
      const member = memberOf(node);
      if (member !== null && !sources.has(member.slice(member.indexOf(".") + 1))) {
        read.add(member);
        if (!files.reads.has(member))
          report(
            node,
            `${member} is no listed question read: list it in QUESTION_READS with why it reads no value's items, or ask CoreAnswers.#items.`,
          );
      }
    }
    // an expression of a guarded type: the whole value, wherever it flows (Codex r27 B1)
    if (ts.isShorthandPropertyAssignment(node) && ts.isObjectLiteralExpression(node.parent)) {
      const value = checker.getShorthandAssignmentValueSymbol(node);
      if (value !== undefined && holds(checker.getTypeOfSymbolAtLocation(value, node.name))) {
        // (the property's expected type, in each member of the object's expected union that has it)
        const object = checker.getContextualType(node.parent);
        const expected =
          object === undefined
            ? null
            : (object.isUnion() ? object.types : [object]).flatMap((each) => {
                const property = each.getProperty(node.name.text);
                return property === undefined
                  ? []
                  : [checker.getTypeOfSymbolAtLocation(property, node.parent)];
              });
        if (expected !== null && !expected.some(holds)) report(node, AS_ANOTHER_TYPE);
      }
    } else if (ts.isExpressionNode(node) && holds(checker.getTypeAtLocation(node))) whole(node);
    node.forEachChild(visitMembers);
  };
  for (const file of [files.answers, ...files.others]) sourceOf(file).forEachChild(visitMembers);

  // 3. #items reads both sources; every listed member is read
  for (const name of sources)
    if (!called.has(name)) report(items, `CoreAnswers.#items does not call ${name}.`);
  for (const member of files.reads.keys())
    if (!read.has(member))
      report(answers, `QUESTION_READS lists ${member}, which nothing outside its file reads.`);
  return diagnostics;
}
