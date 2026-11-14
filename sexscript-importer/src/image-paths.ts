import { helperCall, type HelperName } from "./helpers.ts";
import type { IrExpression, IrStatement } from "./ir.ts";
import { SENT_IMAGE_PREFIX } from "./lower.ts";
import { withNestedBlocks } from "./repeated-text.ts";
import { mapChildren, mapOwnExpressions } from "./variable-types.ts";

/** A picture from takePhoto(), or one whose legacy path no test can know: a chosen file's, or a received picture's. */
type Source = "camera" | "unknown";

/** The tests scripts made on a picture's path. */
const PATH_TESTS = new Set(["endsWith", "contains"]);
const CASES = new Set(["lowercase", "uppercase"]);
/**
 * The parts every legacy webcam path held, `<folder>/images/captured/<number>.jpeg`, between the folder separators of
 * the player's system: `/`, or `\` on Windows (File.getCanonicalPath()).
 */
const CAMERA_PARTS = ["images", "captured", ".jpeg"];

/**
 * Legacy getImage() saved the webcam picture as `<folder>/images/captured/<number>.jpeg` and returned that path
 * (ss.desktop.Script.getImage), and getFile() the path of the file the player chose; scripts tested it, as
 * `!file.toLowerCase().endsWith(".jpg") && !file.toLowerCase().endsWith(".jpeg")` or `image.contains("captured")`.
 * takePhoto() and askImage() give an engine reference instead (V30 askImage), which keeps no such path. Where a
 * variable's every value is a takePhoto() picture, null, the empty start, or a copy of such a variable, a test that
 * every webcam path answers alike reads such a path instead (sexscriptLegacyImagePath): `endsWith` of a text without
 * digits, which only a suffix of `.jpeg` ends, and `contains` of a part of `images`, `captured`, or `.jpeg`, also after
 * `lowercase()` or `uppercase()`. A missing picture still fails the test. Any other test of a picture's path, as of a
 * chosen file's extension, stays as written, with a note (SX_IMAGE_PATH_TEST). Values that a never-true flag guards,
 * `if testmode { file = "test.jpg" }` with `let testmode = false`, are not values (MandysBlackmail's test mode).
 */
export function withLegacyImagePaths(
  statements: IrStatement[],
  helpers: Set<HelperName>,
): IrStatement[] {
  const scopes = new Scopes();
  const sources = imageVariables(statements, scopes);
  if (sources.size === 0) return statements;
  // The picture variable a test's receiver reads, through lowercase() and uppercase(), with the case they leave.
  const receiver = (
    value: IrExpression,
    scope: Scope,
  ): { key: string; kinds: ReadonlySet<Source>; cased: (text: string) => string } | null => {
    if (value.kind === "variable") {
      const key = scopes.key(value.name, scope);
      const kinds = sources.get(key);
      return kinds === undefined ? null : { key, kinds, cased: (text) => text };
    }
    if (value.kind === "methodCall" && CASES.has(value.name) && value.arguments.length === 0) {
      const inner = receiver(value.target, scope);
      if (inner === null) return null;
      return {
        ...inner,
        cased: (text) => (value.name === "lowercase" ? text.toLowerCase() : text.toUpperCase()),
      };
    }
    return null;
  };
  // Whether every webcam path answers the test alike.
  const decided = (
    test: string,
    argument: IrExpression,
    cased: (text: string) => string,
  ): boolean => {
    if (argument.kind !== "literal" || typeof argument.value !== "string") return false;
    const text = argument.value;
    if (test === "endsWith") return !/\d/u.test(text);
    return CAMERA_PARTS.some((part) => cased(part).includes(text));
  };
  const withPath = (value: IrExpression): IrExpression => {
    if (value.kind === "variable") return helperCall("imagePath", [value]);
    if (value.kind === "methodCall") return { ...value, target: withPath(value.target) };
    return value;
  };
  const block = (items: IrStatement[], scope: Scope): IrStatement[] =>
    items.flatMap((item) => {
      let undecided = false;
      const rewrite = (value: IrExpression): IrExpression => {
        const next = mapChildren(value, rewrite);
        if (next.kind !== "methodCall" || !PATH_TESTS.has(next.name) || next.arguments.length !== 1)
          return next;
        const found = receiver(next.target, scope);
        if (found === null) return next;
        if (
          found.kinds.size === 1 &&
          found.kinds.has("camera") &&
          decided(next.name, next.arguments[0]!, found.cased)
        ) {
          helpers.add("imagePath");
          return { ...next, target: withPath(next.target) };
        }
        undecided = true;
        return next;
      };
      const inner = scopes.inner(item, scope);
      const next = mapOwnExpressions(
        withNestedBlocks(item, (body) => block(body, inner)),
        rewrite,
      );
      if (!undecided) return [next];
      const line = item.span === null ? "" : ` line ${item.span.line}`;
      return [
        {
          kind: "comment",
          text: `// NOTE SX_IMAGE_PATH_TEST${line}: The legacy test read the picture file's path, where a TeaseScript picture is a reference without one; it depends on a part of the path the conversion cannot know, such as a chosen file's name or the player's folder, so it stays as written and tests the reference.`,
          trailing: false,
          span: item.span,
        },
        next,
      ];
    });
  return block(statements, scopes.top);
}

/** A value a variable gets, with the key of the variable it copies, if it is one. */
interface Assigned {
  value: IrExpression;
  copy: string | null;
}

/** A function body, or the file outside functions, with the names it declares. */
interface Scope {
  id: number;
  names: ReadonlySet<string>;
  outer: Scope | null;
}

/** The scopes of a file's names: a function's parameters and the names it declares, and the file's other names. */
class Scopes {
  readonly top: Scope;
  private readonly functions = new Map<IrStatement, Scope>();
  private next = 1;

  constructor() {
    this.top = { id: 0, names: new Set(), outer: null };
  }

  /** The scope of a statement's nested blocks: a function's own, otherwise the statement's. */
  inner(item: IrStatement, scope: Scope): Scope {
    if (item.kind !== "function") return scope;
    let found = this.functions.get(item);
    if (found === undefined) {
      const names = new Set(item.parameters.map((parameter) => parameter.name));
      const declare = (items: readonly IrStatement[]): void => {
        for (const statement of items) {
          if (statement.kind === "let") names.add(statement.name);
          if (statement.kind === "for") {
            names.add(statement.variable);
            if (statement.valueVariable !== undefined) names.add(statement.valueVariable);
          }
          if (statement.kind !== "function")
            withNestedBlocks(statement, (body) => (declare(body), body));
        }
      };
      declare(item.body);
      found = { id: this.next, names, outer: scope };
      this.next += 1;
      this.functions.set(item, found);
    }
    return found;
  }

  /** The key of the variable a name reads in a scope: the innermost function's that declares it, or the file's. */
  key(name: string, scope: Scope): string {
    for (let current: Scope | null = scope; current !== null; current = current.outer)
      if (current.names.has(name)) return `${current.id}:${name}`;
    return `0:${name}`;
  }
}

/**
 * The variables of a file whose every value is a picture, null, the empty start, or such a variable's value, with
 * the sources of their pictures, by scope key: a parameter, a loop variable, a global, or a variable that gets any
 * other value is none. A value that a never-true flag guards is none.
 */
function imageVariables(
  statements: readonly IrStatement[],
  scopes: Scopes,
): Map<string, Set<Source>> {
  const collect = (dead: ReadonlySet<string>) => {
    const values = new Map<string, Assigned[]>();
    const excluded = new Set<string>();
    const add = (key: string, value: IrExpression, scope: Scope): void => {
      const copy = value.kind === "variable" ? scopes.key(value.name, scope) : null;
      values.set(key, [...(values.get(key) ?? []), { value, copy }]);
    };
    const flag = (condition: IrExpression, scope: Scope): string | null =>
      condition.kind === "variable" ? scopes.key(condition.name, scope) : null;
    const visit = (items: readonly IrStatement[], scope: Scope): void => {
      for (const item of items) {
        if (item.kind === "let") {
          const key = scopes.key(item.name, scope);
          add(key, item.value, scope);
          if (item.global === true) excluded.add(key);
        } else if (item.kind === "assign" && item.target.kind === "variable") {
          const key = scopes.key(item.target.name, scope);
          if (item.operator === "=") add(key, item.value, scope);
          else excluded.add(key);
        } else if (item.kind === "for") {
          excluded.add(scopes.key(item.variable, scope));
          if (item.valueVariable !== undefined) excluded.add(scopes.key(item.valueVariable, scope));
        }
        const inner = scopes.inner(item, scope);
        if (item.kind === "function")
          for (const parameter of item.parameters) excluded.add(scopes.key(parameter.name, inner));
        if (item.kind === "if") {
          // `if flag` never runs its branch, and `if not flag` never runs its else.
          const tested = flag(item.condition, scope);
          const negated =
            item.condition.kind === "unary" && item.condition.operator === "not"
              ? flag(item.condition.value, scope)
              : null;
          if (tested === null || !dead.has(tested)) visit(item.then, inner);
          if (negated === null || !dead.has(negated)) visit(item.else, inner);
          continue;
        }
        withNestedBlocks(item, (body) => (visit(body, inner), body));
      }
    };
    visit(statements, scopes.top);
    return { values, excluded };
  };
  // A flag that starts false and that nothing sets is never true.
  const all = collect(new Set());
  const dead = new Set(
    [...all.values]
      .filter(
        ([key, assigned]) =>
          !all.excluded.has(key) &&
          assigned.length === 1 &&
          assigned[0]!.value.kind === "literal" &&
          assigned[0]!.value.value === false,
      )
      .map(([key]) => key),
  );
  const { values, excluded } = dead.size === 0 ? all : collect(dead);
  const kinds = new Map<string, Set<Source>>();
  // A value's sources: a picture's, none for null or the empty start, or "other".
  const sourcesOf = (value: IrExpression): Set<Source> | "other" | undefined => {
    if (value.kind === "literal" && (value.value === null || value.value === "")) return new Set();
    if (value.kind === "call" && value.name === "takePhoto") return new Set(["camera"]);
    if (value.kind === "call" && value.name === "askImage") return new Set(["unknown"]);
    // A picture another script sent, whose reference the package keeps under the sent image's key (receiveImage()).
    if (value.kind === "load" && keyText(value.key).startsWith(SENT_IMAGE_PREFIX))
      return new Set(["unknown"]);
    return "other";
  };
  for (let changed = true; changed;) {
    changed = false;
    for (const [key, assigned] of values) {
      if (excluded.has(key) || kinds.has(key)) continue;
      const pictures = new Set<Source>();
      let open = false;
      let taken = false;
      for (const { value, copy } of assigned) {
        // A copy of a variable is known once that variable is.
        const found =
          copy === null
            ? sourcesOf(value)
            : excluded.has(copy) || !values.has(copy)
              ? "other"
              : kinds.get(copy);
        if (found === "other" || found === undefined) open = true;
        else {
          for (const source of found) pictures.add(source);
          if (found.size > 0) taken = true;
        }
      }
      if (open || !taken) continue;
      kinds.set(key, pictures);
      changed = true;
    }
  }
  return kinds;
}

/** The literal text a storage key starts with, up to its first value. */
function keyText(key: IrExpression): string {
  if (key.kind === "literal" && typeof key.value === "string") return key.value;
  if (key.kind === "template") {
    const [first] = key.parts;
    return first !== undefined && "text" in first ? first.text : "";
  }
  return "";
}
