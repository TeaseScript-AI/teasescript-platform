// What the project's flow check reads of the checked files: the files a script names, computed transfer targets, the
// calls into each file, and constant tests.

import type { InteractionExpression, Statement, TagQueryExpression } from "../ast.js";
import { type InstructionPlan, type LoweringTrace } from "./compile-program.js";
import type { PreparedFormShape, StorageTypePlan, TypeCheckPlan, TypePlan } from "../plan/model.js";
import { instructionExpressions } from "../plan/instruction-expressions.js";
import { expressionPlanChildren } from "../plan/expression-children.js";
import {
  liesIn,
  MAIN_FILE_PATH,
  packagePathProblem,
  type UnreadablePackageFile,
} from "../project-paths.js";
import { knownReferenceFile, type ComputedTarget, type FileCall } from "../reachability.js";
import { type FileSemanticResult } from "../semantic.js";
import { unwrapParentheses } from "../semantic/expressions.js";
import { type SpeakerFlowInput } from "../speaker-flow.js";
import type {
  CoreRuntimeChecks,
  RuntimeCheckSite,
  TypeCheckResult,
} from "../type-inference/backend.js";
import { type WayFacts } from "../way-facts.js";
import { matchesTags } from "../tag-query.js";

/** What the checks of a project give the lowering and the checks that follow the plan. */
export interface CheckedProject {
  readonly typeChecks: ReadonlyMap<RuntimeCheckSite, TypeCheckPlan>;
  readonly coreChecks: CoreRuntimeChecks | null;
  readonly formShapes: ReadonlyMap<InteractionExpression, PreparedFormShape>;
  readonly storageTypes: readonly StorageTypePlan[];
  readonly speakerFlow: SpeakerFlowInput;
  readonly ways: WayFacts;
  readonly names: readonly FileSemanticResult[];
  readonly known: TypeCheckResult["known"];
}

/**
 * Of the files and folders the host could not load that no path or glob written out names, those that no code which can
 * run uses, so that they never run (TSV065, #595): a `.tease` file that no computed target which can run may start, as
 * `started` tells, `null` for any file, and a folder that no such target, nor a media or image file known only when the
 * script runs (`media`, `null` for any), may reach into. A media file that nothing names keeps its own warning, as no
 * check reports an image that nothing shows, and so does the folder that `main.tease` lies in.
 */
export function unusedUnreadable(
  unreadable: readonly UnreadablePackageFile[],
  started: ReadonlySet<string> | null,
  media: ReadonlySet<string> | null,
): ReadonlySet<UnreadablePackageFile> {
  return new Set(
    unreadable.filter((file) =>
      file.folder === true
        ? !liesIn(MAIN_FILE_PATH, file) &&
          started?.has(file.path) === false &&
          media?.has(file.path) === false
        : packagePathProblem(file.path) === null && started?.has(file.path) === false,
    ),
  );
}

/**
 * The files that a script reference may name where a computed target uses it, by index: those the project's
 * `script(...)` calls and `findScripts(...)` lists may name (see `FileSemanticResult.referencedScripts`). `null` for any
 * file: when one of them may name any file, when a `load` may give a reference, which an earlier session may have saved
 * for any file, or when the host gives values.
 */
export function referencedFiles(
  plan: InstructionPlan,
  names: readonly FileSemanticResult[],
  hostValues: boolean,
): readonly number[] | null {
  const referenced = names[0]?.referencedScripts ?? null;
  if (referenced === null || hostValues) return null;
  for (const instruction of plan.instructions)
    for (const root of instructionExpressions(instruction)) {
      const pending = [root];
      for (let node = pending.pop(); node !== undefined; node = pending.pop()) {
        if (node.kind === "storageLoad" && mayHoldScript(node.type)) return null;
        // One by one: an expression may have more children than a call takes arguments.
        for (const child of expressionPlanChildren(node)) pending.push(child);
      }
    }
  return plan.files.flatMap((file, index) => (referenced.has(file.path) ? [index] : []));
}

/**
 * Whether a loaded value of this type may hold a script reference: `null`, a type not known, may, and so may an object,
 * whose type checks only the properties it lists, so another property may hold anything.
 */
function mayHoldScript(type: TypePlan | null): boolean {
  // A worklist, so that a type nested as deep as its source allows does not deepen the native stack.
  const pending = [type];
  for (let part = pending.pop(); part !== undefined; part = pending.pop()) {
    if (part === null) return true;
    switch (part.kind) {
      case "script":
      case "object":
        return true;
      case "list":
      case "set":
      case "dict":
        pending.push(part.element);
        break;
      case "union":
        for (const member of part.members) pending.push(member);
        break;
    }
  }
  return false;
}

/**
 * Where each computed target of the plan may lead, by its transfer instruction (see `ComputedTarget`). A tagged pick may
 * start the files the name pass finds it may match, without those whose tags the known values of its bounds and tag
 * lists rule out (V30 §41), and each of them for certain when those values decide every one. Any other computed target
 * may start the files that its references may name (see `computedTargetFiles`), or those any reference of the project
 * may name, `referenced`. Targets that may start the same files share one list of them.
 */
export function computedTargets(
  plan: InstructionPlan,
  trace: LoweringTrace,
  checked: CheckedProject,
  referenced: () => readonly number[] | null,
): ReadonlyMap<number, ComputedTarget> {
  const indices = new Map(plan.files.map((file, index) => [file.path, index]));
  const lists = new Map<string, readonly number[]>();
  const shared = (files: readonly number[]): readonly number[] => {
    const key = files.join();
    const list = lists.get(key);
    if (list !== undefined) return list;
    lists.set(key, files);
    return files;
  };
  const tags: (ReadonlyMap<string, number | null> | undefined)[] = [];
  const tagsOf = (file: number): ReadonlyMap<string, number | null> =>
    (tags[file] ??= new Map((plan.files[file]!.tags ?? []).map((tag) => [tag.name, tag.value])));
  // By the name pass's list of files, then by what decides the matches.
  const picked = new Map<readonly string[], Map<string, ComputedTarget>>();
  const filesOf = new Map<readonly string[], readonly number[]>();
  const planFiles = (paths: readonly string[]): readonly number[] => {
    let files = filesOf.get(paths);
    if (files === undefined) {
      files = shared(
        paths
          .flatMap((path) => {
            const file = indices.get(path);
            return file === undefined ? [] : [file];
          })
          .sort((left, right) => left - right),
      );
      filesOf.set(paths, files);
    }
    return files;
  };
  const targets = new Map<number, ComputedTarget>();
  for (const result of checked.names) {
    for (const [statement, paths] of result.taggedPicks) {
      const index = transferOf(plan, trace, statement);
      const query = taggedQuery(statement);
      if (index === undefined || query === null) continue;
      const { key, matches } = matchesTags(query.steps, checked.known);
      const byFacts = picked.get(paths) ?? new Map<string, ComputedTarget>();
      picked.set(paths, byFacts);
      let target = byFacts.get(key);
      if (target === undefined) {
        const found = planFiles(paths).map((file) => [file, matches(tagsOf(file))] as const);
        target = {
          files: shared(found.flatMap(([file, match]) => (match === false ? [] : [file]))),
          certain: found.every(([, match]) => match !== null),
          tagged: true,
        };
        byFacts.set(key, target);
      }
      targets.set(index, target);
    }
    for (const [statement, paths] of result.targetFiles()) {
      const index = transferOf(plan, trace, statement);
      if (index === undefined) continue;
      targets.set(index, {
        files: paths === "project" ? referenced() : paths === null ? null : planFiles(paths),
        certain: false,
        tagged: false,
      });
    }
  }
  return targets;
}

/** The tagged pick that a `goto tagged` or `call tagged` statement names, or `null` for another statement. */
function taggedQuery(statement: Statement): TagQueryExpression | null {
  if (statement.kind !== "gotoStatement" && statement.kind !== "callFileStatement") return null;
  if (statement.target.kind !== "scriptTarget") return null;
  const target = unwrapParentheses(statement.target.expression);
  return target.kind === "tagQueryExpression" ? target : null;
}

/** The transfer instruction of a `goto` or `call` statement: it comes last, after its target's tag tests and lists. */
function transferOf(
  plan: InstructionPlan,
  trace: LoweringTrace,
  statement: Statement,
): number | undefined {
  const range = trace.statements.get(statement);
  if (range === undefined) return undefined;
  for (let index = range.end - 1; index >= range.start; index -= 1)
    if (plan.instructions[index]!.kind === "transfer") return index;
  return undefined;
}

/**
 * The `call`s of files by their transfer instruction, for the check of the running file (see
 * `Reachability.runningFileDiagnostics`). A file written out or a glob can start each file it names; a tagged pick each
 * file that the name pass finds it may match, as the known values of its bounds and tag lists decide (V30 §41); any
 * other computed target may start each file that its references may name (see `computedTargets`), which only the run
 * decides, unless they can name only one file: the target then names that file, as a path does.
 */
export function fileCalls(
  plan: InstructionPlan,
  trace: LoweringTrace,
  checked: CheckedProject,
  targets: () => ReadonlyMap<number, ComputedTarget>,
): ReadonlyMap<number, FileCall> {
  const calls = new Map<number, FileCall>();
  const indices = new Map(plan.files.map((file, index) => [file.path, index]));
  const shared = new Map<readonly string[], readonly number[]>();
  const tags: (ReadonlyMap<string, number | null> | undefined)[] = [];
  const tagsOf = (file: number): ReadonlyMap<string, number | null> =>
    (tags[file] ??= new Map((plan.files[file]!.tags ?? []).map((tag) => [tag.name, tag.value])));
  for (const result of checked.names)
    for (const [statement, target] of result.fileCalls) {
      const index = transferOf(plan, trace, statement);
      if (index === undefined) continue;
      let files: readonly number[] | null | undefined =
        target.paths === null ? (targets().get(index)?.files ?? null) : shared.get(target.paths);
      if (files === undefined) {
        files = target.paths!.flatMap((path) => {
          const file = indices.get(path);
          return file === undefined ? [] : [file];
        });
        shared.set(target.paths!, files);
      }
      const query = target.query;
      let matches: ((tags: ReadonlyMap<string, number | null>) => boolean | null) | undefined;
      // A reference that can name only one file names it, as a path does.
      const form =
        target.form === "computed" && knownReferenceFile(files) !== undefined
          ? "path"
          : target.form;
      calls.set(index, {
        form,
        files,
        starts:
          form === "computed"
            ? () => null
            : query === null
              ? () => true
              : (file) =>
                  (matches ??= matchesTags(query.steps, checked.known).matches)(tagsOf(file)),
        span: target.span,
      });
    }
  return calls;
}

/** What a TSV046 warning says its test always gives, by its words: `null` for a case that never matches or an empty range. */
export function constantTestValue(message: string): boolean | null {
  return message.endsWith("always true.") ? true : message.endsWith("always false.") ? false : null;
}
