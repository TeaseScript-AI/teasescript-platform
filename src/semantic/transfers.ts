import type {
  Expression,
  FileTarget,
  LabelTarget,
  LetStatement,
  TagQueryExpression,
  TagQueryStep,
} from "../ast.js";
import { CORE_RUNTIME_BUILTINS } from "../language-facts.js";
import {
  declarationsOnlyMessage,
  globMatches,
  globMayReach,
  isPathGlob,
  liesIn,
  packageGlobProblem,
  packagePathProblem,
} from "../project-paths.js";
import type { SemanticValidator } from "../semantic.js";
import type { SourceSpan } from "../source.js";
import { staticNumber } from "../static-evaluation.js";
import { mayMatchTags, tagQueryKey } from "../tag-query.js";
import { semanticCode } from "./diagnostics.js";
import { interpolatedTexts, literalText, unwrapParentheses } from "./expressions.js";
import type { SemanticScope } from "./scope.js";

// The targets of transfers and script references (V30 §29): labels, file paths, globs, and tagged picks.

/**
 * Why a `goto` or `call` cannot name a label of a file, or a `script(...)` reference one (V30 §29): a file starts at its
 * top. `keyword` is `null` for a reference, `path` the file a literal path names or `null` for a glob, and `label` is
 * `null` when computed.
 */
function fileLabelMessage(
  keyword: "goto" | "call" | null,
  label: string | null,
  path: string | null,
): string {
  const named = label === null ? "a label" : `label '${label}'`;
  const after = label === null ? "the label" : `'${label}'`;
  const transfer = keyword === "goto" ? "'goto'" : "call";
  if (keyword === null)
    return `A file is always entered at its top, so 'script(...)' takes no 'label:'. Put the part after ${after} in a file of its own and name that file in 'script(...)'.`;
  if (path === null)
    return `A ${transfer} starts the file it picks at its top, so it cannot go to ${named}. Put the part after ${after} in a file of its own and ${transfer} that file.`;
  return keyword === "call"
    ? `A call starts '${path}' at its top, so it cannot go to ${named}. Put the part after ${after} in a file of its own and call that file, or in a global function.`
    : `A 'goto' to '${path}' starts it at its top, so it cannot go to ${named}. Write 'goto "${path}"', or put the part after ${after} in a file of its own and 'goto' that file.`;
}

/**
 * Reports a missing file or label, and a target that a `goto` or `call` cannot have: a label after a file, a label
 * for a `call`, which starts another file at its top, or a label in a global function, which may run in any file
 * (V30 §11, §29). A label alone names one of this file.
 */
export function validateTransferTarget(
  validator: SemanticValidator,
  target: LabelTarget | FileTarget,
  transfer: "gotoStatement" | "callFileStatement",
): boolean {
  const path = validator.project.files[validator.file]!.path;
  if (target.kind === "labelTarget") {
    const label = target.label.name;
    const problem =
      transfer === "callFileStatement"
        ? `A call only starts a file, at its top, so 'call ${label}' cannot go to a label or function of this file. Write 'goto ${label}' to continue at a label, or '${label}()' to run a function.`
        : validator.globalFunction !== null
          ? `A global function can run in any file, so it cannot go to label '${label}' of '${path}'. Put the part after the label in a file of its own and 'goto' that file, or in a global function that does the work and returns.`
          : validator.labels.has(label)
            ? null
            : `This file has no label '${label}'. Add 'label ${label}' in the outer level of the file.`;
    if (problem === null) return true;
    validator.report(
      transfer === "callFileStatement" ? semanticCode.invalidFileTarget : semanticCode.invalidLabel,
      problem,
      target.label.span,
    );
    return false;
  }
  if (target.label !== null) {
    validator.report(
      semanticCode.invalidFileTarget,
      fileLabelMessage(
        transfer === "callFileStatement" ? "call" : "goto",
        target.label.name,
        isPathGlob(target.path) ? null : target.path,
      ),
      target.label.span,
    );
    return false;
  }
  if (isPathGlob(target.path)) return validateGlobTarget(validator, target);
  const problem = packagePathProblem(target.path);
  if (problem !== null) {
    validator.report(
      semanticCode.invalidFileTarget,
      `'${target.path}' is not a package file path: ${problem}.`,
      target.pathSpan,
    );
    return false;
  }
  if (!validator.project.labels.has(target.path)) {
    if (reportUnreadableFiles(validator, target.path, target.pathSpan)) return false;
    validator.report(
      semanticCode.invalidFileTarget,
      `The project has no file '${target.path}'. Paths start at the package root, such as "rooms/hall.tease".`,
      target.pathSpan,
    );
    return false;
  }
  if (transfer !== "callFileStatement" && validator.project.declarationsOnly.has(target.path)) {
    validator.report(
      semanticCode.invalidFileTarget,
      declarationsOnlyMessage(target.path),
      target.pathSpan,
    );
    return false;
  }
  return true;
}

/** A `script(...)` call whose path is literal text is checked like a file target; it takes no label (V30 §29). */
export function validateScriptReference(
  validator: SemanticValidator,
  call: Extract<Expression, { kind: "callExpression" }>,
): void {
  const label = call.arguments.find(
    (argument) => argument.kind === "namedArgument" && argument.name.name === "label",
  )?.value;
  const direct = validator.directTarget?.call === call ? validator.directTarget.statement : null;
  const transfer = direct?.kind ?? null;
  if (label !== undefined) {
    validator.report(
      semanticCode.invalidFileTarget,
      fileLabelMessage(null, literalText(label) ?? null, null),
      label.span,
    );
    return;
  }
  const positional = call.arguments.filter((argument) => argument.kind === "positionalArgument");
  // The type check reports another number of paths.
  if (positional.length !== 1) return;
  const pathArgument = positional[0]!.value;
  const path = literalText(pathArgument) ?? null;
  if (path === null) {
    // A text with `${...}` names the files its texts allow; any other path, any file.
    const texts = interpolatedTexts(pathArgument);
    validator.project.refer(texts === undefined ? null : validator.project.filesLike(texts));
    return;
  }
  validator.project.refer([path]);
  const pathProblem = packagePathProblem(path);
  if (
    !isPathGlob(path) &&
    pathProblem === null &&
    !validator.project.labels.has(path) &&
    reportUnreadableFiles(validator, path, pathArgument.span)
  )
    return;
  const problem = isPathGlob(path)
    ? `A glob cannot be inside script(...). To pick a random file, write ${transfer === "callFileStatement" ? "call" : "goto"} ${JSON.stringify(path)} directly.`
    : pathProblem !== null
      ? `'${path}' is not a package file path: ${pathProblem}.`
      : !validator.project.labels.has(path)
        ? `The project has no file '${path}'. Paths start at the package root, such as "rooms/hall.tease".`
        : transfer === "gotoStatement" && validator.project.declarationsOnly.has(path)
          ? declarationsOnlyMessage(path)
          : null;
  if (problem !== null) {
    validator.report(semanticCode.invalidFileTarget, problem, pathArgument.span);
    return;
  }
  if (direct?.kind === "callFileStatement")
    validator.fileCalls.set(direct, {
      form: "path",
      paths: [path],
      query: null,
      span: pathArgument.span,
    });
}

/**
 * A glob picks among the files it matches that run something; it is an error only when none remains (ADR 0022
 * §2.2).
 */
function validateGlobTarget(validator: SemanticValidator, target: FileTarget): boolean {
  const problem = packageGlobProblem(target.path);
  if (problem !== null) {
    validator.report(
      semanticCode.invalidFileTarget,
      `'${target.path}' is not a pattern of package file paths: ${problem}.`,
      target.pathSpan,
    );
    return false;
  }
  // A file the host could not load would be skipped silently.
  if (reportUnreadableFiles(validator, target.path, target.pathSpan)) return false;
  const matches = globMatches(target.path, validator.project.labels.keys());
  const runnable = matches.filter((path) => !validator.project.declarationsOnly.has(path));
  if (runnable.length > 0) {
    validator.picks.set(target, runnable);
    return true;
  }
  validator.report(
    semanticCode.invalidFileTarget,
    matches.length === 0
      ? `No file of the project matches '${target.path}'. Paths start at the package root, such as "rooms/*.tease".`
      : `Every file matching '${target.path}' holds declarations only and runs nothing, so there is nothing to pick.`,
    target.pathSpan,
  );
  return false;
}

/**
 * Reports each file or folder that the host could not load which `path`, written out, names, or may name a file in
 * (TSC011, #595), as a glob when `glob`, with the host's reason as the message. Returns whether it named one.
 */
export function reportUnreadableFiles(
  validator: SemanticValidator,
  path: string,
  span: SourceSpan,
  glob = isPathGlob(path),
): boolean {
  let named = false;
  for (const file of validator.project.unreadable) {
    if (!(glob ? globMayReach(path, file) : liesIn(path, file))) continue;
    named = true;
    validator.unreadableNamed.add(file.path);
    validator.report(semanticCode.unreadableFile, file.reason, span);
  }
  return named;
}

/**
 * The files a tagged pick may choose by the tags of their headers: those that run something, within its `from:`,
 * whose tags its tag tests, literal tag lists, and comparisons do not rule out. A comparison is false for a file
 * without a number for its tag, as when the script runs, and decided by a bound of constant numbers; another bound
 * or a computed list counts as possibly true here, and the check of the running file decides it by its known value
 * where it can. None when the tags are not known, or the `from:` is not a path or glob, which the type check
 * reports. Picks with the same facts share one list, found once.
 */
export function taggedCandidates(
  validator: SemanticValidator,
  query: TagQueryExpression,
): readonly string[] {
  const from = query.from?.pattern ?? null;
  const bound = (step: Extract<TagQueryStep, { kind: "tagCompare" }>) => {
    const value = staticNumber(step.bound);
    return value !== undefined && Number.isFinite(value) ? value : undefined;
  };
  const key = JSON.stringify([from, tagQueryKey(query.steps, bound)]);
  const known = validator.project.taggedPicks.get(key);
  if (known !== undefined) return known;
  const files = validator.project.files.filter((file) => validator.project.tags.has(file.path));
  const within =
    from === null
      ? new Set(files.map((file) => file.path))
      : (isPathGlob(from) ? packageGlobProblem(from) : packagePathProblem(from)) !== null
        ? new Set<string>()
        : new Set(
            globMatches(
              from,
              files.map((file) => file.path),
            ),
          );
  const mayMatch = mayMatchTags(query.steps, bound);
  const picks = files.flatMap((file) =>
    within.has(file.path) && mayMatch(validator.project.tags.get(file.path)!) ? [file.path] : [],
  );
  validator.project.taggedPicks.set(key, picks);
  return picks;
}

/**
 * The files that a computed target may name, for the checks that follow the plan: those listed, `null` for any file, or
 * `"project"` for those that any script reference of the project may name (`ProjectNames.referencedScripts`).
 */
export type TargetFiles = readonly string[] | null | "project";

/** Where the references of a value come from: files, any file, the project's references, and the `let`s it reads. */
interface ReferenceSources {
  readonly paths: Set<string>;
  any: boolean;
  project: boolean;
  readonly lets: LetStatement[];
}

/** The built-ins whose result holds only the references of their arguments: all of them but `script`. */
const PASSING_BUILTINS: ReadonlySet<string> = new Set(CORE_RUNTIME_BUILTINS);

/**
 * The files that the computed target `expression` of a `goto` or `call`, read in `scope`, may name (V30 §29), by where
 * its script references come from. Only `script(...)` and `findScripts(...)` make one: a `script(...)` names its file,
 * the files its text with `${...}` allows, or any file, and a `findScripts(...)` list the files it may list. A `load`
 * or a value of the host may hold a reference to any file. A list, set, dict, or object holds the references of its
 * parts, and an operator and a built-in function or method make none of their own, so their result holds those of what
 * they read; a variable whose `let` keeps its first value (see `SemanticValidator.writtenLets`) holds those of that
 * value. Anything else, such as a function's result, a parameter, a global, or a variable that code assigns, may hold
 * any reference of the project. `memo` keeps what each `let` gives, for the targets of one file.
 */
export function computedTargetFiles(
  validator: SemanticValidator,
  expression: Expression,
  scope: SemanticScope,
  memo: Map<LetStatement, TargetFiles>,
): TargetFiles {
  const sources = referenceSources(validator, expression, scope);
  // Each `let` once, after those its value reads; one that reads itself, which only code with errors does, counts as
  // any reference of the project.
  const work: { readonly site: LetStatement; sources: ReferenceSources | null }[] =
    sources.lets.map((site) => ({ site, sources: null }));
  const open = new Set<LetStatement>();
  while (work.length > 0) {
    const item = work.at(-1)!;
    if (memo.has(item.site)) {
      work.pop();
      continue;
    }
    if (item.sources === null) {
      open.add(item.site);
      const letScope = validator.letScopes.get(item.site);
      item.sources =
        letScope === undefined
          ? { paths: new Set(), any: false, project: true, lets: [] }
          : referenceSources(validator, item.site.initializer, letScope);
      for (const site of item.sources.lets)
        if (!memo.has(site) && !open.has(site)) work.push({ site, sources: null });
      continue;
    }
    work.pop();
    open.delete(item.site);
    memo.set(item.site, joinedFiles(item.sources, memo));
  }
  return joinedFiles(sources, memo);
}

/** The files of `sources`, with those of the `let`s it reads, which `memo` holds. */
function joinedFiles(
  sources: ReferenceSources,
  memo: ReadonlyMap<LetStatement, TargetFiles>,
): TargetFiles {
  let { any, project } = sources;
  const paths = new Set(sources.paths);
  for (const site of sources.lets) {
    const files = memo.get(site) ?? "project";
    if (files === null) any = true;
    else if (files === "project") project = true;
    else for (const path of files) paths.add(path);
  }
  return any ? null : project ? "project" : [...paths];
}

/** Where the references that the value of `expression`, read in `scope`, may hold come from (see `computedTargetFiles`). */
function referenceSources(
  validator: SemanticValidator,
  expression: Expression,
  scope: SemanticScope,
): ReferenceSources {
  const sources: ReferenceSources = { paths: new Set(), any: false, project: false, lets: [] };
  const add = (paths: readonly string[]): void => {
    for (const path of paths) sources.paths.add(path);
  };
  const pending = [expression];
  for (let node = pending.pop(); node !== undefined; node = pending.pop()) {
    switch (node.kind) {
      case "booleanLiteral":
      case "nullLiteral":
      case "numberLiteral":
      case "durationLiteral":
      case "unitExpression":
      case "angleExpression":
      case "stringLiteral":
      case "regexLiteral":
      case "rangeExpression":
      case "typeTestExpression":
        break;
      case "parenthesizedExpression":
        pending.push(node.expression);
        break;
      case "listLiteral":
      case "setLiteral":
        for (const element of node.elements) pending.push(element);
        break;
      case "objectLiteral":
        for (const property of node.properties) pending.push(property.value);
        break;
      case "dictLiteral":
        for (const entry of node.entries) pending.push(entry.key, entry.value);
        break;
      case "propertyAccessExpression":
        pending.push(node.object);
        break;
      case "indexExpression":
        pending.push(node.object, node.index);
        break;
      case "unaryExpression":
        pending.push(node.operand);
        break;
      case "binaryExpression":
        pending.push(node.left, node.right);
        break;
      case "tagQueryExpression":
        if (node.catalog === "scripts") add(taggedCandidates(validator, node));
        break;
      case "loadExpression":
        sources.any = true;
        break;
      case "identifier": {
        const binding = scope.lookup(node.name);
        if (binding?.kind === "global" && binding.project === undefined) sources.any = true;
        else if (binding?.site?.kind === "letStatement" && !validator.writtenLets.has(binding.site))
          sources.lets.push(binding.site);
        else sources.project = true;
        break;
      }
      case "callExpression": {
        const callee = unwrapParentheses(node.callee);
        if (callee.kind === "propertyAccessExpression") {
          // A method of a built-in value.
          pending.push(callee.object);
          for (const argument of node.arguments) pending.push(argument.value);
        } else if (callee.kind !== "identifier" || scope.lookup(callee.name) !== undefined)
          sources.project = true;
        else if (callee.name === "script") {
          const paths = node.arguments.filter((argument) => argument.kind === "positionalArgument");
          const path = paths.length === 1 ? literalText(paths[0]!.value) : undefined;
          const texts = paths.length === 1 ? interpolatedTexts(paths[0]!.value) : undefined;
          if (path !== undefined) add([path]);
          else if (texts !== undefined) add(validator.project.filesLike(texts));
          else sources.any = true;
        } else if (PASSING_BUILTINS.has(callee.name))
          for (const argument of node.arguments) pending.push(argument.value);
        else sources.project = true;
        break;
      }
      default:
        sources.project = true;
    }
  }
  return sources;
}
