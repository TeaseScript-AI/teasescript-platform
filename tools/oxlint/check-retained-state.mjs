import { globSync, readFileSync } from "node:fs";
import { resolve, sep } from "node:path";
import { ts } from "ts-morph";

/**
 * #1072 step 1b: the type core's owners of retained state make each kind they change in place through `Retained`
 * (`src/type-inference/core/retained/retained.ts`), so the retained-state instrument makes it in tests
 * (`tests/helpers/retained-instrument.ts`). Read from the syntax alone:
 * in the scoped files, a `new Map`, `new Set`, `new WeakMap` or `new WeakSet` stands only where it cannot be kept by
 * an owner as made, which is the closed set below; any other place (a class field, a private field, a member's or a
 * module's variable's assignment, a module's mutable variable, a parameter property's default) is refused.
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
 * it is listed in `OUTSIDE_FIELDS`. Any other private field is refused, whatever its initializer: what an owner fills
 * later goes in a record.
 * Every file of the type core is checked, a new one too, unless `TOP_LEVEL` names it (its top level alone is checked)
 * or `OUTSIDE` does, each with its reason; the reasons match the instrument's domain.
 *
 * Four more lines hold what the instrument's guarantee leans on (#1072 R24, R25), in every core file and in every test
 * helper but the instrument itself:
 * - a native writer taken from a prototype (`Map`, `Set`, `WeakMap`, `WeakSet` or `Array`'s `.prototype.<writer>`) is
 *   refused in any position: `X.prototype` of these stands only as `X.prototype.<reader>`. A write through such an
 *   intrinsic is outside what the instrument sees, and this line holds it out of the code;
 * - a maker (`Retained.record`, `arena`, `array`) is given a fresh object or array literal, or nothing: no other
 *   reference can hold what production keeps and the instrument copies;
 * - in the checked core files, `Reflect.set`, a branch on a frozen state (`Object.isFrozen`, `isSealed`, `isExtensible`)
 *   and `structuredClone` are refused: a frozen run computes what production computes only without them; and so is a
 *   definer by its name in any position (`defineProperty`, `defineProperties`, `__defineGetter__`, `__defineSetter__`,
 *   an alias or a computed key included), which could reopen a locked owner's field or make it an accessor past the
 *   instrument;
 * - a `Retained.closure` registration stands right below its comment, which names what the function captures
 *   (`#1072 R26: captures …`, or `#1072 R26: as …` for one capturing as a named neighbour does): the instrument does not
 *   see the captures, and that comment is what review reads (#1072 R26).
 */
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
    "program.ts",
    "the program, built before any run: held as it is from its indexing on (`Retained.program`, whose graph the instrument walks and freezes)",
  ],
  ["flow-graph.ts", "the program's flow graph, built with it before any run"],
  [
    "contract/objects.ts",
    "what a query gathers (`Gathered`) becomes its proof, which the solver holds; its collections' shapes are closed by its own language (tools/oxlint/objects-language.mjs)",
  ],
  [
    "contract/contributions.ts",
    "a run's flow (`FlowSink`) is the solver's record of the run, published with its answer",
  ],
]);

/** How a core file is checked: `file`, `module` (its top level), or `null` (not at all). */
function levelOf(file) {
  const inner = file.slice(CORE.length);
  if (TOP_LEVEL.has(inner)) return "module";
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
]);

const COLLECTIONS = new Set(["Map", "Set", "WeakMap", "WeakSet"]);
const READONLY = new Set(["ReadonlyMap", "ReadonlySet"]);

/** The test helpers the intrinsic and maker lines read: all of them but the instrument, which is the writers' owner. */
const HELPERS = "tests/helpers/";
const INSTRUMENT = "tests/helpers/retained-instrument.ts";

export function checkRetainedState(root) {
  const sources = [];
  for (const found of globSync(`${CORE}**/*.ts`, { cwd: root }).sort()) {
    const file = found.split(sep).join("/");
    sources.push({ file, text: readFileSync(resolve(root, found), "utf8"), level: levelOf(file) });
  }
  for (const found of globSync(`${HELPERS}**/*.ts`, { cwd: root }).sort()) {
    const file = found.split(sep).join("/");
    if (file !== INSTRUMENT)
      sources.push({ file, text: readFileSync(resolve(root, found), "utf8"), level: "helper" });
  }
  return retainedStateDiagnostics(sources);
}

/** Each kind's native writers, which no code takes from its prototype. */
const WRITERS = new Map([
  ["Map", new Set(["set", "delete", "clear"])],
  ["WeakMap", new Set(["set", "delete"])],
  ["Set", new Set(["add", "delete", "clear"])],
  ["WeakSet", new Set(["add", "delete"])],
  [
    "Array",
    new Set(["push", "pop", "shift", "unshift", "splice", "sort", "reverse", "fill", "copyWithin"]),
  ],
]);

/** The makers given a literal: each to its literal's kind. */
const LITERAL_MAKERS = new Map([
  ["record", "object"],
  ["arena", "array"],
  ["array", "array"],
]);

/** The calls refused in the checked core files: a frozen run would compute differently, or the instrument miss a write. */
const DIFFERS = "so a frozen run would differ from production";
const IN_PLACE =
  "it can redefine a field in place, reopening a locked owner's field or making it an accessor past the instrument";
const FROZEN_DIFFERENCES = new Map([
  ["Reflect.set", `it writes a frozen value without throwing, ${DIFFERS}`],
  ["Object.isFrozen", `it branches on a frozen state, ${DIFFERS}`],
  ["Object.isSealed", `it branches on a frozen state, ${DIFFERS}`],
  ["Object.isExtensible", `it branches on a frozen state, ${DIFFERS}`],
  ["structuredClone", `it refuses a maker's proxy that production's value passes, ${DIFFERS}`],
]);
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

/** The intrinsic, maker and frozen-difference lines' diagnostics in `source` (`level` its `levelOf`, or `helper`). */
function guardLines(source, file, level) {
  const found = [];
  const visit = (node) => {
    if (
      ts.isPropertyAccessExpression(node) &&
      node.name.text === "prototype" &&
      ts.isIdentifier(node.expression) &&
      WRITERS.has(node.expression.text)
    ) {
      const kind = node.expression.text;
      const parent = node.parent;
      const reader =
        ts.isPropertyAccessExpression(parent) &&
        parent.expression === node &&
        !WRITERS.get(kind).has(parent.name.text);
      if (!reader)
        found.push({
          node,
          message:
            `\`${kind}.prototype\` stands where it can give a native writer: a write through an intrinsic taken ` +
            "from a prototype is outside what the retained-state instrument sees; call the value's own writer (#1072 R24)",
        });
    }
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      ts.isIdentifier(node.expression.expression) &&
      node.expression.expression.text === "Retained" &&
      LITERAL_MAKERS.has(node.expression.name.text)
    ) {
      const wanted = LITERAL_MAKERS.get(node.expression.name.text);
      const given = node.arguments[1];
      const literal =
        given === undefined
          ? wanted === "array"
          : wanted === "object"
            ? ts.isObjectLiteralExpression(given)
            : ts.isArrayLiteralExpression(given);
      if (!literal || node.arguments.length > 2)
        found.push({
          node,
          message:
            `\`Retained.${node.expression.name.text}\` is given a fresh ${wanted} literal${wanted === "array" ? ", or nothing" : ""}: ` +
            "no other reference may hold what production keeps and the instrument copies (#1072 R25)",
        });
    }
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      ts.isIdentifier(node.expression.expression) &&
      node.expression.expression.text === "Retained" &&
      node.expression.name.text === "closure" &&
      !capturesNamed(source, node)
    )
      found.push({
        node,
        message:
          "`Retained.closure` stands right below a comment naming what the function captures (`#1072 R26: captures …`): " +
          "the instrument does not see the captures, review reads that comment (#1072 R26)",
      });
    if (level === "file" || level === "module") {
      const callee = ts.isCallExpression(node) ? node.expression.getText(source) : null;
      const reason = callee === null ? undefined : FROZEN_DIFFERENCES.get(callee);
      if (reason !== undefined)
        found.push({ node, message: `\`${callee}\` in the type core: ${reason} (#1072 R21)` });
      if (
        (ts.isIdentifier(node) || ts.isStringLiteralLike(node)) &&
        IN_PLACE_DEFINERS.has(node.text)
      )
        found.push({ node, message: `\`${node.text}\` in the type core: ${IN_PLACE} (#1072 R30)` });
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
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
 * The check's diagnostics for `sources` (each `{ file, text, level }`: `level` `file` or `module` for a checked core file,
 * `null` for a core file left out, `helper` for a test helper; the guard lines read all of them).
 */
export function retainedStateDiagnostics(sources) {
  const diagnostics = [];
  for (const { file, text, level } of sources) {
    const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
    for (const { node, message } of guardLines(source, file, level))
      diagnostics.push({ ...at(source, file, node), message });
    if (level !== "file" && level !== "module") continue;
    const visit = (node) => {
      if (
        ts.isNewExpression(node) &&
        ts.isIdentifier(node.expression) &&
        COLLECTIONS.has(node.expression.text) &&
        !(level === "module" && inFunctionOrClass(node))
      ) {
        const { child, parent } = holder(node);
        if (!admitted(child, parent)) {
          diagnostics.push({
            ...at(source, file, node),
            message:
              `a ${node.expression.text} made where an owner can keep it: make it through \`Retained\` ` +
              "(src/type-inference/core/retained/retained.ts), so the retained-state instrument makes it (#1072)",
          });
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
    if (level === "file")
      for (const { node, message } of privateFields(source))
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

/** Whether `node` is a call of one of `Retained`'s makers (`Retained.map(…)`, `MAKERS`). */
function retainedCall(node) {
  return (
    node !== undefined &&
    ts.isCallExpression(node) &&
    ts.isPropertyAccessExpression(node.expression) &&
    ts.isIdentifier(node.expression.expression) &&
    node.expression.expression.text === "Retained" &&
    MAKERS.has(node.expression.name.text)
  );
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

/** Each private instance field of a class in `source` that is neither a readonly `Retained` collection nor exposed. */
function privateFields(source) {
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
        if (
          ts.isCallExpression(inner) &&
          ts.isPropertyAccessExpression(inner.expression) &&
          ts.isIdentifier(inner.expression.expression) &&
          inner.expression.expression.text === "Retained" &&
          inner.expression.name.text === "owner" &&
          inner.arguments.length === 3
        ) {
          const hidden = inner.arguments[2];
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
        if (ts.isConstructorDeclaration(member) && member.body !== undefined) owners(member.body);
      for (const member of node.members) {
        if (!ts.isPropertyDeclaration(member) || !ts.isPrivateIdentifier(member.name)) continue;
        const modifiers = member.modifiers ?? [];
        if (modifiers.some((modifier) => modifier.kind === ts.SyntaxKind.StaticKeyword)) continue;
        const readonly = modifiers.some(
          (modifier) => modifier.kind === ts.SyntaxKind.ReadonlyKeyword,
        );
        if (
          (readonly && (retainedCall(member.initializer) || exposed.has(member.name.text))) ||
          OUTSIDE_FIELDS.has(`${node.name?.text}.${member.name.text}`)
        )
          continue;
        found.push({
          node: member,
          message:
            `a private field \`${member.name.text}\` of ${node.name?.text ?? "a class"} that the retained-state instrument ` +
            "cannot see: make it `readonly`, made through `Retained` or exposed in its class's `Retained.owner` hidden " +
            "function, which is read once; what changes later goes in a record (`Retained.record`) (#1072)",
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
