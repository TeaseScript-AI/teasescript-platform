import { isRecord } from "./ast.ts";
import { emitTease } from "./emit-tease.ts";
import type { IrExpression, IrStatement, MigrationProgram } from "./ir.ts";
import { renameConflictingIdentifiers } from "./naming.ts";
import { expressionType, functionResultTypes, type TeaseType } from "./variable-types.ts";

type FunctionStatement = Extract<IrStatement, { kind: "function" }>;
type LetStatement = Extract<IrStatement, { kind: "let" }>;

/** Why a function that several scripts define stays in each of them. */
export interface KeptFunction {
  name: string;
  copies: number;
  reason: string;
}

/** What promoting shared functions to `global function` (#570) did to a package. */
export interface GlobalPromotion {
  /** The scripts with promoted functions removed and variants and clashing names renamed. */
  programs: MigrationProgram[];
  /** `helpers.tease`, with the global functions and globals, or null when nothing was promoted. */
  helpers: MigrationProgram | null;
  /** Names of the promoted functions, with the number of identical copies each replaced. */
  promoted: Array<{ name: string; copies: number }>;
  /** Globals declared for the file-level values promoted functions read, and how. */
  globals: Array<{ name: string; kind: "table" | "reassigned" }>;
  /** Functions several scripts define that stay file-local. */
  kept: KeptFunction[];
}

/** The generated list of a file's background sound handles (helpers.ts), which stays with its file. */
const BACKGROUND_SOUNDS = "sexscriptBackgroundSounds";

/** Methods that change a list or dict in place, so a table they reach is no constant. */
const MUTATING_METHODS = new Set([
  "add",
  "remove",
  "removeAt",
  "removeFirst",
  "removeLast",
  "clear",
  "sort",
  "shuffle",
  "insert",
]);

/**
 * Turns the functions that several scripts of a package define with the same converted body into `global function`s
 * in one generated `helpers.tease` (#570): a global function is callable from every file, so the copies go. It may read
 * only globals, its parameters, and its locals, and call only global functions and built-ins, so a file-level value it
 * reads becomes a `global`: a constant table nothing changes is declared once with its value, and any other value is
 * declared once and assigned again where each script declared it, so it starts from the script's own value as in
 * Groovy. A function whose file-level reads cannot become globals, or that calls a file-local function, stays in each
 * file; a same-named function with another body stays file-local and is renamed.
 */
export function promoteGlobalFunctions(
  scripts: readonly MigrationProgram[],
  root: string,
): GlobalPromotion {
  const occurrences = new Map<string, Array<{ script: number; statement: FunctionStatement }>>();
  scripts.forEach((program, script) => {
    for (const statement of program.statements) {
      if (statement.kind !== "function") continue;
      const list = occurrences.get(statement.name) ?? [];
      list.push({ script, statement });
      occurrences.set(statement.name, list);
    }
  });
  const text = (statement: FunctionStatement): string =>
    emitTease({ sourceName: "", metadata: null, statements: [statement], diagnostics: [] });
  const fileLets = scripts.map(
    (program) =>
      new Map(
        program.statements.flatMap((statement): Array<[string, LetStatement]> =>
          statement.kind === "let" ? [[statement.name, statement]] : [],
        ),
      ),
  );
  const fileFunctions = scripts.map(
    (program) =>
      new Set(
        program.statements.flatMap((statement) =>
          statement.kind === "function" ? [statement.name] : [],
        ),
      ),
  );

  // The body most scripts share, for each name that several scripts define.
  const candidates = new Map<
    string,
    { statement: FunctionStatement; scripts: number[]; copies: number }
  >();
  const kept: KeptFunction[] = [];
  for (const [name, list] of occurrences) {
    // A name one script declares twice is an error of its own (Toy's modules), not a shared function.
    const declaring = new Set(list.map(({ script }) => script));
    if (declaring.size < 2 || declaring.size < list.length) continue;
    const bodies = new Map<string, number[]>();
    for (const { script, statement } of list)
      bodies.set(text(statement), [...(bodies.get(text(statement)) ?? []), script]);
    const [body, users] = [...bodies].sort((left, right) => right[1].length - left[1].length)[0]!;
    if (users.length < 2) {
      kept.push({ name, copies: list.length, reason: "every script has its own body" });
      continue;
    }
    const statement = list.find(({ statement: item }) => text(item) === body)!.statement;
    candidates.set(name, { statement, scripts: users, copies: list.length });
  }

  // A candidate stays file-local when it calls a file-local function or reads a file-level value that cannot become a
  // global; dropping one can drop the candidates that call it, so the check repeats until nothing changes.
  const reads = new Map(
    [...candidates].map(([name, { statement }]) => [name, freeNames(statement)]),
  );
  const tableValues = new Map<string, LetStatement>();
  const reassigned = new Map<string, LetStatement>();
  for (let changed = true; changed;) {
    changed = false;
    tableValues.clear();
    reassigned.clear();
    for (const [name, candidate] of candidates) {
      const free = reads.get(name)!;
      const reason = blocker(name, candidate.scripts, free);
      if (reason === null) continue;
      candidates.delete(name);
      kept.push({ name, copies: candidate.copies, reason });
      changed = true;
    }
  }

  function blocker(name: string, users: number[], free: FreeNames): string | null {
    for (const called of free.calls) {
      if (called === name) continue;
      const shared = candidates.get(called);
      // Each script's copy called the script's own function of that name, so all of them must share its body.
      if (
        shared !== undefined &&
        users.some(
          (script) => fileFunctions[script]!.has(called) && !shared.scripts.includes(script),
        )
      )
        return `calls ${called}, which some of these scripts define with another body`;
      if (shared !== undefined) continue;
      if (users.some((script) => fileFunctions[script]!.has(called)))
        return `calls ${called}, which stays in each file`;
    }
    for (const variable of free.variables) {
      if (variable === BACKGROUND_SOUNDS)
        return `reads ${variable}, the handles of the file's background sounds, which the legacy player stopped when each script ended`;
      const declarations = users.map((script) => fileLets[script]!.get(variable));
      if (declarations.some((declaration) => declaration === undefined))
        return `reads ${variable}, which not every script that uses it declares at its top level`;
      const types = new Set(declarations.map((declaration) => declaration!.type ?? ""));
      if (types.size > 1)
        return `reads ${variable}, which the scripts declare with different types`;
      const everywhere = scripts.flatMap((_, script) => {
        const declaration = fileLets[script]!.get(variable);
        return declaration === undefined ? [] : [declaration];
      });
      if (everywhere.some((declaration) => (declaration.type ?? "") !== [...types][0]))
        return `reads ${variable}, which another script declares with another type`;
      const first = declarations[0]!;
      if (
        constantValue(first.value) &&
        everywhere.every((declaration) => sameValue(declaration.value, first.value)) &&
        !scripts.some((program) => changes(program.statements, variable))
      )
        tableValues.set(variable, first);
      else reassigned.set(variable, first);
    }
    return null;
  }

  // The type of a file-level value, from literals and the results of the scripts' functions.
  let results: ReadonlyMap<string, TeaseType> | undefined;
  const valueType = (value: IrExpression): TeaseType => {
    results ??= functionResultTypes(scripts.flatMap((program) => program.statements));
    return expressionType(
      value,
      () => ({ kind: "unknown" }),
      (name) => results?.get(name),
    );
  };
  if (candidates.size === 0)
    return { programs: [...scripts], helpers: null, promoted: [], globals: [], kept };
  const promotedNames = new Set(candidates.keys());
  const globalNames = new Set([...tableValues.keys(), ...reassigned.keys()]);
  const project = new Set([...promotedNames, ...globalNames]);

  const programs = scripts.map((program, script) => {
    const statements = program.statements.flatMap((statement): IrStatement[] => {
      if (statement.kind === "function") {
        const candidate = candidates.get(statement.name);
        // The shared body goes to helpers.tease; a variant keeps its body under another name.
        if (candidate !== undefined && candidate.scripts.includes(script)) return [];
        return [statement];
      }
      if (statement.kind === "let" && tableValues.has(statement.name)) return [];
      if (statement.kind === "let" && reassigned.has(statement.name)) {
        // The global starts from the script's own value where the script declared it, as Groovy's variable did.
        return [
          {
            kind: "comment",
            text: `// ${statement.name} is a global of helpers.tease; this script starts it with its own value.`,
            trailing: false,
            span: null,
          },
          {
            kind: "assign",
            target: { kind: "variable", name: statement.name },
            operator: "=",
            value: statement.value,
            span: statement.span,
          },
        ];
      }
      return [statement];
    });
    return renameConflictingIdentifiers({ ...program, statements }, new Set(), false, project);
  });

  const globals: IrStatement[] = [
    ...[...tableValues.values()].map((declaration): IrStatement => ({
      ...declaration,
      global: true,
      span: null,
    })),
    ...[...reassigned.values()].map((declaration): IrStatement => ({
      kind: "let",
      name: declaration.name,
      value: constantValue(declaration.value)
        ? declaration.value
        : startValue(declaration.type, valueType(declaration.value)),
      ...(declaration.type === undefined ? {} : { type: declaration.type }),
      global: true,
      span: null,
    })),
  ];
  const helpers: MigrationProgram = {
    sourceName: `${root}/helpers.tease`,
    metadata: null,
    statements: [
      {
        kind: "comment",
        text: "// Functions and values the package's scripts share (#570). Nothing transfers to this file.",
        trailing: false,
        span: null,
      },
      ...globals,
      ...[...candidates.values()].map(({ statement }): IrStatement => ({
        ...statement,
        global: true,
      })),
      { kind: "exit", span: null },
    ],
    diagnostics: [],
  };
  return {
    programs,
    helpers,
    promoted: [...candidates].map(([name, candidate]) => ({
      name,
      copies: candidate.scripts.length,
    })),
    globals: [
      ...[...tableValues.keys()].map((name) => ({ name, kind: "table" as const })),
      ...[...reassigned.keys()].map((name) => ({ name, kind: "reassigned" as const })),
    ],
    kept,
  };
}

interface FreeNames {
  /** Variables the function reads or writes that are not its parameters or locals. */
  variables: Set<string>;
  /** Names the function calls. */
  calls: Set<string>;
}

/** The variables a function uses that it does not declare, and the names it calls. */
function freeNames(statement: FunctionStatement): FreeNames {
  const declared = new Set(statement.parameters.map((parameter) => parameter.name));
  const variables = new Set<string>();
  const calls = new Set<string>();
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    if (!isRecord(value)) return;
    if (value.kind === "let" && typeof value.name === "string") declared.add(value.name);
    if (value.kind === "for" && typeof value.variable === "string") declared.add(value.variable);
    if (value.kind === "variable" && typeof value.name === "string") variables.add(value.name);
    if (value.kind === "call" && typeof value.name === "string") calls.add(value.name);
    for (const child of Object.values(value)) visit(child);
  };
  visit(statement.parameters.map((parameter) => parameter.defaultValue));
  visit(statement.body);
  return { variables: new Set([...variables].filter((name) => !declared.has(name))), calls };
}

/** The value a global of this annotation starts with before a script assigns it: its type's empty value, or null. */
function startValue(type: string | undefined, inferred: TeaseType): IrExpression {
  if (type === undefined) {
    // An empty list takes its element type from the first one assigned (ADR 0021 rule 1.3).
    if (inferred.kind === "list") return { kind: "list", items: [] };
    if (inferred.kind === "scalar" && inferred.name === "string")
      return { kind: "literal", value: "" };
    if (inferred.kind === "scalar" && inferred.name === "boolean")
      return { kind: "literal", value: false };
    if (inferred.kind === "scalar" && (inferred.name === "integer" || inferred.name === "number"))
      return { kind: "literal", value: 0 };
    return { kind: "literal", value: null };
  }
  if (type.endsWith("?")) return { kind: "literal", value: null };
  if (type.endsWith("[]")) return { kind: "list", items: [] };
  if (type === "string") return { kind: "literal", value: "" };
  if (type === "boolean") return { kind: "literal", value: false };
  return { kind: "literal", value: 0 };
}

/** Whether a value is made of literals only, so it can initialize a global (ADR 0022 §6.4). */
function constantValue(value: IrExpression): boolean {
  switch (value.kind) {
    case "literal":
    case "duration":
      return true;
    case "list":
      return value.items.every(constantValue);
    case "object":
      return value.properties.every(
        (property) => property.key === undefined && constantValue(property.value),
      );
    case "template":
      return value.parts.every((part) => "text" in part);
    default:
      return false;
  }
}

function sameValue(left: IrExpression, right: IrExpression): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

/** Whether any statement assigns the variable, one of its elements or properties, or changes it in place. */
function changes(statements: readonly IrStatement[], name: string): boolean {
  let found = false;
  const base = (target: IrExpression): string | null =>
    target.kind === "variable"
      ? target.name
      : target.kind === "index" || target.kind === "property"
        ? base(target.target)
        : null;
  const visit = (value: unknown, topLevel: boolean): void => {
    if (found) return;
    if (Array.isArray(value)) {
      for (const item of value) visit(item, topLevel);
      return;
    }
    if (!isRecord(value)) return;
    // The declaration itself is no change.
    if (value.kind === "let" && value.name === name && topLevel) return;
    if (value.kind === "assign" && isRecord(value.target)) {
      const target: unknown = value.target;
      if (isIrExpression(target) && base(target) === name) found = true;
    }
    if (
      value.kind === "methodCall" &&
      typeof value.name === "string" &&
      MUTATING_METHODS.has(value.name) &&
      isRecord(value.target)
    ) {
      const target: unknown = value.target;
      if (isIrExpression(target) && base(target) === name) found = true;
    }
    for (const child of Object.values(value)) visit(child, false);
  };
  for (const statement of statements) visit(statement, true);
  return found;
}

function isIrExpression(value: unknown): value is IrExpression {
  return isRecord(value) && typeof value.kind === "string";
}
