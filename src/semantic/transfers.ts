import type {
  Expression,
  FileTarget,
  LabelTarget,
  TagQueryExpression,
  TagQueryStep,
} from "../ast.js";
import {
  declarationsOnlyMessage,
  globMatches,
  isPathGlob,
  packageGlobProblem,
  packagePathProblem,
} from "../project-paths.js";
import type { SemanticValidator } from "../semantic.js";
import { staticNumber } from "../static-evaluation.js";
import { mayMatchTags, tagQueryKey } from "../tag-query.js";
import { semanticCode } from "./diagnostics.js";
import { literalText, unwrapParentheses } from "./expressions.js";

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
    const written = unwrapParentheses(pathArgument);
    validator.project.refer(
      written.kind === "stringLiteral"
        ? validator.project.filesLike(
            written.parts.reduce<string[]>(
              (texts, part) => {
                if (part.kind === "stringText") texts[texts.length - 1] += part.value;
                else texts.push("");
                return texts;
              },
              [""],
            ),
          )
        : null,
    );
    return;
  }
  validator.project.refer([path]);
  const pathProblem = packagePathProblem(path);
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
